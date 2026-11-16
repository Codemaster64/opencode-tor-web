import assert from "node:assert/strict";
import test from "node:test";
import { searchDuckDuckGo } from "./duckduckgo.mjs";

const onion = "duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion";
const publicHost = "html.duckduckgo.com";
const result = (content) => `<div class="result results_links web-result"><div class="links_main">${content}</div></div>`;
const response = (url, html, status = 200) => ({
  url: String(url), status, body: Buffer.from(html), headers: { "content-type": "text/html; charset=UTF-8" },
});

// Distilled from the HTML search layout. URLs and text are local fixtures.
const validResults = `<div id="links" class="results">
  <!-- <div class="result"><a href="https://bad.test" class="result__a">Comment</a></div> -->
  <script>const fake = '<a class="result__a" href="https://bad.test">Script</a>';</script>
  ${result(`<h2 class="result__title"><a data-label="a > b"
    href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example%2Fguide%3Fname%3DA%2520B%26n%3D1&amp;rut=example"
    class="result__a">Tor &amp; <b>Privacy</b> &#x1F512;</a></h2>
    <a class="result__snippet" href="https://docs.example/guide">A <b>guide</b>&nbsp;from &#84;or &#x110000; &mdash; revised.</a>`)}
  ${result(`<a class='result__a extra' href='https://news.example/'>Second result</a>
    <div class=result__snippet>News<br>story</div>`)}
  ${result(`<a class=result__a href=https://more.example/>Third result</a>`)}
</div>`;

test("requests the v3 onion over the supplied transport and formats the first N organic results", async () => {
  const query = "tor & café?#";
  const calls = [];
  const value = await searchDuckDuckGo(query, 2, async (input, options) => {
    const url = new URL(input);
    calls.push(url.hostname);
    assert.equal(url.protocol, "https:");
    assert.match(url.pathname, /^\/html\/?$/);
    assert.equal(url.searchParams.get("q"), query);
    assert.equal(options.allowRedirect(new URL(`https://${publicHost}/html/`)), true);
    assert.equal(options.allowRedirect(new URL("https://third-party.example/search")), false);
    assert.equal(options.allowRedirect(new URL(`http://${publicHost}/html/`)), false);
    return response(url, validResults);
  });

  assert.deepEqual(calls, [onion]);
  assert.equal(value.engine, "DuckDuckGo (.onion)");
  assert.equal(value.text, [
    "1. Tor & Privacy 🔒\nhttps://docs.example/guide?name=A%20B&n=1\nA guide from Tor � — revised.",
    "2. Second result\nhttps://news.example/\nNews story",
  ].join("\n\n"));
});

test("skips ads, unsafe URLs, and duplicate destinations without borrowing another result's snippet", async () => {
  const html = `<div id="links" class="results">
    <div class="result result--ad"><a class="result__a" href="https://sponsor.example/">Sponsored</a></div>
    ${result(`<a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=ad.example">Ad</a>`)}
    ${result(`<a class="result__a" href="/l/?uddg=javaScript%3Aalert%281%29">Script</a>`)}
    ${result(`<a class="result__a" href="https://login:password@safe.example/">Credential</a>`)}
    ${result(`<a class="result__a" href="/l/?uddg=%EA%ZZ">Invalid redirect</a>`)}
    ${result(`<a class="result__a" href="https://safe.example/">No snippet</a>`)}
    ${result(`<a class="result__snippet" href="https://discard.example/">Orphan snippet</a>`)}
    ${result(`<a class="result__a" href="https://safe.example/">Duplicate</a>`)}
    ${result(`<a class="result__a" href="https://second.example/l/?uddg=anything">Direct</a>
      <a class="result__snippet" href="https://second.example/">Second snippet</a>`)}
  </div>`;

  const value = await searchDuckDuckGo("query", 2, (url) => response(url, html));
  assert.equal(value.text, "1. No snippet\nhttps://safe.example/\n\n2. Direct\nhttps://second.example/l/?uddg=anything\nSecond snippet");
});

test("reports DuckDuckGo's explicit no-results page as a successful empty search", async () => {
  const calls = [];
  const value = await searchDuckDuckGo("zzzxxy", 3, (url) => {
    calls.push(new URL(url).hostname);
    return response(url, `<div class="no-results__message"><h1>No results found for <strong>zzzxxy</strong></h1></div>`);
  });

  assert.deepEqual(calls, [onion]);
  assert.equal(value.text, "No DuckDuckGo results found.");
});

test("tries public DuckDuckGo over the same transport when the onion service is unreachable", async () => {
  const calls = [];
  const value = await searchDuckDuckGo("same query", 1, async (url) => {
    const request = new URL(url);
    calls.push([request.hostname, request.searchParams.get("q")]);
    if (request.hostname === onion) throw new Error("onion service unavailable");
    return response(url, validResults);
  });

  assert.deepEqual(calls, [[onion, "same query"], [publicHost, "same query"]]);
  assert.equal(value.engine, "DuckDuckGo");
  assert.match(value.text, /^1\./);
  assert.doesNotMatch(value.text, /\n2\./);
});

test("uses the final provider origin for result attribution", async () => {
  const value = await searchDuckDuckGo("query", 1,
    () => response(`https://${publicHost}/html/`, validResults));
  assert.equal(value.engine, "DuckDuckGo");
});

test("does not request the public endpoint twice when the onion redirects there", async () => {
  const calls = [];
  await assert.rejects(searchDuckDuckGo("query", 1, (url) => {
    calls.push(new URL(url).hostname);
    return response("https://" + publicHost + "/html/?q=query", "Service Unavailable", 503);
  }), /search unavailable over Tor \(DuckDuckGo HTTP 503\)/);
  assert.deepEqual(calls, [onion]);
});

test("reports a denied off-provider redirect without repeating the query", async () => {
  const calls = [];
  await assert.rejects(searchDuckDuckGo("!example query", 1, (url) => {
    calls.push(new URL(url).hostname);
    throw Object.assign(new Error("redirect destination rejected"), { code: "ERR_TOR_REDIRECT_REJECTED" });
  }), /DuckDuckGo.*redirected outside the allowed search origins/);
  assert.deepEqual(calls, [onion]);
});

test("reports a challenge or access denial without requesting another endpoint", async (t) => {
  const pages = [
    [200, `<form id='challenge-form' action='//duckduckgo.com/anomaly.js'>Please complete the following challenge</form>`],
    [202, "Accepted"],
    [403, "Forbidden"],
    [429, "Too Many Requests"],
    [503, `<div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>`],
  ];
  for (const [status, body] of pages) {
    await t.test(`HTTP ${status}`, async () => {
      const calls = [];
      await assert.rejects(searchDuckDuckGo("query", 2, (url) => {
        calls.push(new URL(url).hostname);
        return response(url, body, status);
      }), /DuckDuckGo.*(?:blocked|challenge|denied|limited)/i);
      assert.deepEqual(calls, [onion]);
    });
  }
});

test("explains availability and recognition failures from both DuckDuckGo endpoints", async () => {
  const calls = [];
  await assert.rejects(searchDuckDuckGo("query", 2, (url) => {
    const host = new URL(url).hostname;
    calls.push(host);
    return host === onion ? response(url, "Service Unavailable", 503) : response(url, "<h1>Unexpected layout</h1>");
  }), /DuckDuckGo.*unavailable.*\.onion.*HTTP 503.*(?:recognize|search results)/i);
  assert.deepEqual(calls, [onion, publicHost]);
});
