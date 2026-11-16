import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { waitForBootstrap } from "./runtime.mjs";
import { searchWeb } from "./search.mjs";

const challenge = '<form id="challenge-form"><div class="anomaly-modal">Challenge</div></form>';
const organic = '<div class="result"><a class="result__a" href="https://example.org/">Example</a></div>';
const response = (status, body, url) => ({ status, headers: {}, body: Buffer.from(body), url });
const exaReply = JSON.stringify({
  jsonrpc: "2.0", id: 1,
  result: { content: [{ type: "text", text: "Example result\nhttps://example.org/" }] },
});

test("DuckDuckGo challenge stays with DuckDuckGo unless a fallback is enabled", async () => {
  const requests = [];
  const fetch = async (url) => {
    requests.push(new URL(url).hostname);
    return response(202, challenge, url);
  };
  await assert.rejects(searchWeb("example", 3, fetch), /search challenge.*Tor Browser/i);
  assert.equal(requests.length, 1);
  assert(requests[0].endsWith(".onion"));
});

test("opt-in fallback uses Exa's hosted MCP and does not retry the challenge", async () => {
  const requests = [];
  const fetch = async (url, options) => {
    requests.push([url, options]);
    if (requests.length === 1) return response(202, challenge, url);
    assert.equal(url, "https://mcp.exa.ai/mcp");
    assert.equal(options.method, "POST");
    assert.equal(options.allowRedirect(new URL("https://example.org/")), false);
    assert.deepEqual(JSON.parse(options.body).params, { name: "web_search_exa", arguments: { query: "example", numResults: 3 } });
    return response(200, "event: message\r\ndata: " + exaReply + "\r\n\r\n", url);
  };
  const result = await searchWeb("example", 3, fetch, "exa");
  assert.equal(result.engine, "Exa (fallback)");
  assert.match(result.text, /https:\/\/example\.org/);
  assert.equal(requests.length, 2);
});

test("successful DuckDuckGo results and rejected redirects never go to Exa", async () => {
  let requests = 0;
  const result = await searchWeb("example", 3, async (url) => {
    requests++;
    return response(200, organic, url);
  }, "exa");
  assert.match(result.engine, /^DuckDuckGo/);
  assert.equal(requests, 1);
  await assert.rejects(searchWeb("example", 3, async () => {
    requests++;
    throw Object.assign(new Error("unsafe redirect"), { code: "ERR_TOR_REDIRECT_REJECTED" });
  }, "exa"), /redirected outside/);
  assert.equal(requests, 2);
});

test("a progressing Tor boot survives the stall window and completes", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const childLog = new PassThrough();
  const progress = [];
  const started = waitForBootstrap([childLog], AbortSignal.timeout(30_000), {
    stallMs: 120, maxMs: 180, onProgress: (step) => progress.push(step.percent),
  });
  childLog.write("Bootstrapped 5% (conn): Connecting to a relay\n");
  t.mock.timers.tick(110);
  childLog.write("Bootstrapped 40% (loading_keys): Loading authority key certs\n");
  t.mock.timers.tick(45);
  childLog.write("Bootstrapped 100% (done): Done\n");
  await started;
  assert.deepEqual(progress, [5, 40, 100]);
});

test("a stalled Tor boot names its last stage and duplicate logs do not extend it", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const childLog = new PassThrough();
  const started = waitForBootstrap([childLog], new AbortController().signal, { stallMs: 120, maxMs: 180 });
  const failure = assert.rejects(started, /stalled.*10%.*Connected to a relay/i);
  childLog.write("Bootstrapped 10% (conn_done): Connected to a relay\n");
  t.mock.timers.tick(110);
  childLog.write("Bootstrapped 10% (conn_done): Connected to a relay\n");
  t.mock.timers.tick(10);
  await failure;
});

test("forward progress cannot push Tor beyond the overall deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const childLog = new PassThrough();
  const started = waitForBootstrap([childLog], new AbortController().signal, { stallMs: 120, maxMs: 180 });
  const failure = assert.rejects(started, /deadline.*75%.*enough directory info/i);
  t.mock.timers.tick(110);
  childLog.write("Bootstrapped 55% (loading_descriptors): Loading relay descriptors\n");
  t.mock.timers.tick(60);
  childLog.write("Bootstrapped 75% (enough_dirinfo): Loaded enough directory info\n");
  t.mock.timers.tick(10);
  await failure;
});
