import { fork, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LOOPBACK } from "./network.mjs";

const WINDOWS = process.platform === "win32";
const BOOT_TIMEOUT = 120000;
const TOOL_TIMEOUT = 220000;
const CONNECTION_TIMEOUT = 5000;
const SESSION_GRACE = 3000;
const POWERSHELL = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

function pipeName(name) {
  return WINDOWS ? `\\\\.\\pipe\\tor-web-${name}` : path.join(os.tmpdir(), `tor-web-${name}.sock`);
}

function canonicalPath(file) {
  try { return fs.realpathSync(file); }
  catch (error) {
    const parent = path.dirname(file);
    if (error.code !== "ENOENT" || parent === file) throw error;
    return path.join(canonicalPath(parent), path.basename(file));
  }
}

function keyFor(value) {
  return createHash("sha256").update(WINDOWS ? value.toLowerCase() : value).digest("hex").slice(0, 24);
}

export function configuration(here) {
  const socksPort = Number(process.env.TOR_WEB_SOCKS_PORT || 9062);
  if (!Number.isInteger(socksPort) || socksPort < 1 || socksPort > 65533) throw new Error("invalid TOR_WEB_SOCKS_PORT");
  const idleMs = Number(process.env.TOR_WEB_IDLE_MINUTES || 10) * 60000;
  if (!Number.isFinite(idleMs) || idleMs <= 0 || idleMs > 2147483647) throw new Error("invalid TOR_WEB_IDLE_MINUTES");
  const data = canonicalPath(path.resolve(process.env.TOR_WEB_DATA_DIR || path.join(here, "data")));
  const torDir = path.resolve(process.env.TOR_WEB_TOR_DIR || path.join(os.homedir(), "Desktop", "Tor Browser", "Browser", "TorBrowser", "Tor"));
  const key = keyFor([fs.realpathSync(here), data, os.homedir()].join("\n"));
  return {
    here, data, torDir, socksPort, frontPort: socksPort + 1, tunnelPort: socksPort + 2, idleMs, key,
    state: path.join(data, "runtime.json"), lock: pipeName(`${keyFor(data)}-lock`),
  };
}

function readFrames(socket, limit, receive) {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      if (end > limit) return socket.destroy();
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try { receive(JSON.parse(frame)); } catch { return socket.destroy(); }
    }
    if (buffer.length > limit) socket.destroy();
  });
}

class RuntimeClient {
  constructor(socket) {
    this.socket = socket;
    this.waiting = new Map();
    this.nextId = 0;
    socket.on("error", () => {});
    socket.once("close", () => {
      for (const { reject } of this.waiting.values()) reject(new Error("Tor runtime connection closed"));
    });
    readFrames(socket, 50e6, (message) => {
      const entry = this.waiting.get(message.id);
      if (entry) message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.result);
    });
  }

  async request(command, args) {
    if (this.socket.destroyed) throw new Error("Tor runtime connection closed");
    const id = ++this.nextId;
    const timeout = command === "on" ? BOOT_TIMEOUT + 15000 : command === "tool" ? TOOL_TIMEOUT + CONNECTION_TIMEOUT : CONNECTION_TIMEOUT;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        this.waiting.set(id, { resolve, reject });
        timer = setTimeout(() => reject(new Error(`Tor runtime ${command} timed out`)), timeout);
        this.socket.write(JSON.stringify({ id, command, args }) + "\n");
      });
    } finally {
      clearTimeout(timer);
      this.waiting.delete(id);
    }
  }

  close() {
    this.socket.destroy();
  }
}

