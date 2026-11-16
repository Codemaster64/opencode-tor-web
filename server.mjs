// tor-web MCP and CLI. All network requests use the shared Tor runtime.
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { searchDuckDuckGo } from "./duckduckgo.mjs";
import { requestOnce } from "./network.mjs";
import { configuration, openRuntime, runCli, runRuntime } from "./runtime.mjs";

const script = fileURLToPath(import.meta.url);
const here = path.dirname(script);
const log = (...args) => process.stderr.write("[tor-web] " + args.join(" ") + "\n");

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, entity) => {
  if (!entity.startsWith("#")) return Object.hasOwn(ENT, entity.toLowerCase()) ? ENT[entity.toLowerCase()] : match;
  const point = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
  return point <= 0x10ffff ? String.fromCodePoint(point) : "\uFFFD";
});
const stripTags = (s) => decode(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

function htmlToText(html) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  let text = html.replace(/<(script|style|noscript|svg|head|template)[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/<a\s[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_match, href, content) => {
    const label = stripTags(content);
    return label ? `${label} (${decode(href)})` : "";
  });
  text = text.replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article|\/pre|\/blockquote)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ").replace(/<h([1-6])[^>]*>/gi, (_match, n) => "\n" + "#".repeat(+n) + " ");
  text = decode(text.replace(/<[^>]+>/g, " ")).replace(/[ \t\f\v\r]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return (title ? `# ${stripTags(title)}\n\n` : "") + text;
}

const tools = [
  { name: "tor_search", description: "Search the web with DuckDuckGo through the Tor network.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, max_results: { type: "number", description: "default 10" } }, required: ["query"] } },
  { name: "tor_fetch", description: "Fetch a URL (HTTP, HTTPS or .onion) through the Tor network and return readable text.",
    inputSchema: { type: "object", properties: { url: { type: "string" }, raw: { type: "boolean", description: "return the raw body instead of text" },
      max_chars: { type: "number", description: "default 60000" } }, required: ["url"] } },
  { name: "tor_status", description: "Check that traffic leaves through Tor (asks check.torproject.org).",
    inputSchema: { type: "object", properties: {} } },
];

function userAgent(torDir) {
  let major = "153";
  try {
    const ini = fs.readFileSync(path.join(torDir, "..", "..", "application.ini"), "utf8");
    major = ini.match(/^Version=(\d+)/m)?.[1] ?? major;
  } catch {}
  return `Mozilla/5.0 (Windows NT 10.0; rv:${major}.0) Gecko/20100101 Firefox/${major}.0`;
}

function createToolHandler(config) {
  const agent = userAgent(config.torDir);
  async function torFetch(url, options, signal) {
    for (let hop = 0; hop < 6; hop++) {
      const result = await requestOnce(url, options, { socksPort: config.socksPort, userAgent: agent, signal });
      if (result.status < 300 || result.status >= 400 || !result.headers.location) return { ...result, url };
      const target = new URL(result.headers.location, url);
      if (options?.allowRedirect && !options.allowRedirect(target)) {
        throw Object.assign(new Error("unexpected search redirect"), { code: "ERR_TOR_REDIRECT_REJECTED" });
      }
      url = target.href;
      options = { headers: options?.headers, allowRedirect: options?.allowRedirect };
    }
    throw new Error("too many redirects");
  }

  return async (name, args, signal) => {
    if (name === "tor_search") {
      const fetch = (url, options) => torFetch(url, options, signal);
      const max = Math.max(1, Math.min(Math.trunc(Number(args.max_results)) || 10, 30));
      const { engine, text } = await searchDuckDuckGo(String(args.query), max, fetch);
      return `${text}\n\n(via ${engine} over Tor)`;
    }
    if (name === "tor_fetch") {
      const result = await torFetch(String(args.url), undefined, signal);
      const type = String(result.headers["content-type"] || "");
      let text = result.body.toString("utf8");
      if (!args.raw && /html|xml/i.test(type)) text = htmlToText(text);
      const max = Number(args.max_chars) || 60000;
      if (text.length > max) text = text.slice(0, max) + `\n\n[truncated: ${text.length} chars total, raise max_chars for more]`;
      return `URL: ${result.url}\nStatus: ${result.status}\nContent-Type: ${type}\n\n${text}`;
    }
    if (name === "tor_status") {
      const result = await torFetch("https://check.torproject.org/api/ip", undefined, signal);
      return result.body.toString("utf8");
    }
    throw new Error("unknown tool " + name);
  };
}

function runMcp(config) {
  const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  const lines = createInterface({ input: process.stdin, terminal: false });
  let connecting;
  let closed = false;

  function connect() {
    connecting ??= (async () => {
      const { client } = await openRuntime(config, { script, start: true });
      try {
        if (closed) throw new Error("MCP session closed");
        await client.request("session", { frontPort: config.frontPort });
        client.socket.once("close", () => { connecting = undefined; });
        return client;
      } catch (error) {
        client.close();
        connecting = undefined;
        throw error;
      }
    })().catch((error) => { connecting = undefined; throw error; });
    return connecting;
  }

  async function handle({ id, method, params }) {
    if (id === undefined) return;
    try {
      if (method === "initialize") {
        await connect();
        return send({ id, result: { protocolVersion: params?.protocolVersion || "2025-06-18", capabilities: { tools: {} },
          serverInfo: { name: "tor-web", version: "1.0.0" } } });
      }
      if (method === "ping") return send({ id, result: {} });
      if (method === "tools/list") return send({ id, result: { tools } });
      if (method === "tools/call") {
        try {
          if (!tools.some((tool) => tool.name === params?.name)) throw new Error(`unknown tool ${params?.name}`);
          const client = await connect();
          const text = await client.request("tool", {
            name: params.name, arguments: params.arguments || {}, frontPort: config.frontPort,
          });
          return send({ id, result: { content: [{ type: "text", text }] } });
        } catch (error) {
          return send({ id, result: { content: [{ type: "text", text: "Error: " + error.message }], isError: true } });
        }
      }
      send({ id, error: { code: -32601, message: "method not found: " + method } });
    } catch (error) { send({ id, error: { code: -32603, message: error.message } }); }
  }

  lines.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const message = JSON.parse(line);
      if (message && typeof message === "object") void handle(message);
    } catch (error) { log("bad message:", error.message); }
  });
  lines.once("close", () => {
    closed = true;
    void connecting?.then((client) => client.close(), () => {});
  });
  void connect().catch((error) => log(error.message));
}

try {
  const config = configuration(here);
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === "--runtime") {
    await runRuntime(config, createToolHandler(config));
  } else if (["--on", "--off", "--status", "--standby", "--check-revert"].includes(command)) {
    const ownerAt = args.indexOf("--owner");
    await runCli(command.slice(2), config, script, {
      frontPort: config.frontPort, json: args.includes("--json"),
      owner: ownerAt >= 0 ? Number(args[ownerAt + 1] || 0) : undefined,
      revertToken: command === "--check-revert" ? args[1] : undefined,
    });
  } else if (!command) {
    runMcp(config);
  } else {
    throw new Error(`unknown argument ${command}`);
  }
} catch (error) {
  log(error.message);
  process.exitCode = 1;
}
