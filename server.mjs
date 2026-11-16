// tor-web: MCP server for opencode. Web search + fetch, every byte through Tor (SOCKS5, DNS resolved by Tor).
// Fails closed: if Tor is not reachable the tool errors; it never falls back to a direct connection.
// Zero dependencies. Runs Tor Browser's tor.exe on demand as a shared background tor: SOCKS 127.0.0.1:9062, HTTP proxy :9063.
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOCKS_PORT = Number(process.env.TOR_WEB_SOCKS_PORT || 9062);
const TOR_DIR = process.env.TOR_WEB_TOR_DIR || path.join(os.homedir(), "Desktop", "Tor Browser", "Browser", "TorBrowser", "Tor");
const DDG_ONION = "duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion";
// Same user agent as the installed Tor Browser (it reports its Firefox ESR major on Windows), so fetches blend in.
const FF_MAJOR = (() => { try { return fs.readFileSync(path.join(TOR_DIR, "..", "..", "application.ini"), "utf8").match(/^Version=(\d+)/m)[1]; } catch { return "153"; } })();
const UA = `Mozilla/5.0 (Windows NT 10.0; rv:${FF_MAJOR}.0) Gecko/20100101 Firefox/${FF_MAJOR}.0`;
const log = (...a) => process.stderr.write("[tor-web] " + a.join(" ") + "\n");

// ---------- Tor process ----------
function portOpen(port) {
  return new Promise((res) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => { s.destroy(); res(true); });
    s.once("error", () => res(false));
  });
}

// Tor starts on demand: on the first tool call, or the first connection to the proxy port 9063 (opencode's HTTPS_PROXY,
// used by Code Mode fetch and shell tools). Tor itself: SOCKS 9062 (these tools) + HTTP CONNECT 9064 (behind 9063).
// Lifetime (one tor shared by every opencode session):
//  - started automatically (first tool call / proxy use): stops after TOR_WEB_IDLE_MINUTES (default 10) without use
//  - started by hand (`tor-web on`): no idle stop; stops on `tor-web off`
//  - either way it stops when opencode closes: tor exits with the opencode service (__OwningControllerProcess), and the
//    checker stops it once an opencode window has been seen and none is left.
//  - Tor MODE (opencode routed through Tor at all) is switched by tor-web.ps1. With `tor-web default off` the mode is
//    per session: when opencode closes, this server switches the mode back off.
const HTTP_TUNNEL_PORT = SOCKS_PORT + 2;
const FRONT_PROXY_PORT = SOCKS_PORT + 1;
const DATA = path.join(HERE, "data");
const PID_FILE = path.join(DATA, "tor.pid");
const STATE_FILE = path.join(DATA, "state.json"); // { manual } for the running tor
const SESSION_FILE = path.join(DATA, "session.json"); // { seenWindow } for the current opencode session (outlives tor)
const SETTINGS_FILE = path.join(HERE, "settings.json"); // { default: "on" | "off" }  (tor-web default on|off)
const OC_EXE = path.join(process.env.APPDATA || "", "npm", "node_modules", "@opencode", "cli", "bin", "opencode.exe");
const MODE_ENV = ["OPENCODE_CONFIG", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_USE_ENV_PROXY"];
const ACTIVITY_FILE = path.join(DATA, "last-activity"); // shared by all sessions: epoch ms of the last use
const IDLE_MS = Number(process.env.TOR_WEB_IDLE_MINUTES || 10) * 60000;
const argVal = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const OWNER_PID = argVal("--owner") ?? (process.argv.length <= 2 ? String(process.ppid) : undefined); // MCP mode: parent = opencode

let active = 0; // open proxy connections + running tool calls in THIS process
const touch = () => { try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(ACTIVITY_FILE, String(Date.now())); } catch {} };
const lastActivity = () => { try { return Number(fs.readFileSync(ACTIVITY_FILE, "utf8")) || 0; } catch { return 0; } };
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; } };
const writeState = (s) => { try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch {} };
const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", windowsHide: true });

