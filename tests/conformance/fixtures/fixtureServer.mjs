#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createServer } from "node:http";

/**
 * The conformance target.
 *
 * One process serves the routes the web tools are pointed at, and the same file
 * is what `writeFakeBinary` installs as a workspace's "built" binary — so
 * `uvp_run` launches it and `uvp_verify` then drives real requests at it. That
 * is what lets the launch and verification workflows be covered without a C++
 * toolchain, and it means the fixture is exercised the way a user's service is:
 * as a child process, over a socket.
 *
 * It is deliberately not a uvp artifact and deliberately not libuvcpp. What it
 * proves is the framework's own plumbing — supervision, readiness, exchange
 * recording, assertion evaluation — and nothing about the C++ it would normally
 * be running. The `toolchain` lane covers that.
 *
 * The WebSocket upgrade is implemented by hand rather than with a dependency,
 * because a library that also has to be installed is a lane that skips on a
 * fresh clone. Only what `uvp_websocket_probe` uses is implemented: text frames
 * in both directions, ping/pong, and close.
 */

const port = Number(process.env["FIXTURE_PORT"] ?? process.argv[2] ?? 0);

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const accept = (key) => createHash("sha1").update(`${key}${GUID}`).digest("base64");

const json = (response, status, body) => {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
};

/** A SOAP 1.1 response envelope, which is the shape `uvp_soap_call` parses. */
const soapEnvelope = (inner) =>
  `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>${inner}</soap:Body>
</soap:Envelope>`;

const soapFault = (code, reason) =>
  soapEnvelope(
    `<soap:Fault><faultcode>${code}</faultcode><faultstring>${reason}</faultstring></soap:Fault>`,
  );

/** Frame a payload as a single unmasked server-to-client text frame. */
const serverFrame = (payload, opcode = 0x1) => {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const header = body.length < 126 ? Buffer.from([0x80 | opcode, body.length]) : null;
  if (header !== null) return Buffer.concat([header, body]);
  const extended = Buffer.alloc(4);
  extended.writeUInt16BE(body.length, 2);
  extended[0] = 0x80 | opcode;
  extended[1] = 126;
  return Buffer.concat([extended, body]);
};

/** Decode whatever complete frames are in `buffer`, returning the remainder. */
const decodeFrames = (buffer) => {
  const frames = [];
  let offset = 0;
  for (;;) {
    if (buffer.length - offset < 2) break;
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (buffer.length - cursor < 2) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break;
      // Node cannot address more than this in a Buffer read, and the fixture
      // never sends one; refusing is better than a silently wrong length.
      if (buffer.readUInt32BE(cursor) !== 0) throw new Error("frame too large for the fixture");
      length = buffer.readUInt32BE(cursor + 4);
      cursor += 8;
    }
    let mask = null;
    if (masked) {
      if (buffer.length - cursor < 4) break;
      mask = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (buffer.length - cursor < length) break;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (mask !== null)
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    frames.push({ opcode, payload });
    offset = cursor + length;
  }
  return { frames, rest: buffer.subarray(offset) };
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${String(port)}`);
  const route = url.pathname;

  if (route === "/hello") {
    json(response, 200, { message: "Hello, AI", service: "fixture" });
    return;
  }
  if (route === "/healthz") {
    json(response, 200, { status: "ok" });
    return;
  }
  if (route === "/teapot") {
    json(response, 418, { error: "short and stout" });
    return;
  }
  if (route === "/headers") {
    json(response, 200, {
      headers: request.headers,
      marker: request.headers["x-uvp-marker"] ?? null,
    });
    return;
  }
  if (route === "/echo") {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      json(response, 200, {
        method: request.method,
        body: Buffer.concat(chunks).toString("utf8"),
        contentType: request.headers["content-type"] ?? null,
      });
    });
    return;
  }
  if (route === "/slow") {
    // Longer than a test's patience, so a timeout is exercised as a timeout.
    setTimeout(() => json(response, 200, { slow: true }), 30_000).unref();
    return;
  }
  if (route === "/redirect") {
    // `to` defaults to /hello, so the common case is a hop that lands somewhere
    // with a body to assert on.
    const target = url.searchParams.get("to") ?? "/hello";
    response.writeHead(302, { location: target, "content-length": "0" });
    response.end();
    return;
  }
  if (route === "/redirect-loop") {
    // Points at itself: how many hops were taken is then the only difference
    // between a client that stops and one that does not.
    response.writeHead(302, { location: "/redirect-loop", "content-length": "0" });
    response.end();
    return;
  }
  if (route === "/delayed") {
    // A route whose response is late by a stated amount, so a timing breakdown
    // can be checked against a number the fixture chose rather than against
    // whatever this host happened to do.
    const ms = Number(url.searchParams.get("ms") ?? "0");
    setTimeout(() => json(response, 200, { delayed: ms }), ms).unref();
    return;
  }
  if (route === "/soap") {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const response_ = soapEnvelope(
        `<AddResponse xmlns="http://uvp.test/calc"><result>42</result></AddResponse>`,
      );
      response.writeHead(200, {
        "content-type": "text/xml; charset=utf-8",
        "content-length": Buffer.byteLength(response_),
      });
      response.end(response_);
      void body;
    });
    return;
  }
  if (route === "/soap/echo") {
    // Answers with an envelope carrying the request body back verbatim, in a
    // CDATA section so no escaping stands between the bytes sent and the bytes
    // read back. This is how a caller can tell that a hand-written envelope
    // went out unaltered rather than being rebuilt from parameters.
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const received = Buffer.concat(chunks).toString("utf8");
      const body = soapEnvelope(`<Echo><![CDATA[${received}]]></Echo>`);
      response.writeHead(200, {
        "content-type": "text/xml; charset=utf-8",
        "content-length": Buffer.byteLength(body),
      });
      response.end(body);
    });
    return;
  }
  if (route === "/soap/fault") {
    // A SOAP fault is an HTTP 500 carrying a fault document: the protocol
    // outcome the tool must report as `fault`, not as a transport error.
    const body = soapFault("soap:Server", "the calculator is unavailable");
    response.writeHead(500, {
      "content-type": "text/xml; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
    return;
  }

  json(response, 404, { error: "no such route", route });
});

server.on("upgrade", (request, socket) => {
  const key = request.headers["sec-websocket-key"];
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${String(port)}`);
  if (url.pathname !== "/ws" || typeof key !== "string") {
    socket.destroy();
    return;
  }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept(key)}\r\n\r\n`,
  );

  // The greeting makes the probe's "did the far end say anything" question
  // answerable without sending a frame first, which matters because a frame uvp
  // sent is not evidence that the server spoke.
  socket.write(serverFrame("fixture: greeting"));

  let buffered = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    let decoded;
    try {
      decoded = decodeFrames(buffered);
    } catch {
      socket.destroy();
      return;
    }
    buffered = Buffer.from(decoded.rest);
    for (const frame of decoded.frames) {
      if (frame.opcode === 0x8) {
        socket.write(serverFrame(Buffer.alloc(0), 0x8));
        socket.end();
        return;
      }
      if (frame.opcode === 0x9) {
        socket.write(serverFrame(frame.payload, 0xa));
        continue;
      }
      if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        socket.write(serverFrame(`fixture: ${frame.payload.toString("utf8")}`));
      }
    }
  });
  socket.on("error", () => socket.destroy());
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  // The port is printed rather than only bound, because the tests ask for port 0
  // and need to learn what they got without racing a fixed number.
  process.stdout.write(`fixture listening ${String(address.port)}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
