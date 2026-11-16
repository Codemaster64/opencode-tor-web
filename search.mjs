import { searchDuckDuckGo } from "./duckduckgo.mjs";

const EXA_MCP = "https://mcp.exa.ai/mcp";
const FALLBACK_CODES = new Set(["ERR_DDG_CHALLENGE", "ERR_DDG_UNAVAILABLE"]);

function exaResult(body) {
  const raw = body.toString("utf8").trim();
  const messages = raw.startsWith("{") ? [raw] : raw.split(/\r?\n\r?\n/)
    .map((event) => event.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n"))
    .filter(Boolean);
  for (const message of messages) {
    try {
      const reply = JSON.parse(message);
      if (reply.jsonrpc === "2.0" && reply.id === 1) return reply;
    } catch {
      // Ignore frames that are not the tool response.
    }
  }
}

async function searchExa(query, numResults, torFetch) {
  const body = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "web_search_exa", arguments: { query, numResults } },
  });
  const response = await torFetch(EXA_MCP, {
    method: "POST", body, allowRedirect: () => false,
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
  });
  if (response.status !== 200) throw new Error("Exa MCP returned HTTP " + response.status);
  const reply = exaResult(response.body);
  const text = Array.isArray(reply?.result?.content)
    ? reply.result.content.filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text).join("\n").trim()
    : "";
  if (!text || reply.error || reply.result.isError) throw new Error("Exa MCP did not return search results");
  return { engine: "Exa (fallback)", text };
}

export async function searchWeb(query, max, torFetch, fallback = "off") {
  try {
    return await searchDuckDuckGo(query, max, torFetch);
  } catch (error) {
    if (!FALLBACK_CODES.has(error.code)) throw error;
    if (fallback === "exa") {
      try {
        return await searchExa(query, max, torFetch);
      } catch (exaError) {
        throw new Error(error.message + " Exa fallback failed: " + exaError.message, { cause: exaError });
      }
    }
    const hint = error.code === "ERR_DDG_CHALLENGE" ? " Search manually in Tor Browser, or enable the Exa fallback." : " The Exa fallback is off.";
    throw new Error(error.message + hint, { cause: error });
  }
}
