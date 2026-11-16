import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { connectSocks, requestOnce } from "./network.mjs";

const exec = promisify(execFile);
const server = fileURLToPath(new URL("./server.mjs", import.meta.url));
const windows = process.platform === "win32";

async function listen(port, handle = (socket) => socket.destroy()) {
  const listener = net.createServer(handle);
  listener.listen(port, "127.0.0.1");
  await once(listener, "listening");
  return listener;
}

async function fixture(t, { isolatedInstall = false } = {}) {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "tor-web-test-"));
  let entry = server;
  if (isolatedInstall) {
    const directory = path.join(data, "install");
    await fs.mkdir(directory);
    for (const file of ["server.mjs", "runtime.mjs", "network.mjs", "duckduckgo.mjs"]) {
      await fs.copyFile(path.join(path.dirname(server), file), path.join(directory, file));
    }
    entry = path.join(directory, "server.mjs");
  }
  let sockets = [];
  let base;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      sockets = [];
      sockets.push(await listen(0));
      base = sockets[0].address().port;
      if (base > 65533) throw new Error("no room for consecutive ports");
      sockets.push(await listen(base + 1));
      sockets.push(await listen(base + 2));
      break;
    } catch (error) {
      await Promise.all(sockets.map((socket) => new Promise((resolve) => socket.close(resolve))));
      if (attempt === 9) throw error;
    }
  }
  const env = {
    ...process.env,
    TOR_WEB_DATA_DIR: data,
    TOR_WEB_SOCKS_PORT: String(base),
    TOR_WEB_TOR_DIR: path.join(data, "missing-tor"),
  };
  const cli = (...args) => exec(process.execPath, [entry, ...args], { env, timeout: 7000, windowsHide: true });
  t.after(async () => {
    if (isolatedInstall) await fs.writeFile(path.join(data, "proceed"), "");
    await cli("--off").catch(() => {});
    await Promise.all(sockets.map((socket) => new Promise((resolve) => socket.close(resolve))));
    await fs.rm(data, { recursive: true, force: true });
  });
  return {
    base, cli, sockets, env, entry, data,
    release: (index) => new Promise((resolve) => sockets[index].close(resolve)),
    status: async () => JSON.parse((await cli("--status", "--json")).stdout),
  };
}

test("status and off leave an unrelated listener alone", { skip: !windows }, async (t) => {
  const { base, cli, sockets, status } = await fixture(t);
  assert.deepEqual(await status(), { running: false, torReady: false, frontPort: base + 1 });
  await cli("--off");
  assert(sockets.every((socket) => socket.listening));
});

test("standby fails when a configured port is already occupied", { skip: !windows }, async (t) => {
  const { cli, release, sockets } = await fixture(t);
  await release(0);
  await release(2);
  await assert.rejects(cli("--standby"), /in use/i);
  assert(sockets[1].listening);
});

test("concurrent standby calls share a single runtime and off releases the front listener", { skip: !windows }, async (t) => {
  const { base, cli, release, status } = await fixture(t);
  await Promise.all([0, 1, 2].map(release));
  await Promise.all(Array.from({ length: 5 }, () => cli("--standby")));
  const running = await status();
  assert.equal(running.running, true);
  assert.equal(running.torReady, false);
  assert.equal(running.frontPort, base + 1);
  await assert.rejects(cli("--check-revert", "stale"), { code: 3 });
  assert.equal((await status()).runtimePid, running.runtimePid);
  await assert.rejects(cli("--on"), /tor\.exe not found/i);
  await cli("--off");
  assert.equal((await status()).running, false);
  const front = await listen(base + 1);
  await new Promise((resolve) => front.close(resolve));
});

test("independent MCP clients share the front runtime with no Tor startup at initialization", { skip: !windows }, async (t) => {
  const { base, env, release, status } = await fixture(t);
  await Promise.all([0, 1, 2].map(release));
  const clients = [0, 1].map(() => spawn(process.execPath, [server], { env, windowsHide: true }));
  const exits = clients.map((client) => once(client, "exit"));
  t.after(async () => {
    clients.forEach((client) => client.kill());
    await Promise.all(exits);
  });

  await Promise.all(clients.map(async (client) => {
    const lines = createInterface({ input: client.stdout });
    const pending = once(lines, "line");
    client.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
    const [message] = await pending;
    assert.equal(JSON.parse(message).result.serverInfo.name, "tor-web");
    lines.close();
  }));
  const running = await status();
  assert.equal(running.sessions, 2);
  assert.equal(running.torReady, false);
  const probe = net.connect(base + 1, "127.0.0.1");
  await once(probe, "connect");
  probe.destroy();

  clients[0].stdin.end();
  await exits[0];
  const remaining = await status();
  assert.equal(remaining.sessions, 1);
  assert.equal(remaining.runtimePid, running.runtimePid);
});

