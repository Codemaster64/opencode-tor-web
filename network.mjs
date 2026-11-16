import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

export const LOOPBACK = "127.0.0.1";

// Only the loopback connection is resolved by Node. The SOCKS request sends the destination to Tor.
export function connectSocks(socksPort, host, port, { signal, timeout = 60000 } = {}) {
  const hostname = Buffer.from(host);
  if (hostname.length === 0 || hostname.length > 255) throw new Error("invalid SOCKS destination hostname");
  signal?.throwIfAborted();

  return new Promise((resolve, reject) => {
    const socket = net.connect(socksPort, LOOPBACK);
    let authenticated = false;
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => fail(new Error("SOCKS handshake timed out")), timeout);
    const abort = () => fail(signal.reason);
    const closed = () => fail(new Error("SOCKS connection closed during setup"));
    const connected = () => socket.write(Buffer.from([5, 1, 0]));

    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.removeListener("close", closed);
      socket.removeListener("error", fail);
      socket.removeListener("connect", connected);
      socket.removeListener("data", receive);
    }

    function fail(error) {
      cleanup();
      socket.destroy();
      reject(error);
    }

    function receive(chunk) {
      buffered = Buffer.concat([buffered, chunk]);
      if (!authenticated && buffered.length >= 2) {
        if (buffered[0] !== 5 || buffered[1] !== 0) return fail(new Error("SOCKS authentication refused"));
        buffered = buffered.subarray(2);
        authenticated = true;
        socket.write(Buffer.concat([
          Buffer.from([5, 1, 0, 3, hostname.length]), hostname, Buffer.from([port >> 8, port & 255]),
        ]));
      }
      if (!authenticated || buffered.length < 5) return;
      const [version, code, reserved, type] = buffered;
      if (version !== 5 || reserved !== 0) return fail(new Error("invalid SOCKS response"));
      if (code !== 0) return fail(new Error(`Tor could not connect to ${host}:${port} (SOCKS error ${code})`));
      const length = type === 1 ? 4 : type === 4 ? 16 : type === 3 ? 1 + buffered[4] : 0;
      if (!length) return fail(new Error("invalid SOCKS address type"));
      const end = 4 + length + 2;
      if (buffered.length < end) return;

      socket.pause();
      cleanup();
      if (buffered.length > end) socket.unshift(buffered.subarray(end));
      resolve(socket);
    }

    signal?.addEventListener("abort", abort, { once: true });
    socket.once("error", fail);
    socket.once("close", closed);
    socket.once("connect", connected);
    socket.on("data", receive);
  });
}

function startTls(raw, host, signal) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ socket: raw, host, servername: net.isIP(host) ? undefined : host });
    const timer = setTimeout(() => fail(new Error("TLS handshake timed out")), 30000);
    const abort = () => fail(signal.reason);
    const closed = () => fail(new Error("TLS connection closed during setup"));
    const ready = () => { cleanup(); resolve(socket); };

    function cleanup() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      socket.removeListener("close", closed);
      socket.removeListener("error", fail);
      socket.removeListener("secureConnect", ready);
    }

    function fail(error) {
      cleanup();
      socket.destroy();
      raw.destroy();
      reject(error);
    }

    signal.addEventListener("abort", abort, { once: true });
    socket.once("error", fail);
    socket.once("close", closed);
    socket.once("secureConnect", ready);
  });
}

export async function requestOnce(url, { method = "GET", headers = {}, body } = {}, { socksPort, userAgent, signal }) {
  const target = new URL(url);
  if (!/^https?:$/.test(target.protocol)) throw new Error("only http/https URLs");
  const secure = target.protocol === "https:";
  const transport = secure ? https : http;
  const host = target.hostname.replace(/^\[(.*)\]$/, "$1");
  const port = Number(target.port || (secure ? 443 : 80));
  signal?.throwIfAborted();
  const request = new AbortController();
  const abort = () => request.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => request.abort(new Error("request timed out")), 90000);

  // A dedicated agent supplies the only socket. Node never dials or resolves the destination itself.
  const agent = new transport.Agent();
  agent.createConnection = (_options, callback) => {
    const establish = async () => {
      const socket = await connectSocks(socksPort, host, port, { signal: request.signal });
      if (request.signal.aborted) {
        socket.destroy();
        throw request.signal.reason;
      }
      return secure ? startTls(socket, host, request.signal) : socket;
    };
    establish().then((socket) => {
      callback(null, socket);
      socket.resume();
    }, callback);
  };

  try {
    return await new Promise((resolve, reject) => {
      const req = transport.request({
        method, host, port, path: target.pathname + target.search, agent, signal: request.signal,
        headers: {
          "User-Agent": userAgent, "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5", "Accept-Encoding": "gzip, deflate, br", "Connection": "close", ...headers,
        },
      }, (res) => {
        const encoding = (res.headers["content-encoding"] || "").toLowerCase();
        const decompress = { gzip: zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress };
        const streams = [res];
        if (Object.hasOwn(decompress, encoding)) streams.push(decompress[encoding]());
        const chunks = [];
        let size = 0;
        streams.push(new Writable({ write(chunk, _encoding, done) {
          size += chunk.length;
          if (size > 8e6) return done(new Error("response exceeds 8 MB"));
          chunks.push(chunk);
          done();
        } }));
        pipeline(streams, { signal: request.signal }).then(() => resolve({
          status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks),
        }), reject);
      });
      req.once("error", reject);
      req.end(body);
    });
  } finally {
    clearTimeout(timer);
    request.abort();
    signal?.removeEventListener("abort", abort);
    agent.destroy();
  }
}