function torPid() { // pid of OUR running tor, checked to really be tor.exe (a stale pid file must never kill anything else)
  let pid; try { pid = Number(fs.readFileSync(PID_FILE, "utf8")); } catch { return 0; }
  return pid && /^"tor\.exe"/i.test(run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]).trim()) ? pid : 0;
}
function stopTor(why) {
  const pid = torPid();
  if (pid) { try { process.kill(pid); log(`tor stopped: ${why}`); } catch {} }
  for (const f of [PID_FILE, STATE_FILE]) { try { fs.unlinkSync(f); } catch {} }
}
function opencodeWindows() { // opencode processes that are not a server (the TUI, `opencode run`, ...)
  const out = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "@(Get-CimInstance Win32_Process -Filter \"Name='opencode.exe'\" | ? { $_.CommandLine -notmatch ' serve' }).Count"]);
  return Number(out.trim()) || 0;
}
const seenWindow = () => { try { return JSON.parse(fs.readFileSync(SESSION_FILE, "utf8")).seenWindow === true; } catch { return false; } };
const defaultMode = () => { try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")).default === "off" ? "off" : "on"; } catch { return "on"; } };

function opencodeClosed() {
  stopTor("opencode was closed");
  try { fs.unlinkSync(SESSION_FILE); } catch {}
  if (defaultMode() !== "off") return;
  // per-session Tor mode: switch opencode back to normal. Changing service env STOPS the opencode service (and with it
  // this process), so the switch-back runs as a detached process of its own.
  spawn(process.execPath, [fileURLToPath(import.meta.url), "--revert"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  log("Tor mode switching off (per-session default)");
}
function revertMode() { // remove every Tor-mode variable from the service, then make sure it is stopped
  for (const k of MODE_ENV) { try { run(OC_EXE, ["service", "unset", "env", k]); } catch {} }
  try { run(OC_EXE, ["service", "stop"]); } catch {}
}

function lifecycleCheck() {
  const windows = opencodeWindows();
  if (windows > 0 && !seenWindow()) { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(SESSION_FILE, JSON.stringify({ seenWindow: true })); }
  if (windows === 0 && seenWindow()) return opencodeClosed();
  if (!torPid() || readState().manual) return; // not running, or started by hand: no idle stop
  if (active > 0) return touch(); // a long download keeps tor alive
  if (Date.now() - lastActivity() >= IDLE_MS) stopTor(`${IDLE_MS / 60000} min idle`);
}

let starting = null;
function ensureTor() {
  touch();
  starting ??= (async () => {
    if (await portOpen(SOCKS_PORT)) return; // already running (another session started it): share it
    await startTor();
    writeState({ manual: false });
  })().finally(() => { starting = null; });
  return starting;
}

async function startTor() {
  {
    const exe = path.join(TOR_DIR, "tor.exe");
    if (!fs.existsSync(exe)) throw new Error(`tor.exe not found at ${exe} (set TOR_WEB_TOR_DIR)`);
    const data = DATA;
    fs.mkdirSync(data, { recursive: true });
    const logFile = path.join(data, "tor.log");
    fs.writeFileSync(logFile, "");
    spawn(exe, [
      "-f", "NUL", "--defaults-torrc", "NUL", "--ignore-missing-torrc", // ignore Tor Browser's own torrc files
      // IsolateDestAddr: every destination gets its own circuit/exit, so sites can't be linked to each other by exit IP
      "--SocksPort", `127.0.0.1:${SOCKS_PORT} IsolateDestAddr`,
      "--HTTPTunnelPort", `127.0.0.1:${HTTP_TUNNEL_PORT} IsolateDestAddr`,
      "--DataDirectory", data,
      "--GeoIPFile", path.join(TOR_DIR, "geoip"),
      "--GeoIPv6File", path.join(TOR_DIR, "geoip6"),
      "--Log", `notice file ${logFile}`,
      "--PidFile", PID_FILE,
      ...(OWNER_PID ? ["__OwningControllerProcess", OWNER_PID] : []), // tor exits when opencode's service exits
    ], { windowsHide: true, detached: true, stdio: "ignore" }).unref(); // outlives this MCP process on purpose
    for (let i = 0; i < 240; i++) { // up to 120s
      await new Promise((r) => setTimeout(r, 500));
      const txt = fs.readFileSync(logFile, "utf8");
      if (/Bootstrapped 100%/.test(txt)) { log("tor bootstrapped on", SOCKS_PORT, HTTP_TUNNEL_PORT); touch(); return; }
      if (/\[err\]/.test(txt)) throw new Error("tor failed to start: " + txt.split("\n").filter((l) => /\[err\]/.test(l)).join(" | "));
    }
    throw new Error("Tor did not bootstrap within 120s (see " + logFile + ")");
  }
}

// Port 9063: accept the connection, start tor if needed, then splice it onto tor's HTTP CONNECT port.
// Only one opencode session can own the port; the others retry, so one takes over when the owner exits.
function startFrontProxy() {
  const srv = net.createServer((c) => {
    c.on("error", () => {});
    c.once("data", (first) => {
      c.pause();
      // visited hosts are NOT written to opencode's log unless asked for (TOR_WEB_LOG_HOSTS=1): no local trail
      if (process.env.TOR_WEB_LOG_HOSTS) log("proxy: " + first.toString("latin1").split("\r\n")[0].slice(0, 200));
      active++;
      c.once("close", () => { active--; touch(); });
      ensureTor().then(() => {
        const up = net.connect(HTTP_TUNNEL_PORT, "127.0.0.1");
        up.on("error", () => c.destroy());
        c.on("close", () => up.destroy());
        up.write(first);
        c.pipe(up).pipe(c);
        c.resume();
      }, (e) => { log("proxy: " + e.message); c.destroy(); });
    });
  });
  srv.on("error", (e) => {
    if (e.code === "EADDRINUSE") setTimeout(() => srv.listen(FRONT_PROXY_PORT, "127.0.0.1"), 5000).unref();
    else log("proxy: " + e.message);
  });
  srv.listen(FRONT_PROXY_PORT, "127.0.0.1");
}

// ---------- SOCKS5 (hostname sent to Tor, so DNS never leaks) ----------
function socksConnect(host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect(SOCKS_PORT, "127.0.0.1");
    let stage = 0, buf = Buffer.alloc(0);
    const fail = (e) => { s.destroy(); reject(e instanceof Error ? e : new Error(e)); };
    s.setTimeout(60000, () => fail("SOCKS timeout"));
    s.once("error", fail);
    s.once("connect", () => s.write(Buffer.from([5, 1, 0])));
    s.on("data", function onData(d) {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 2) {
        if (buf[0] !== 5 || buf[1] !== 0) return fail("SOCKS auth refused");
        buf = buf.subarray(2); stage = 1;
        const h = Buffer.from(host);
        s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 255])]));
      }
      if (stage === 1 && buf.length >= 5) {
        if (buf[1] !== 0) return fail(`Tor could not connect to ${host}:${port} (SOCKS error ${buf[1]})`);
        const need = 4 + (buf[3] === 1 ? 4 : buf[3] === 4 ? 16 : 1 + buf[4]) + 2;
        if (buf.length < need) return;
        s.removeListener("data", onData);
        s.removeListener("error", fail);
        s.setTimeout(0);
        if (buf.length > need) s.unshift(buf.subarray(need));
        resolve(s);
      }
    });
  });
}

