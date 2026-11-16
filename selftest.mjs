// Opt-in end-to-end check: Windows, OpenCode v2, Tor Browser, and public test URLs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const openCode = process.env.TOR_WEB_TEST_OPENCODE || path.join(
  process.env.APPDATA || "", "npm", "node_modules", "@opencode", "cli", "bin", "opencode.exe",
);
assert(process.platform === "win32", "The OpenCode smoke test requires Windows");
assert(existsSync(openCode), "Set TOR_WEB_TEST_OPENCODE to the path of your opencode.exe");

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function availablePorts() {
  for (let attempt = 0; attempt < 30; attempt++) {
    // Stay below Windows' default ephemeral range.
    const base = 20000 + Math.floor(Math.random() * 20000);
    const listeners = [];
    try {
      for (let offset = 0; offset < 4; offset++) {
        const socket = net.createServer();
        await listen(socket, base + offset);
        listeners.push(socket);
      }
      return base;
    } catch (error) {
      if (!["EADDRINUSE", "EACCES"].includes(error.code)) throw error;
    } finally {
      await Promise.all(listeners.map(close));
    }
  }
  throw new Error("Could not reserve test ports");
}

const scratch = await mkdtemp(path.join(os.tmpdir(), "tor-web-open-code-"));
const profile = path.join(scratch, "profile");
const project = path.join(scratch, "project");
const config = path.join(scratch, "config", "opencode");
const data = path.join(scratch, "tor-data");
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(?:OPENCODE_|TOR_WEB_|(?:HTTPS?|ALL|NO|WSS?)_PROXY$|NODE_USE_ENV_PROXY$)/i.test(key)) delete env[key];
}
Object.assign(env, {
  OPENCODE_TEST_HOME: profile,
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_CONFIG_DIR: config,
  XDG_CONFIG_HOME: path.dirname(config),
  XDG_DATA_HOME: path.join(scratch, "data"),
  XDG_STATE_HOME: path.join(scratch, "state"),
  XDG_CACHE_HOME: path.join(scratch, "cache"),
  TOR_WEB_DATA_DIR: data,
  TOR_WEB_TEST_OPENCODE: openCode,
});
if (process.env.TOR_WEB_TOR_DIR) env.TOR_WEB_TOR_DIR = process.env.TOR_WEB_TOR_DIR;

let evidence = { payload: "", called: false, shellListed: false };
let scenario = "tor";
const source = [
  'const report = async (label, task) => {',
  '  try { console.log(label, JSON.stringify(await task())) }',
  '  catch (error) { console.log(label, String(error)) }',
  '}',
  'await report("TOR_MCP", () => tools["tor-web"].tor_status({}));',
  'await report("TOR_SEARCH", () => tools["tor-web"].tor_search({query: "Tor Project official site", max_results: 3}));',
  'await report("TOR_FETCH", () => tools["tor-web"].tor_fetch({url: "https://example.com/"}));',
  'await report("TOR_CODE_FETCH", async () => (await fetch("https://check.torproject.org/api/ip")).json());',
].join("\n");

function respond(res, delta, finish) {
  const chunk = (d, reason) =>
    "data: " + JSON.stringify({
      object: "chat.completion.chunk",
      id: "tor-web-fixture",
      created: 1,
      model: "fixture",
      choices: [{ index: 0, delta: d, finish_reason: reason }],
    }) + "\n\n";
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  res.end(chunk({ role: "assistant", ...delta }, null) + chunk({}, finish) + "data: [DONE]\n\n");
}

const fixture = http.createServer(async (req, res) => {
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const toolResults = body.messages.filter((message) => message.role === "tool");
    if (toolResults.length) {
      evidence.payload = toolResults.flatMap((message) => typeof message.content === "string"
        ? [message.content]
        : message.content?.map((part) => part.text).filter(Boolean) ?? []).join("\n");
      respond(res, { content: "OpenCode fixture complete." }, "stop");
      return;
    }
    if (scenario === "warm") {
      respond(res, { content: "Smoke fixture ready." }, "stop");
      return;
    }
    const shell = scenario === "shell";
    const name = shell ? "shell" : "execute";
    const tool = body.tools?.find((item) => item.function?.name === name);
    if (shell && tool) evidence.shellListed = true;
    if (tool && !evidence.called) {
      evidence.called = true;
      const args = shell
        ? { command: "echo tor-web-shell-marker", description: "Check local shell policy" }
        : { code: source };
      respond(res, {
        tool_calls: [{
          index: 0,
          id: "tor-web-call",
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        }],
      }, "tool_calls");
      return;
    }
    respond(res, { content: "Fixture received no " + name + " tool." }, "stop");
  } catch {
    res.writeHead(500).end();
  }
});

function run(exe, args, { timeout = 30000, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let finished = false;
    let exitDrain;
    const timer = setTimeout(() => {
      child.kill();
      settle(new Error(path.basename(exe) + " timed out: " + args.slice(0, 2).join(" ")));
    }, timeout);
    child.stdout.setEncoding("utf8").on("data", (text) => { stdout += text; });
    child.stderr.setEncoding("utf8").on("data", (text) => { stderr += text; });
    child.once("error", settle);
    // A detached Windows service can inherit the pipes after its launcher exits.
    child.once("exit", (code) => { exitDrain = setTimeout(() => finish(code), 200); });
    child.once("close", finish);

    function settle(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(exitDrain);
      child.stdout.destroy();
      child.stderr.destroy();
      if (error) reject(error);
      else resolve(stdout);
    }

    function finish(code) {
      settle(code !== 0 && !allowFailure
        ? new Error(path.basename(exe) + " exited " + code + "\n" + (stderr || stdout).slice(-3500))
        : undefined);
    }
  });
}