async function mcpClient(t, entry, env) {
  const child = spawn(process.execPath, [entry], { env, windowsHide: true });
  const exit = once(child, "exit");
  t.after(async () => { child.kill(); await exit; });
  const lines = createInterface({ input: child.stdout });
  const first = once(lines, "line");
  child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
  const [message] = await first;
  lines.close();
  assert.equal(JSON.parse(message).result.serverInfo.name, "tor-web");
  return { child, exit };
}

async function waitForFile(file) {
  const deadline = Date.now() + 6000;
  do {
    try { return await fs.readFile(file, "utf8"); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(40);
  } while (Date.now() < deadline);
  throw new Error(`timed out waiting for ${file}`);
}

test("a reconnect invalidates an already queued per-session revert", { skip: !windows, timeout: 14000 }, async (t) => {
  const { data, entry, env, release, status } = await fixture(t, { isolatedInstall: true });
  await Promise.all([0, 1, 2].map(release));
  await fs.writeFile(path.join(data, "settings.json"), '{"default":"off"}');
  await fs.writeFile(path.join(path.dirname(entry), "tor-web.ps1"), `
param($Command, $RevertToken)
$data = $env:TOR_WEB_DATA_DIR
[IO.File]::WriteAllText((Join-Path $data 'started'), $Command)
$limit = [DateTime]::UtcNow.AddSeconds(8)
while (-not [IO.File]::Exists((Join-Path $data 'proceed'))) {
    if ([DateTime]::UtcNow -ge $limit) { exit 3 }
    Start-Sleep -Milliseconds 40
}
& node (Join-Path $PSScriptRoot 'server.mjs') --check-revert $RevertToken
$result = $LASTEXITCODE
[IO.File]::WriteAllText((Join-Path $data 'result'), [string]$result)
exit $result
`);
  const first = await mcpClient(t, entry, env);
  first.child.stdin.end();
  await first.exit;
  const started = await waitForFile(path.join(data, "started")).catch(async (error) => {
    throw new Error(`${error.message} (${JSON.stringify(await status())})`);
  });
  assert.equal(started, "revert");
  await mcpClient(t, entry, env);
  await fs.writeFile(path.join(data, "proceed"), "");
  assert.equal(await waitForFile(path.join(data, "result")), "3");
  assert.equal((await status()).sessions, 1);
});

async function socksFixture(t, handle) {
  const clients = new Set();
  const server = await listen(0, (socket) => {
    clients.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => clients.delete(socket));
    handle(socket);
  });
  t.after(() => {
    clients.forEach((socket) => socket.destroy());
    return new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}

function fakeSocks(socket, onConnected) {
  socket.once("data", (greeting) => {
    assert.deepEqual(greeting, Buffer.from([5, 1, 0]));
    socket.write(Buffer.from([5, 0]));
    socket.once("data", (request) => {
      assert.deepEqual(request.subarray(0, 4), Buffer.from([5, 1, 0, 3]));
      const length = request[4];
      const destination = { host: request.subarray(5, 5 + length).toString(), port: request.readUInt16BE(5 + length) };
      socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
      onConnected(destination);
    });
  });
}

test("HTTP fetch passes the hostname through SOCKS without a local DNS lookup", async (t) => {
  const socksPort = await socksFixture(t, (socket) => fakeSocks(socket, (destination) => {
    assert.deepEqual(destination, { host: "runtime-test.invalid", port: 8080 });
    socket.once("data", (request) => {
      assert.match(request.toString(), /^GET \/test HTTP\/1.1\r\n/);
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 13\r\nConnection: close\r\n\r\nLocal fixture");
    });
  }));
  const response = await requestOnce("http://runtime-test.invalid:8080/test", {}, { socksPort, userAgent: "runtime test" });
  assert.equal(response.status, 200);
  assert.equal(response.body.toString(), "Local fixture");
});

test("SOCKS rejects an early close and bounds a stalled greeting", async (t) => {
  const closed = await socksFixture(t, (socket) => socket.destroy());
  await assert.rejects(connectSocks(closed, "runtime-test.invalid", 80, { timeout: 250 }), /closed|reset/i);
  const stalled = await socksFixture(t, () => {});
  await assert.rejects(connectSocks(stalled, "runtime-test.invalid", 80, { timeout: 30 }), /handshake timed out/);
});

test("request setup rejects an early TLS close and a partial HTTP response", async (t) => {
  const socksPort = await socksFixture(t, (socket) => fakeSocks(socket, ({ port }) => {
    socket.once("data", () => {
      if (port === 443) socket.end();
      else socket.end("HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nIncomplete");
    });
  }));
  const options = { socksPort, userAgent: "runtime test" };
  await assert.rejects(requestOnce("https://runtime-test.invalid/", {}, options), /TLS|closed|reset/i);
  await assert.rejects(requestOnce("http://runtime-test.invalid/", {}, options), /aborted|close/i);
});