// ---------- HTTP(S) over Tor ----------
// The agent's createConnection is the ONLY way these requests get a socket, and it only ever dials the SOCKS port.
// (A createConnection request option is ignored once an agent exists, and `agent: false` makes one: that leaked.)
function torConnect(opts, cb, secure) {
  socksConnect(opts.host, Number(opts.port)).then((raw) => {
    if (!secure) return cb(null, raw);
    const t = tls.connect({ socket: raw, servername: net.isIP(opts.host) ? undefined : opts.host });
    t.once("secureConnect", () => cb(null, t));
    t.once("error", (e) => cb(e));
  }, (e) => cb(e));
}
class TorHttpAgent extends http.Agent { createConnection(o, cb) { torConnect(o, cb, false); } }
class TorHttpsAgent extends https.Agent { createConnection(o, cb) { torConnect(o, cb, true); } }
const AGENTS = { "http:": new TorHttpAgent(), "https:": new TorHttpsAgent() };

function requestOnce(url, { method = "GET", headers = {}, body } = {}) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error("only http/https URLs");
  const secure = u.protocol === "https:";
  const port = Number(u.port || (secure ? 443 : 80));
  return new Promise((resolve, reject) => {
    const req = (secure ? https : http).request({
      method, host: u.hostname, port, path: u.pathname + u.search, agent: AGENTS[u.protocol],
      headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5", "Accept-Encoding": "gzip, deflate, br", "Connection": "close", ...headers },
    }, (res) => {
      const chunks = []; let size = 0;
      const enc = (res.headers["content-encoding"] || "").toLowerCase();
      const stream = enc === "gzip" ? res.pipe(zlib.createGunzip()) : enc === "deflate" ? res.pipe(zlib.createInflate())
        : enc === "br" ? res.pipe(zlib.createBrotliDecompress()) : res;
      stream.on("data", (c) => { size += c.length; if (size > 8e6) { req.destroy(); return; } chunks.push(c); });
      stream.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      stream.on("error", reject);
    });
    req.setTimeout(90000, () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function torFetch(url, opts = {}) {
  await ensureTor();
  for (let hop = 0; hop < 6; hop++) {
    const r = await requestOnce(url, opts);
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      url = new URL(r.headers.location, url).href;
      opts = { headers: opts.headers }; // redirects become GET
      continue;
    }
    return { ...r, url };
  }
  throw new Error("too many redirects");
}

// ---------- HTML helpers ----------
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
  e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? m);
const stripTags = (s) => decode(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

function htmlToText(html) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  let s = html.replace(/<(script|style|noscript|svg|head|template)[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<a\s[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, txt) => {
    const t = stripTags(txt); return t ? `${t} (${decode(href)})` : "";
  });
  s = s.replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article|\/pre|\/blockquote)[^>]*>/gi, "\n")
       .replace(/<li[^>]*>/gi, "\n- ").replace(/<h([1-6])[^>]*>/gi, (_m, n) => "\n" + "#".repeat(+n) + " ");
  s = decode(s.replace(/<[^>]+>/g, " ")).replace(/[ \t\f\v\r]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return (title ? `# ${stripTags(title)}\n\n` : "") + s;
}

// ---------- tools ----------
// Engines in order. A bot check is reported as-is, never worked around.
// ponytail: HTML scraping, so a markup change on either site breaks its parser; selftest.mjs catches that.
const ENGINES = [
  { name: "Brave", url: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}&source=web`, parse(html) {
      return html.split('data-type="web"').slice(1).map((b) => {
        const url = (b.match(/<a href="(https?:\/\/[^"]+)"/) || [])[1];
        const title = (b.match(/class="title search-snippet-title[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1];
        const snip = (b.match(/class="generic-snippet[\s\S]*?class="content[^"]*">([\s\S]*?)<\/div>/) || [])[1];
        return url && title ? { title: stripTags(title), url: decode(url), snippet: snip ? stripTags(snip) : "" } : null;
      }).filter(Boolean);
  } },
  { name: "DuckDuckGo (.onion)", url: (q) => `https://${DDG_ONION}/html/?q=${encodeURIComponent(q)}`, parse(html) {
      const out = [];
      const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="result__a"|$)/g;
      for (let m; (m = re.exec(html));) {
        let href = decode(m[1]);
        const ud = href.match(/[?&]uddg=([^&]+)/);
        if (ud) href = decodeURIComponent(ud[1]);
        if (/y\.js|ad_domain=/.test(href)) continue; // ads
        const snip = (m[3].match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/) || [])[1];
        out.push({ title: stripTags(m[2]), url: href, snippet: snip ? stripTags(snip) : "" });
      }
      return out;
  } },
];

