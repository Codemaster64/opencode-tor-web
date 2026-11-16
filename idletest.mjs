// Tor lifetime check with the idle stop cut to 15s:  node idletest.mjs   (~3 minutes)
// Tests the Tor process only (server.mjs --on/--off), not the Tor-mode switch. Stops the opencode service for parts
// A/B and starts it again for C/D; set TOR_WEB_TEST_MODEL to a model id to include part C (needs one opencode run).
import { spawn, execFileSync } from "node:child_process";
import net from "node:net";
import assert from "node:assert";
const OC = process.env.APPDATA + "/npm/node_modules/@opencode/cli/bin/opencode.exe";
const DIR = new URL(".", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const env = { ...process.env, TOR_WEB_IDLE_MINUTES: "0.25" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: "utf8", env, cwd: DIR }); } catch (e) { return String(e.stdout || e.message); } };
const torUp = () => new Promise((res) => { const s = net.connect(9062, "127.0.0.1"); s.once("connect", () => { s.destroy(); res(true); }); s.once("error", () => res(false)); });
const waitFor = async (want, secs) => { for (let i = 0; i < secs; i++) { if ((await torUp()) === want) return true; await sleep(1000); } return false; };
const svcPid = () => sh("pwsh", ["-NoProfile", "-Command", "(Get-CimInstance Win32_Process -Filter \"Name='opencode.exe'\" | ? CommandLine -match 'serve --service').ProcessId"]).trim();
const tw = (c) => { // start/stop Tor by hand like `tor-web on`, tied to the opencode service when it runs
  const owner = c === "on" ? svcPid() : "";
  return sh(process.execPath, [DIR + "server.mjs", "--" + c, ...(owner ? ["--owner", owner] : [])]).trim();
};

// our own MCP server instance (idle 15s) whose lifecycle checker runs every ~4s
const srv = spawn(process.execPath, [DIR + "server.mjs"], { stdio: ["pipe", "pipe", "inherit"], env });
let buf = "", next = 1; const waiting = new Map();
srv.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); } });
const rpc = (method, params) => new Promise((res) => { const id = next++; waiting.set(id, res); srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "idletest", version: "0" } });

sh(OC, ["service", "stop"]); tw("off");
assert(await waitFor(false, 10), "tor must be off at the start");

console.log("A1 auto start ->", (await rpc("tools/call", { name: "tor_status", arguments: {} })).result.content[0].text, "|", tw("status"));
const held = net.connect(9063, "127.0.0.1");
await new Promise((r) => held.once("connect", r));
held.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
await sleep(30000);
console.log("A2 30s with a connection open, tor up:", await torUp()); assert(await torUp());
held.destroy();
assert(await waitFor(false, 40), "auto tor should stop after 15s idle");
console.log("A3 stopped after idle |", tw("status"));

console.log("B1", tw("on"));
await sleep(30000);
console.log("B2 30s idle, hand-started tor up:", await torUp()); assert(await torUp(), "hand-started tor must ignore idle");
console.log("B3", tw("off")); assert(await waitFor(false, 10), "tor-web off should stop it");

sh(OC, ["service", "start"]); await sleep(3000);
console.log("C1", tw("on"), "| owner service pid", svcPid());
if (process.env.TOR_WEB_TEST_MODEL) { // needs a model to run one short opencode session
  console.log("C2 opencode run (a window) ...", sh(OC, ["run", "-m", process.env.TOR_WEB_TEST_MODEL, "Reply with exactly: OK"]).trim().split("\n").pop());
  assert(await waitFor(false, 45), "tor should stop once the opencode window closed");
  console.log("C3 stopped after the opencode window closed");
} else { console.log("C2 skipped (set TOR_WEB_TEST_MODEL to test 'stops when opencode closes')"); tw("off"); }

console.log("D1", tw("on"));
sh(OC, ["service", "stop"]);
assert(await waitFor(false, 60), "tor should exit with the opencode service");
console.log("D2 tor exited with the opencode service");
sh(OC, ["service", "start"]);

srv.kill();
console.log("idletest OK");
process.exit(0);