async function connectRuntime(config) {
  let state;
  try { state = JSON.parse(fs.readFileSync(config.state, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (state.key !== config.key || !/^[a-f0-9]{48}$/.test(state.nonce)) {
    throw new Error(`runtime state does not match this installation: ${config.state}`);
  }

  // The random pipe name is stored only in the installation's per-user data directory.
  // The predictable pipe is for election only and never accepts control commands.
  const socket = net.connect(pipeName(state.nonce));
  const timer = setTimeout(() => socket.destroy(new Error("Tor runtime connection timed out")), CONNECTION_TIMEOUT);
  try {
    await once(socket, "connect");
    return new RuntimeClient(socket);
  } catch (error) {
    socket.destroy();
    if (["ENOENT", "ECONNREFUSED"].includes(error.code)) return null;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function launchRuntime(script) {
  const env = { ...process.env };
  delete env.NODE_PENDING_PIPE_INSTANCES;
  const child = fork(script, ["--runtime"], { env, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true, execArgv: [] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("Tor runtime startup timed out"));
    }, CONNECTION_TIMEOUT);
    const exited = (code) => finish(new Error(`Tor runtime exited during startup (${code})`));

    function finish(error, result) {
      clearTimeout(timer);
      child.removeListener("exit", exited);
      if (child.connected) child.disconnect();
      child.unref();
      if (error) reject(error);
      else resolve(result);
    }

    child.once("error", finish);
    child.once("exit", exited);
    child.once("message", (message) => finish(message.error ? new Error(message.error) : null, message));
  });
}

export async function openRuntime(config, { script, start = false } = {}) {
  let client = await connectRuntime(config);
  if (client || !start) return { client, created: false };
  const result = await launchRuntime(script);
  const deadline = Date.now() + CONNECTION_TIMEOUT;
  do {
    client = await connectRuntime(config);
    if (client) return { client, created: result.created === true };
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error("the Tor runtime could not acquire its control pipe");
}

async function listen(server, address) {
  const ready = once(server, "listening");
  server.listen(address);
  await ready;
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function checkPorts(ports) {
  const probes = [];
  try {
    for (const port of ports) {
      const probe = net.createServer((socket) => socket.destroy());
      probes.push(probe);
      try { await listen(probe, { port, host: LOOPBACK }); }
      catch (error) {
        if (error.code === "EADDRINUSE") throw new Error(`port ${port} is already in use`);
        throw error;
      }
    }
  } finally {
    await Promise.all(probes.map(closeServer));
  }
}

function portReady(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, LOOPBACK);
    const timer = setTimeout(() => done(false), 1000);
    function done(open) {
      clearTimeout(timer);
      socket.destroy();
      resolve(open);
    }
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function response(socket, id, result, error) {
  if (socket.destroyed) return;
  return new Promise((resolve) => socket.write(JSON.stringify({ id, result, error }) + "\n", resolve));
}

function logDestination(data, first) {
  if (process.env.TOR_WEB_LOG_HOSTS !== "1") return;
  const [method, target] = first.toString("latin1", 0, 1024).split(/\s/, 2);
  try {
    const { host } = new URL(method === "CONNECT" ? `http://${target}` : target);
    if (host) fs.appendFile(path.join(data, "proxy.log"), `${new Date().toISOString()} ${host}\n`, { mode: 0o600 }, () => {});
  } catch {}
}

export async function runRuntime(config, callTool) {
  let tor;
  let starting;
  let active = 0;
  let manual = false;
  let stopped = false;
  let idleTimer;
  let sessionTimer;
  let generation = 0;
  let reverting;
  let revertError;
  let owner;
  let published = false;
  const nonce = randomBytes(24).toString("hex");
  const controls = new Set();
  const clients = new Set();
  const proxySockets = new Set();
  const election = net.createServer((socket) => socket.destroy());
  const front = net.createServer(proxyConnection);
  const control = net.createServer(controlConnection);

  try {
    try { await listen(election, config.lock); }
    catch (error) {
      if (error.code === "EADDRINUSE") return process.send?.({ created: false });
      throw error;
    }
    await checkPorts([config.socksPort, config.tunnelPort]);
    try { await listen(front, { port: config.frontPort, host: LOOPBACK }); }
    catch (error) {
      if (error.code === "EADDRINUSE") throw new Error(`front proxy port ${config.frontPort} is already in use`);
      throw error;
    }
    await listen(control, pipeName(nonce));
    fs.mkdirSync(config.data, { recursive: true, mode: 0o700 });
    const temp = path.join(config.data, `runtime-${nonce}.tmp`);
    try {
      fs.writeFileSync(temp, JSON.stringify({ key: config.key, nonce }), { mode: 0o600, flag: "wx" });
      fs.renameSync(temp, config.state);
      published = true;
    } finally {
      fs.rmSync(temp, { force: true });
    }
    for (const server of [election, front, control]) server.on("error", () => { void shutdown(); });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => { void shutdown(); });
    process.send?.({ created: true });
  } catch (error) {
    process.send?.({ error: error.message });
    await shutdown();
    if (!process.send) throw error;
  }

  function scheduleIdle() {
    clearTimeout(idleTimer);
    if (tor?.ready && !manual && !active) idleTimer = setTimeout(() => { void stopTor(); }, config.idleMs);
  }

  function beginActivity() {
    active++;
    clearTimeout(idleTimer);
    return () => { active--; scheduleIdle(); };
  }

  async function stopTor() {
    clearTimeout(idleTimer);
    manual = false;
    const current = tor;
    if (!current) return;
    current.ready = false;
    current.cancel.abort(new Error("Tor was stopped"));
    current.child.kill();
    await current.exited;
  }

  async function shutdown(reply) {
    if (stopped) return;
    stopped = true;
    clearTimeout(sessionTimer);
    owner?.child.kill();
    owner = null;
    const frontClosed = closeServer(front);
    for (const socket of proxySockets) socket.destroy();
    await stopTor();
    const controlClosed = closeServer(control);
    if (published) fs.rmSync(config.state, { force: true });
    await Promise.all([frontClosed, closeServer(election)]);
    if (reply) await response(reply.socket, reply.id, status());
    for (const socket of controls) socket.destroy();
    await controlClosed;
  }

  function ensureTor() {
    if (stopped) throw new Error("Tor runtime is stopping");
    if (tor?.ready) return Promise.resolve(tor);
    starting ??= startTor().finally(() => { starting = null; });
    return starting;
  }

  async function startTor() {
    if (tor) await tor.exited;
    await checkPorts([config.socksPort, config.tunnelPort]);
    if (stopped) throw new Error("Tor runtime is stopping");
    const exe = path.join(config.torDir, "tor.exe");
    if (!fs.existsSync(exe)) throw new Error(`tor.exe not found at ${exe} (set TOR_WEB_TOR_DIR)`);
    const directory = path.join(config.data, "tor");
    const emptyConfig = path.join(config.data, "empty.torrc");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(emptyConfig, "", { mode: 0o600 });
    const child = spawn(exe, [
      "-f", emptyConfig, "--defaults-torrc", emptyConfig,
      "--SocksPort", `${LOOPBACK}:${config.socksPort} IsolateDestAddr`,
      "--HTTPTunnelPort", `${LOOPBACK}:${config.tunnelPort} IsolateDestAddr`,
      "--DataDirectory", directory,
      "--GeoIPFile", path.join(config.torDir, "geoip"),
      "--GeoIPv6File", path.join(config.torDir, "geoip6"),
      "--Log", "notice stdout", "--__OwningControllerProcess", String(process.pid),
    ], { cwd: config.torDir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const current = tor = { child, ready: false, cancel: new AbortController() };
    function exited(code) {
      current.ready = false;
      if (tor === current) manual = false;
      current.cancel.abort(new Error(`managed Tor exited (${code ?? "signal"})`));
      for (const socket of proxySockets) {
        if (socket.tor === current) socket.destroy();
      }
    }
    child.once("exit", exited);
    current.exited = new Promise((resolve) => child.once("close", (code) => {
      if (!current.cancel.signal.aborted) exited(code);
      if (tor === current) tor = null;
      resolve();
    }));
    const recent = [];
    let bootstrap;
    let failed;
    const ready = new Promise((resolve, reject) => { bootstrap = resolve; failed = reject; });
    const timeout = setTimeout(() => failed(new Error(`Tor did not bootstrap within ${BOOT_TIMEOUT / 1000}s`)), BOOT_TIMEOUT);
    const abort = () => failed(current.cancel.signal.reason);
    child.once("error", failed);
    current.cancel.signal.addEventListener("abort", abort, { once: true });
    for (const stream of [child.stdout, child.stderr]) {
      let buffer = "";
      stream.setEncoding("utf8").on("data", (chunk) => {
        if (current.ready) return;
        const lines = (buffer + chunk).split(/\r?\n/);
        buffer = lines.pop().slice(-4096);
        for (const line of lines) {
          if (line.includes("Bootstrapped 100%")) bootstrap();
          else if (/\[(warn|err)\]/.test(line)) {
            recent.push(line.slice(0, 500));
            if (recent.length > 4) recent.shift();
          }
        }
      });
    }
    try {
      await ready;
      const ports = await Promise.all([config.socksPort, config.tunnelPort].map(portReady));
      current.cancel.signal.throwIfAborted();
      if (!ports.every(Boolean)) throw new Error("managed Tor listeners did not become ready");
      current.ready = true;
      return current;
    } catch (error) {
      await stopTor();
      throw new Error([error.message, ...recent].join("\n"));
    } finally {
      clearTimeout(timeout);
      current.cancel.signal.removeEventListener("abort", abort);
    }
  }

  function proxyConnection(client) {
    proxySockets.add(client);
    client.on("error", () => {});
    client.once("close", () => proxySockets.delete(client));
    if (reverting?.claimed || stopped) return client.destroy();
    client.setTimeout(30000, () => client.destroy());
    client.once("data", async (first) => {
      if (reverting?.claimed || stopped) return client.destroy();
      client.setTimeout(0);
      client.pause();
      logDestination(config.data, first);
      const complete = beginActivity();
      client.once("close", complete);
      try {
        const current = await ensureTor();
        if (client.destroyed || !current.ready) return client.destroy();
        client.tor = current;
        const upstream = net.connect(config.tunnelPort, LOOPBACK);
        upstream.setTimeout(CONNECTION_TIMEOUT, () => upstream.destroy());
        upstream.on("error", () => upstream.destroy());
        upstream.once("close", () => client.destroy());
        client.once("close", () => upstream.destroy());
        upstream.once("connect", () => {
          upstream.setTimeout(0);
          if (!current.ready || client.destroyed) return upstream.destroy();
          upstream.write(first);
          client.pipe(upstream).pipe(client);
        });
      } catch { client.destroy(); }
    });
  }

  function cancelSessionEnd() {
    clearTimeout(sessionTimer);
    generation++;
  }

  function scheduleSessionEnd() {
    if (clients.size || stopped) return;
    clearTimeout(sessionTimer);
    const endedGeneration = ++generation;
    sessionTimer = setTimeout(() => {
      if (endedGeneration !== generation || clients.size || stopped) return;
      if (active || reverting) return scheduleSessionEnd();
      const settings = [path.join(config.data, "settings.json"), path.join(config.here, "settings.json")];
      for (const file of settings) {
        try {
          const mode = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")).default;
          return mode === "off" ? revert(endedGeneration) : void stopTor();
        } catch (error) {
          if (error.code !== "ENOENT") break;
        }
      }
      void stopTor();
    }, SESSION_GRACE);
  }

  function revert(endedGeneration) {
    const work = { token: randomBytes(24).toString("hex"), generation: endedGeneration, claimed: false, retry: false };
    reverting = work;
    const cli = spawn(POWERSHELL, [
      "-NoProfile", "-NonInteractive", "-File", path.join(config.here, "tor-web.ps1"),
      "-Command", "revert", "-RevertToken", work.token,
    ], {
      env: { ...process.env, TOR_WEB_DATA_DIR: config.data }, stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
    });
    cli.stderr.on("data", (chunk) => { revertError = chunk.toString().slice(0, 300); });
    cli.once("error", (error) => { revertError = error.message; complete(null); });
    cli.once("exit", complete);
    cli.unref();

    function complete(code) {
      if (reverting !== work) return;
      reverting = undefined;
      if (stopped || work.generation !== generation || clients.size) return;
      if (code === 0 && work.claimed) void shutdown();
      else if (code === 4 || work.retry) scheduleSessionEnd();
      else if (!active) void stopTor();
    }
  }

  function checkRevert(token) {
    if (!reverting || reverting.claimed || reverting.token !== token || reverting.generation !== generation || stopped || clients.size) {
      return false;
    }
    if (active) {
      reverting.retry = true;
      return false;
    }
    reverting.claimed = true;
    return true;
  }

  async function watchOwner(pid) {
    if (!Number.isInteger(pid) || pid <= 0 || pid > 2147483647 || pid === process.pid) throw new Error("invalid owner PID");
    if (owner?.pid === pid) return;
    const child = spawn(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command",
      `$p = Get-Process -Id ${pid} -ErrorAction Stop; $null = $p.Handle; [Console]::WriteLine('ready'); $p.WaitForExit()`],
    { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const watcher = { child, pid };
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`could not open owner process ${pid}`)), CONNECTION_TIMEOUT);
        child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
        child.once("error", () => { clearTimeout(timer); reject(new Error(`could not watch owner process ${pid}`)); });
        child.once("close", () => { clearTimeout(timer); reject(new Error(`owner process ${pid} is not running`)); });
      });
      if (stopped) throw new Error("Tor runtime is stopping");
      owner?.child.kill();
      owner = watcher;
      child.once("exit", () => {
        if (owner !== watcher) return;
        owner = null;
        scheduleSessionEnd();
      });
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  function status() {
    return {
      running: !stopped, torReady: Boolean(tor?.ready), frontPort: config.frontPort,
      runtimePid: process.pid, torPid: tor?.child.pid ?? null, manual, active, sessions: clients.size,
      ...(revertError ? { revertError } : {}),
    };
  }

  function controlConnection(socket) {
    controls.add(socket);
    socket.on("error", () => {});
    const session = new AbortController();
    socket.once("close", () => {
      controls.delete(socket);
      session.abort(new Error("MCP session closed"));
      if (clients.delete(socket)) scheduleSessionEnd();
    });
    readFrames(socket, 1e6, (message) => {
      if (!message || typeof message !== "object") return socket.destroy();
      void handleCommand(message);
    });

    async function handleCommand({ id, command, args }) {
      try {
        if (command === "status") return await response(socket, id, status());
        if (command === "off") return await shutdown({ socket, id });
        if (command === "check-revert") return await response(socket, id, checkRevert(args?.revertToken));
        if (stopped) throw new Error("Tor runtime is stopping");
        if (reverting?.claimed) throw new Error("Tor runtime is restoring OpenCode settings");
        if (args?.frontPort !== config.frontPort) throw new Error(`runtime listens on front proxy port ${config.frontPort}; requested ${args?.frontPort}`);
        if (command === "standby") {
          cancelSessionEnd();
          return await response(socket, id, status());
        }
        if (command === "session") {
          cancelSessionEnd();
          clients.add(socket);
          return await response(socket, id, status());
        }
        if (command === "on") {
          cancelSessionEnd();
          const complete = beginActivity();
          try {
            if (args.owner !== undefined) await watchOwner(args.owner);
            await ensureTor();
            if (!socket.destroyed) manual = true;
            return await response(socket, id, status());
          } finally { complete(); }
        }
        if (command === "tool" && clients.has(socket)) {
          const complete = beginActivity();
          const request = new AbortController();
          const timer = setTimeout(() => request.abort(new Error(`Tor tool timed out after ${TOOL_TIMEOUT / 1000}s`)), TOOL_TIMEOUT);
          let torSignal;
          let text;
          const sessionClosed = () => request.abort(session.signal.reason);
          const torClosed = () => request.abort(torSignal.reason);
          try {
            const current = await ensureTor();
            torSignal = current.cancel.signal;
            session.signal.throwIfAborted();
            torSignal.throwIfAborted();
            session.signal.addEventListener("abort", sessionClosed, { once: true });
            torSignal.addEventListener("abort", torClosed, { once: true });
            text = await callTool(args.name, args.arguments, request.signal);
          } catch (error) {
            throw request.signal.aborted ? request.signal.reason : error;
          } finally {
            clearTimeout(timer);
            session.signal.removeEventListener("abort", sessionClosed);
            torSignal?.removeEventListener("abort", torClosed);
            complete();
          }
          return await response(socket, id, text);
        }
        throw new Error("unknown runtime command");
      } catch (error) {
        await response(socket, id, undefined, error.message);
      }
    }
  }
}

export async function runCli(action, config, script, args) {
  const { client, created } = await openRuntime(config, { script, start: action === "on" || action === "standby" });
  if (action === "check-revert") {
    try { process.exitCode = client && await client.request(action, args) ? 0 : 3; }
    finally { client?.close(); }
    return;
  }
  let status = { running: false, torReady: false, frontPort: config.frontPort };
  try {
    if (client) status = await client.request(action, args);
  } catch (error) {
    if (created && client) await client.request("off").catch(() => {});
    throw error;
  } finally {
    client?.close();
  }
  if (args.json) console.log(JSON.stringify(status));
  else if (status.torReady) console.log(`Tor: on (pid ${status.torPid}), ${status.manual ? "started by hand" : "started automatically"}`);
  else if (status.running) console.log(`Tor: standby (proxy on ${LOOPBACK}:${status.frontPort})`);
  else console.log("Tor: off");
}