// Exa: the same agent-search API opencode's built-in websearch uses (public MCP endpoint, no key), just sent through Tor.
async function exaSearch(query, max) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "web_search_exa", arguments: { query, numResults: max } } });
  const r = await torFetch("https://mcp.exa.ai/mcp", { method: "POST", body,
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" } });
  const raw = r.body.toString("utf8").trim();
  const json = raw.startsWith("{") ? raw : raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).pop();
  let msg; try { msg = JSON.parse(json || ""); } catch { throw new Error(`HTTP ${r.status}: ${raw.slice(0, 200)}`); }
  if (msg.error) throw new Error(msg.error.message);
  const text = (msg.result?.content || []).map((c) => c.text || "").join("\n").trim();
  if (!text || msg.result?.isError) throw new Error(`HTTP ${r.status}: ${(text || raw).slice(0, 200)}`);
  return text;
}

async function search(query, max = 10) {
  const errors = [];
  try { return { engine: "Exa", text: await exaSearch(query, max) }; } catch (err) { errors.push(`Exa: ${err.message}`); }
  for (const e of ENGINES) {
    try {
      const r = await torFetch(e.url(query));
      const html = r.body.toString("utf8");
      const out = e.parse(html).slice(0, max);
      if (out.length) return { engine: e.name, text: out.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join("\n\n") };
      errors.push(`${e.name}: no results (HTTP ${r.status}${/anomaly-modal|unusual traffic|are you a robot|captcha/i.test(html) ? ", it showed a bot check" : ""})`);
    } catch (err) { errors.push(`${e.name}: ${err.message}`); }
  }
  throw new Error("search failed over Tor: " + errors.join("; "));
}

