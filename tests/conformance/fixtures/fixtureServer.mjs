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
  if (body.length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, body.length]), body]);
  if (body.length <= 0xffff) {
    const extended = Buffer.alloc(4);
    extended.writeUInt16BE(body.length, 2);
    extended[0] = 0x80 | opcode;
    extended[1] = 126;
    return Buffer.concat([extended, body]);
  }
  const extended = Buffer.alloc(10);
  extended[0] = 0x80 | opcode;
  extended[1] = 127;
  extended.writeBigUInt64BE(BigInt(body.length), 2);
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

/**
 * A route whose status the caller chooses, because it is the one thing a replay
 * cannot produce from a fixture whose answers are fixed: the same request to the
 * same route has to answer differently the second time. The body is constant, so
 * a caller can tell a status difference from a body one.
 */
const statusRoute = (request, response) => {
  const asked = Number(request.headers["x-uvp-status"] ?? "200");
  const status = Number.isInteger(asked) && asked >= 100 && asked <= 599 ? asked : 200;
  json(response, status, { route: "/status" });
};

/**
 * The SOAP routes, whose bodies are XML envelopes rather than JSON. Returns false
 * for a route that is not one of them, so the caller can keep looking.
 */
const soapRoutes = (route, request, response) => {
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
    return true;
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
    return true;
  }
  if (route === "/soap/boundary-envelope") {
    // The three-byte character sits wholly below the cut, which then lands inside
    // the closing tag: the envelope a caller receives is a prefix, and every
    // character in it is whole. Nothing is lost, so an answer that reported a
    // lossy decode here would be blaming a cap for a cut it made cleanly.
    const body = soapEnvelopeWithCharacterAt(64 * 1024 - 4);
    response.writeHead(200, {
      "content-type": "text/xml; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
    return true;
  }
  if (route === "/soap/cut-envelope") {
    // The same character one byte higher, so the cut lands inside it: the first
    // byte is kept and the other two are gone. That is the loss a cut on byte
    // boundaries leaves and the one it cannot avoid — the case a cut on
    // characters cannot produce at all, and so cannot report.
    const body = soapEnvelopeWithCharacterAt(64 * 1024 - 1);
    response.writeHead(200, {
      "content-type": "text/xml; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
    return true;
  }
  if (route === "/soap/fault-not-utf8") {
    // A fault envelope carrying a byte no text can. Both facts have to survive
    // together: the fault is still the call's outcome, and the envelope handed
    // over is not the bytes it came from. The invalid byte is substituted into a
    // control character's place so the envelope keeps the shape the other SOAP
    // routes are written with.
    const body = Buffer.from(
      soapEnvelope(
        "<soap:Fault><faultcode>soap:Server</faultcode>" +
          "<faultstring>the calculator is \u0001 unavailable</faultstring></soap:Fault>",
      ),
      "utf8",
    );
    body[body.indexOf(0x01)] = 0xff;
    response.writeHead(500, {
      "content-type": "text/xml; charset=utf-8",
      "content-length": String(body.length),
    });
    response.end(body);
    return true;
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
    return true;
  }
  return false;
};

/**
 * A SOAP envelope with a three-byte character at a chosen byte offset.
 *
 * The offset is what decides whether a byte cut lands inside that character or
 * after it, which is the distinction the two routes below exist to make: a cut
 * inside one loses its last bytes, and a cut after it loses nothing even though
 * the envelope a caller receives is a prefix of what was sent. The wrapper is
 * measured rather than assumed, so a change to the envelope's shape moves the
 * padding with it instead of quietly moving the cut onto a boundary.
 */
const soapEnvelopeWithCharacterAt = (offset) => {
  const payload = "<Long></Long>";
  const [head, tail] = soapEnvelope(payload).split(payload);
  const open = "<Long>";
  const pad = offset - Buffer.byteLength(head, "utf8") - open.length;
  return `${head}${open}${"x".repeat(pad)}中</Long>${tail}`;
};

/**
 * The routes whose bodies are bytes rather than characters.
 *
 * One group because they are one question asked three ways — is the text the
 * client hands a caller this body's text? — and because the answer differs only
 * in what the client is entitled to blame: the peer for `/not-utf8` and
 * `/half-character`, its own cap for `/multibyte`. Returns false for a route that
 * is not one of them, so the caller can keep looking.
 */
const byteRoutes = (route, response) => {
  if (route === "/not-utf8") {
    // A peer that declares text and sends bytes that are not: `ff fe` begin no
    // UTF-8 sequence at all, so the decode replaces them and the tool has to say
    // that the text it hands over is not this body.
    const body = Buffer.concat([Buffer.from("Hi"), Buffer.from([0xff, 0xfe]), Buffer.from("!")]);
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": String(body.length),
    });
    response.end(body);
    return true;
  }
  if (route === "/multibyte") {
    // Three-byte characters and nothing else, so a byte-count cap lands inside
    // one for every length that is not a multiple of three. That is what lets a
    // cap's loss be told from a peer's, and a cap that lands *between* two
    // characters be told from both.
    const body = Buffer.from("中".repeat(16), "utf8");
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": String(body.length),
    });
    response.end(body);
    return true;
  }
  if (route === "/half-character") {
    // A body that stops inside a three-byte character and that nothing cut: the
    // peer sent seven bytes and said so. These are the same bytes a byte-count
    // cap leaves behind, which is why the client cannot answer from the bytes
    // alone, and this route is the one that makes a client which always answers
    // "truncated" wrong about a peer that is the one at fault.
    const body = Buffer.from("中".repeat(3), "utf8").subarray(0, 7);
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": String(body.length),
    });
    response.end(body);
    return true;
  }
  return false;
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
  if (route === "/status") {
    statusRoute(request, response);
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
  if (route === "/bulk") {
    // A body whose length the caller names and whose content is predictable, so
    // a truncated record can be told from a whole one by looking at the bytes
    // rather than only at a counter.
    const bytes = Number(url.searchParams.get("bytes") ?? "0");
    const body = Buffer.alloc(bytes, 0x61);
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(body.length),
    });
    response.end(body);
    return;
  }
  if (byteRoutes(route, response)) return;
  if (soapRoutes(route, request, response)) return;

  json(response, 404, { error: "no such route", route });
});

