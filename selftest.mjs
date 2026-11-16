// Self-check: node selftest.mjs  -> drives server.mjs over stdio like opencode does, asserts Tor exit + search + fetch work.
import { spawn } from "node:child_process";
import assert from "node:assert";
const srv = spawn(process.execPath, [new URL("./server.mjs", import.meta.url).pathname.replace(/^\/(\w:)/, "$1")], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "", next = 1; const waiting = new Map();
srv.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); } });
const rpc = (method, params) => new Promise((res) => { const id = next++; waiting.set(id, res); srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const call = async (name, args) => { const r = await rpc("tools/call", { name, arguments: args }); const t = r.result.content[0].text; console.log(`--- ${name}: ${t.slice(0, 300).replace(/\n/g, " | ")}`); assert(!r.result.isError, t); return t; };

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "selftest", version: "0" } });
assert.equal(init.result.serverInfo.name, "tor-web");
assert.equal((await rpc("tools/list", {})).result.tools.length, 3);
// proxy port 9063 (what opencode's HTTPS_PROXY points at) must start tor by itself and exit via Tor
const { execFileSync } = await import("node:child_process");
const viaProxy = execFileSync("curl.exe", ["-s", "-m", "150", "-x", "http://127.0.0.1:9063", "https://check.torproject.org/api/ip"], { encoding: "utf8" });
console.log("--- proxy 9063: " + viaProxy);
assert.match(viaProxy, /"IsTor":\s*true/);
assert.match(await call("tor_status", {}), /"IsTor":\s*true/);
assert.match(await call("tor_search", { query: "tor project", max_results: 3 }), /https?:\/\/[\s\S]*via .+ over Tor/);
assert.match(await call("tor_fetch", { url: "https://example.com" }), /Status: 200[\s\S]*Example Domain/);
console.log("selftest OK");
srv.kill(); process.exit(0);