const TOOLS = [
  { name: "tor_search", description: "Search the web (Exa; Brave and DuckDuckGo .onion as fallbacks) through the Tor network. Use this for ALL web searches.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, max_results: { type: "number", description: "default 10" } }, required: ["query"] } },
  { name: "tor_fetch", description: "Fetch a URL (http/https, .onion allowed) through the Tor network and return it as readable text. Use this for ALL web page fetches.",
    inputSchema: { type: "object", properties: { url: { type: "string" }, raw: { type: "boolean", description: "return the raw body instead of text" },
      max_chars: { type: "number", description: "default 60000" } }, required: ["url"] } },
  { name: "tor_status", description: "Check that traffic leaves through Tor (asks check.torproject.org).",
    inputSchema: { type: "object", properties: {} } },
];

async function callTool(name, a) {
  if (name === "tor_search") {
    const { engine, text } = await search(String(a.query), Math.min(Number(a.max_results) || 10, 30));
    return `${text}\n\n(via ${engine} over Tor)`;
  }
  if (name === "tor_fetch") {
    const r = await torFetch(String(a.url));
    const ct = String(r.headers["content-type"] || "");
    let text = r.body.toString("utf8");
    if (!a.raw && /html|xml/i.test(ct)) text = htmlToText(text);
    const max = Number(a.max_chars) || 60000;
    if (text.length > max) text = text.slice(0, max) + `\n\n[truncated: ${text.length} chars total, raise max_chars for more]`;
    return `URL: ${r.url}\nStatus: ${r.status}\nContent-Type: ${ct}\n\n${text}`;
  }
  if (name === "tor_status") {
    const r = await torFetch("https://check.torproject.org/api/ip");
    return r.body.toString("utf8");
  }
  throw new Error("unknown tool " + name);
}

// ---------- MCP over stdio (newline-delimited JSON-RPC) ----------
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications
  try {
    if (method === "initialize") return send({ id, result: { protocolVersion: params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {} }, serverInfo: { name: "tor-web", version: "1.0.0" } } });
    if (method === "ping") return send({ id, result: {} });
    if (method === "tools/list") return send({ id, result: { tools: TOOLS } });
    if (method === "tools/call") {
      try {
        active++;
        const text = await callTool(params.name, params.arguments || {}).finally(() => { active--; touch(); });
        return send({ id, result: { content: [{ type: "text", text }] } });
      } catch (e) {
        return send({ id, result: { content: [{ type: "text", text: "Error: " + e.message }], isError: true } });
      }
    }
    send({ id, error: { code: -32601, message: "method not found: " + method } });
  } catch (e) { send({ id, error: { code: -32603, message: e.message } }); }
}

function statusText() {
  const pid = torPid();
  if (!pid) return "Tor: off (starts automatically when opencode needs the internet)";
  const st = readState(), idleMin = (Date.now() - lastActivity()) / 60000;
  return `Tor: on (pid ${pid}), ${st.manual ? "started by hand: stays on until `tor-web off` or opencode closes"
    : `started automatically: stops after ${IDLE_MS / 60000} min idle (idle ${idleMin.toFixed(1)} min) or when opencode closes`}`;
}

const cli = ["--on", "--off", "--status", "--revert"].find((a) => process.argv.includes(a));
if (cli) { // tor-web on | off | status, and the detached per-session switch-back
  if (cli === "--on") { await ensureTor(); writeState({ ...readState(), manual: true }); }
  if (cli === "--off") stopTor("stopped by hand");
  if (cli === "--revert") { revertMode(); process.exit(0); }
  console.log(statusText());
  process.exit(0);
}

// ---------- MCP mode (started by opencode) ----------
let inbuf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  inbuf += d;
  let i;
  while ((i = inbuf.indexOf("\n")) >= 0) {
    const line = inbuf.slice(0, i).trim(); inbuf = inbuf.slice(i + 1);
    if (line) { try { handle(JSON.parse(line)); } catch (e) { log("bad message", e.message); } }
  }
});
process.stdin.on("end", () => { // opencode is shutting this server down
  try {
    if (opencodeWindows() === 0) { if (seenWindow()) opencodeClosed(); else if (torPid()) stopTor("opencode was closed"); }
  } catch {}
  process.exit(0);
});
startFrontProxy(); // tor itself only starts when something needs the internet
const safeCheck = () => { try { lifecycleCheck(); } catch (e) { log("lifecycle: " + e.message); } };
setTimeout(safeCheck, 2000).unref(); // opencode just loaded us, so a window is open: notice it even in a short session
setInterval(safeCheck, Math.min(30000, IDLE_MS / 4)).unref();