const oc = (args, opts) => run(openCode, args, opts);
const mode = (command) => run("powershell.exe", [
  "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(here, "tor-web.ps1"), command,
], { timeout: 160000 });
const runtime = (command) => run(process.execPath, [path.join(here, "server.mjs"), command]);
async function exerciseOpenCode(probe) {
  scenario = probe;
  evidence = { payload: "", called: false, shellListed: false };
  const output = await oc(["run", "--format", "json", "-m", "fixture/fixture", "Run the local integration fixture."], {
    timeout: 240000,
  });
  if (probe === "shell" && !evidence.shellListed) return "";
  assert(evidence.called, "OpenCode did not load the expected tool");
  assert(evidence.payload, "OpenCode did not return a tool result:\n" + output.slice(-2500));
  return evidence.payload;
}
let isolated = false;

try {
  await Promise.all([profile, project, config].map((dir) => mkdir(dir, { recursive: true })));
  const base = await availablePorts();
  env.TOR_WEB_SOCKS_PORT = String(base);
  const modelPort = await listen(fixture);
  await writeFile(path.join(config, "opencode.json"), JSON.stringify({
    model: "fixture/fixture",
    providers: {
      fixture: {
        name: "Local test model",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: "http://127.0.0.1:" + modelPort + "/v1", apiKey: "fixture-only" },
        models: { fixture: { name: "Fixture", capabilities: { tools: true }, limit: { context: 64000, output: 4000 } } },
      },
    },
  }));
  const paths = await oc(["debug", "paths"]);
  assert(paths.includes(config) && paths.includes(env.XDG_STATE_HOME), "OpenCode did not pick up the isolated profile");
  isolated = true;
  await oc(["service", "set", "port", String(base + 3)]);
  await oc(["service", "set", "env", "NO_PROXY", "localhost"]);
  console.log("Starting isolated OpenCode service on port " + (base + 3));
  await oc(["service", "start"]);
  assert.match(await exerciseOpenCode("shell"), /^tor-web-shell-marker$/m, "The shell control did not run with Tor mode off");
  console.log("Enabling Tor mode and waiting for Tor to bootstrap");
  console.log((await mode("on")).trim());
  assert.match(await oc(["service", "status"]), new RegExp("^http://127\\.0\\.0\\.1:" + (base + 3) + "\\b"), "The switch did not restart OpenCode");
  scenario = "warm";
  await oc(["run", "--format", "json", "-m", "fixture/fixture", "Initialize the test location."]);
  let mcp = "";
  const deadline = Date.now() + 30000;
  do {
    mcp = (await oc(["mcp", "list"])).trim();
    if (/tor-web.*connected/i.test(mcp)) break;
    await delay(300);
  } while (Date.now() < deadline);
  assert.match(mcp, /tor-web.*connected/i, "OpenCode did not connect the Tor MCP server: " + mcp);
  console.log(mcp);
  console.log("Driving Tor and DuckDuckGo tools through OpenCode");
  const toolOutput = (await exerciseOpenCode("tor")).replace(/\\+["]/g, '"');
  assert.match(toolOutput, /TOR_MCP[^\n]*"IsTor":\s*true/i, "MCP did not confirm the Tor exit: " + toolOutput.slice(0, 1600));
  const resultLine = toolOutput.split("\n").find((line) => line.startsWith("TOR_SEARCH ")) ?? "";
  assert.match(resultLine, /TOR_SEARCH "[^"]*1\. .*https?:\/\/.*via DuckDuckGo/i, "OpenCode did not receive DuckDuckGo results: " + resultLine.slice(0, 900));
  assert.match(toolOutput, /TOR_FETCH[^\n]*Example Domain/i, "MCP page fetch failed");
  assert.match(toolOutput, /TOR_CODE_FETCH[^\n]*"IsTor":\s*true/i, "Code Mode fetch did not confirm the Tor exit");
  const shellOutput = await exerciseOpenCode("shell");
  if (evidence.shellListed) {
    assert.match(shellOutput, /blocked|denied/i, "The available shell tool did not report a denial");
    assert.doesNotMatch(shellOutput, /^tor-web-shell-marker$/m, "The shell command ran in Tor mode");
  }
  console.log("MCP Tor exit, DuckDuckGo search, page fetch, Code Mode Tor exit, and shell denial verified.");
  await mode("off");
  const before = await oc(["service", "get", "env", "NO_PROXY"]);
  assert.match(before, /\blocalhost\b/);
  assert.doesNotMatch(before, /127\.0\.0\.1/);
  assert.match(await oc(["service", "status"]), new RegExp("^http://127\\.0\\.0\\.1:" + (base + 3) + "\\b"));
  console.log("OpenCode remained available and the original proxy setting was restored.");
} catch (error) {
  if (isolated) {
    const log = await readFile(path.join(scratch, "data", "opencode", "log", "opencode.log"), "utf8").catch(() => "");
    const details = log.split(/\r?\n/).filter((line) => /mcp|tor-web.*(?:error|failed)|level=ERROR/i.test(line));
    if (details.length) console.error(details.slice(-16).join("\n"));
  }
  throw error;
} finally {
  try {
    if (isolated) {
      try { await mode("off"); } catch (error) { console.error(error.message); }
      try { await oc(["service", "stop"]); } catch (error) { console.error(error.message); }
      try { await runtime("--off"); } catch (error) { console.error(error.message); }
    }
  } finally {
    await close(fixture);
    const resolved = path.resolve(scratch);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert(path.basename(resolved).startsWith("tor-web-open-code-"));
    await rm(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}
