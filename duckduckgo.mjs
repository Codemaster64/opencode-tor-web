const ONION = "duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion";
const PUBLIC_HTML = "html.duckduckgo.com";
const PROVIDER_HOSTS = new Set([ONION, PUBLIC_HTML, "duckduckgo.com"]);
const ACCESS_DENIED = new Set([401, 403, 407, 429, 451]);
const ENTITIES = {
  amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"',
  copy: "©", reg: "®", trade: "™", bull: "•", middot: "·", hellip: "…",
  mdash: "—", ndash: "–", laquo: "«", raquo: "»", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
};

function decodeEntities(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z][\da-z]*);/gi, (original, entity) => {
    if (entity[0] !== "#") return Object.hasOwn(ENTITIES, entity) ? ENTITIES[entity] : original;
    const hex = entity[1].toLowerCase() === "x";
    const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "\uFFFD";
    return String.fromCodePoint(code);
  });
}

function attributes(text) {
  const values = new Map();
  for (const [, name, double, single, bare] of text.matchAll(/([^\s=/'">]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    const key = name.toLowerCase();
    if (!values.has(key)) values.set(key, decodeEntities(double ?? single ?? bare ?? ""));
  }
  return values;
}

function allowRedirect(target) {
  return target.protocol === "https:" && PROVIDER_HOSTS.has(target.hostname)
    && !target.port && !target.username && !target.password;
}

function resultUrl(href, base) {
  if (!href || /[\\\x00-\x20\x7f]/.test(href)) return;
  try {
    let target = new URL(href, base);
    if (target.username || target.password || !/^https?:$/.test(target.protocol)) return;
    if (PROVIDER_HOSTS.has(target.hostname) && /^\/l\/?$/.test(target.pathname)) {
      const destination = target.searchParams.get("uddg");
      if (!destination || !/^https?:\/\//i.test(destination) || /[\\\x00-\x20\x7f]/.test(destination)) return;
      target = new URL(destination);
    } else if (!/^(?:https?:)?\/\//i.test(href)) {
      return;
    }
    if (target.username || target.password || !/^https?:$/.test(target.protocol)) return;
    if (PROVIDER_HOSTS.has(target.hostname) && /^\/(?:y\.js|l\/?)$/.test(target.pathname)) return;
    return target.href;
  } catch {
    // A malformed destination does not invalidate neighboring results.
  }
}

// DuckDuckGo HTML uses a result div around titled links and their optional snippets.
// Tokenize tags (including quoted attributes), ignoring comments and non-visible sections.
const TAGS = /<!--[\s\S]*?(?:-->|$)|<(script|style|noscript|template)(?=[\s/>])(?:"[^"]*"|'[^']*'|[^>"'])*>[\s\S]*?(?:<\/\1\s*>|$)|<(\/?)([a-z][\w:-]*)(?=[\s/>])((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi;

function parseResults(html, base, limit) {
  const results = [];
  const seen = new Set();
  let noResults = false;
  let blocked = false;
  let depth = 0;
  let offset = 0;
  let result;
  let capture;

  for (const token of html.matchAll(TAGS)) {
    if (capture) capture.text += html.slice(offset, token.index);
    offset = token.index + token[0].length;
    const [, , closing, tag, attributeText] = token;
    if (!tag) continue;
    const name = tag.toLowerCase();

    if (closing) {
      if (capture?.tag === name && capture.depth === depth) {
        result[capture.field] = decodeEntities(capture.text).replace(/[\s\x00-\x1f\x7f]+/g, " ").trim();
        capture = undefined;
      }
      if (name === "div") {
        if (result?.depth === depth) {
          if (results.length < limit && result.url && result.title && !seen.has(result.url)) {
            seen.add(result.url);
            results.push(result);
          }
          result = undefined;
          capture = undefined;
        }
        depth = Math.max(0, depth - 1);
      }
      continue;
    }

    if (name === "div") depth++;
    if (name === "br" && capture) capture.text += " ";
    const attrs = attributes(attributeText);
    const classes = (attrs.get("class") ?? "").split(/\s+/);
    if (classes.includes("no-results__message")) noResults = true;
    if (attrs.get("id") === "challenge-form" || classes.some((value) => value.startsWith("anomaly-modal"))) blocked = true;
    if (name === "div" && classes.includes("result")) {
      capture = undefined;
      result = classes.includes("result--ad") ? undefined : { depth };
    }
    if (!result) continue;

    if (name === "a" && classes.includes("result__a")) {
      result.url = resultUrl(attrs.get("href"), base);
      capture = { field: "title", tag: name, depth, text: "" };
    } else if (classes.includes("result__snippet")) {
      capture = { field: "snippet", tag: name, depth, text: "" };
    }
  }

  return { results, noResults, blocked };
}

export async function searchDuckDuckGo(query, max, torFetch) {
  const limit = Math.max(1, Math.min(Math.floor(Number(max)) || 10, 30));
  const failures = [];
  const searched = new Set();
  for (const [host, engine] of [[ONION, "DuckDuckGo (.onion)"], [PUBLIC_HTML, "DuckDuckGo"]]) {
    if (searched.has(host)) continue;
    const url = new URL("https://" + host + "/html/");
    url.searchParams.set("q", query);
    let response;
    try {
      response = await torFetch(url.href, { allowRedirect });
    } catch (error) {
      if (error.code === "ERR_TOR_REDIRECT_REJECTED") {
        throw new Error(engine + " redirected outside the allowed search origins.", { cause: error });
      }
      failures.push(engine + " " + error.message);
      continue;
    }

    const finalUrl = new URL(response.url ?? url.href);
    if (!allowRedirect(finalUrl)) throw new Error(engine + " redirected outside the allowed search origins.");
    if (/^\/html\/?$/.test(finalUrl.pathname) && finalUrl.searchParams.get("q") === String(query)) {
      searched.add(finalUrl.hostname);
    }
    const source = finalUrl.hostname === ONION ? "DuckDuckGo (.onion)" : "DuckDuckGo";
    const { status, body } = response;
    if (ACCESS_DENIED.has(status)) throw new Error(source + " denied access (HTTP " + status + ").");
    if (status === 202) throw new Error(source + " returned a search challenge (HTTP 202).");

    const { results, noResults, blocked } = parseResults(body.toString("utf8"), finalUrl, limit);
    if (blocked) throw new Error(source + " returned a search challenge (HTTP " + status + ").");
    if (status !== 200) {
      failures.push(source + " HTTP " + status);
      continue;
    }
    if (results.length) {
      const text = results.map(({ title, url, snippet }, i) =>
        [(i + 1) + ". " + title, url, snippet].filter(Boolean).join("\n")).join("\n\n");
      return { engine: source, text };
    }
    if (noResults) return { engine: source, text: "No DuckDuckGo results found." };
    failures.push(source + " did not return recognizable search results");
  }

  throw new Error("DuckDuckGo search unavailable over Tor (" + failures.join("; ") + ").");
}