server.on("upgrade", (request, socket) => {
  // First, before any branch below can return. An upgrade hands the socket over
  // raw, so the http server's own error handling does not cover it, and a client
  // that disappears mid-connection then arrives here as an `error` event with no
  // listener — an uncaught exception that kills the fixture and takes every later
  // test in the lane with it. The paths a vanishing client is most likely to be
  // on are the early returns, which is why this is not attached further down.
  socket.on("error", () => socket.destroy());

  const key = request.headers["sec-websocket-key"];
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${String(port)}`);
  if (url.pathname !== "/ws" || typeof key !== "string") {
    socket.destroy();
    return;
  }
  // Query parameters steer the connection's timing and its ending, so a test can
  // ask for the shape it needs to observe rather than inferring it from how the
  // fixture happens to behave.
  const echoDelayMs = Number(url.searchParams.get("echo_delay_ms") ?? "0");
  const closeCode = url.searchParams.get("close_code");
  const closeReason = url.searchParams.get("close_reason") ?? "";

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept(key)}\r\n\r\n`,
  );

  const rawTextFrame = url.searchParams.get("raw_text_frame");
  if (
    rawTextFrame === "invalid-utf8" ||
    rawTextFrame === "truncated" ||
    rawTextFrame === "truncated-valid"
  ) {
    const payload =
      rawTextFrame === "invalid-utf8"
        ? Buffer.from([0x68, 0x69, 0xff, 0xfe])
        : rawTextFrame === "truncated"
          ? Buffer.from("中".repeat(30_000), "utf8")
          : Buffer.from("é".repeat(45_000), "utf8");
    setImmediate(() => {
      socket.write(serverFrame(payload));
      socket.write(serverFrame(Buffer.alloc(0), 0x8));
      socket.end();
    });
    return;
  }

  if (url.searchParams.get("hangup") === "1") {
    // A far end that drops the connection with no closing handshake. This is the
    // case a probe must report as an observation: the peer left, and there is no
    // close code because no close frame was sent.
    socket.end();
    return;
  }

  // The greeting makes the probe's "did the far end say anything" question
  // answerable without sending a frame first, which matters because a frame uvp
  // sent is not evidence that the server spoke.
  socket.write(serverFrame("fixture: greeting"));

  if (closeCode !== null) {
    // The server closes first, with a code and a reason of the caller's choosing.
    // A probe that reported only "the connection ended" would lose both.
    const reason = Buffer.from(closeReason, "utf8");
    const payload = Buffer.alloc(2 + reason.byteLength);
    payload.writeUInt16BE(Number(closeCode), 0);
    reason.copy(payload, 2);
    // After the greeting, so the close is a separate event on the socket rather
    // than being coalesced into the upgrade's first read.
    setTimeout(() => {
      socket.write(serverFrame(payload, 0x8));
      socket.end();
    }, 20);
    return;
  }

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
        const reply = serverFrame(`fixture: ${frame.payload.toString("utf8")}`);
        if (echoDelayMs > 0) setTimeout(() => socket.write(reply), echoDelayMs);
        else socket.write(reply);
      }
    }
  });
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
