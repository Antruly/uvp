import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHash, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import type { IncomingMessage, ClientRequest } from "node:http";
import type { Socket } from "node:net";

/**
 * A WebSocket client, written against RFC 6455 directly.
 *
 * There is no WebSocket in Node's standard library, and the usual answer is a
 * dependency. uvp does not take one here for a specific reason: a probe whose
 * job is to report what the peer actually sent must be able to report the
 * handshake *response* even when the upgrade is rejected. Client libraries
 * typically surface a rejected upgrade as a generic connection error, which
 * collapses "the server answered 403 with a reason" and "nothing is listening"
 * into the same failure — exactly the distinction a caller is debugging.
 *
 * What is implemented is the subset a probe needs: the opening handshake, text
 * and binary frames in both directions, continuation frames, ping/pong, and the
 * closing handshake. Extensions are not negotiated and permessage-deflate is not
 * requested, so every payload on the wire is the payload the caller asked for.
 */

export type WebSocketOpcode = "continuation" | "text" | "binary" | "close" | "ping" | "pong";

export interface WebSocketFrame {
  readonly direction: "sent" | "received";
  readonly opcode: WebSocketOpcode;
  readonly bytes: number;
  readonly payload: Buffer;
  /**
   * Milliseconds from the start of the probe to this frame.
   *
   * Stamped here, where the frame is, because it is the only place that knows.
   * The probe's total duration is not this: reporting it for every frame made a
   * greeting that arrived at 1 ms and a reply that arrived at 900 ms look
   * simultaneous, which is the opposite of what a frame log is for.
   */
  readonly atMs: number;
  /** True when the frame stopped being a message and became an error. */
  readonly protocolError: boolean;
}

export interface WebSocketHandshake {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly negotiatedSubprotocol: string | undefined;
}

export interface WebSocketProbeOptions {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly subprotocols: readonly string[];
  readonly verifyTls: boolean;
  readonly maxFrames: number;
  readonly idleTimeoutMs: number;
  readonly send: readonly {
    readonly payload: string;
    readonly encoding: "utf8" | "base64";
    readonly waitMs: number;
  }[];
  readonly signal?: AbortSignal | undefined;
}

export interface WebSocketProbeResult {
  readonly handshake: WebSocketHandshake;
  readonly upgraded: boolean;
  readonly frames: readonly WebSocketFrame[];
  readonly close:
    | { readonly code: number | undefined; readonly reason: string | undefined }
    | undefined;
  readonly closedCleanly: boolean;
  readonly elapsedMs: number;
  /** A transport failure is reported here, never as a thrown exception. */
  readonly transportError: string | undefined;
  /**
   * True when the caller's signal is what ended this probe.
   *
   * A flag rather than a reading of the signal by whoever receives the result:
   * a probe that finished on its own and a signal that aborts a moment later are
   * two different runs, and only the client knows which one this was. It is also
   * not the same fact as `transportError` being set — a peer that answered a
   * rejected upgrade and a peer that never answered at all are told apart by
   * everything else here, not by this.
   */
  readonly cancelled: boolean;
}

const OPCODE_BY_CODE: Record<number, WebSocketOpcode> = {
  0x0: "continuation",
  0x1: "text",
  0x2: "binary",
  0x8: "close",
  0x9: "ping",
  0xa: "pong",
};

const CODE_BY_OPCODE: Record<"text" | "binary" | "close" | "ping" | "pong", number> = {
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
};

/**
 * The `Sec-WebSocket-Accept` value for a key, per RFC 6455 §4.2.2.
 *
 * Checking it is not ceremony: a service behind a proxy can answer 101 with a
 * body that is not a WebSocket at all, and without this check the first frame
 * parse would report a protocol error against a server that never spoke the
 * protocol.
 */
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * Why a probe the caller stopped reading ended, in the words the record uses.
 *
 * A sentence, because this string is what `transport_error` carries and what a
 * capture stores as its `error`: a reader who meets the bare word "cancelled"
 * there cannot tell whether the peer cancelled, the client did, or the caller
 * did — and only the last of those means the run established nothing.
 */
const CANCELLED_TRANSPORT = "the call was cancelled, so the probe stopped reading";

const acceptFor = (key: string): string =>
  createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");

/**
 * Encode one frame. Client frames are always masked, as the RFC requires.
 *
 * Three parts, in this order: FIN and opcode, the length with the mask bit set,
 * the four-byte mask key, then the masked payload. The mask key sits *after* the
 * length field, so the header is the length field plus four bytes — the two
 * sizes are kept apart below because conflating them allocates a header too
 * small to hold its own mask.
 */
export const encodeFrame = (
  opcode: "text" | "binary" | "close" | "ping" | "pong",
  payload: Buffer,
): Buffer => {
  const mask = randomBytes(4);
  const length = payload.byteLength;
  const lengthFieldBytes = length < 126 ? 2 : length < 65_536 ? 4 : 10;
  const header = Buffer.alloc(lengthFieldBytes + mask.byteLength);
  header[0] = 0x80 | CODE_BY_OPCODE[opcode];
  if (length < 126) {
    header[1] = 0x80 | length;
  } else if (length < 65_536) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  mask.copy(header, lengthFieldBytes);
  const masked = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) {
    masked[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
  }
  return Buffer.concat([header, masked]);
};

interface ParsedFrame {
  readonly fin: boolean;
  readonly opcode: WebSocketOpcode | undefined;
  readonly payload: Buffer;
  readonly consumed: number;
}

/**
 * Parse one frame from the front of `buffer`, or report that more bytes are
 * needed.
 *
 * The `undefined` opcode is a protocol violation rather than a short read: a
 * reserved opcode has no meaning, and continuing to read frames after one would
 * be reading noise and calling it messages.
 */
export const parseFrame = (buffer: Buffer): ParsedFrame | undefined => {
  if (buffer.byteLength < 2) return undefined;
  const first = buffer[0] ?? 0;
  const second = buffer[1] ?? 0;
  const fin = (first & 0x80) !== 0;
  const opcode = OPCODE_BY_CODE[first & 0x0f];
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.byteLength < offset + 2) return undefined;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.byteLength < offset + 8) return undefined;
    const wide = buffer.readBigUInt64BE(offset);
    // A payload this large cannot be buffered anyway; refusing it here keeps the
    // allocation below from being driven by a hostile length field.
    if (wide > 8n * 1024n * 1024n) return undefined;
    length = Number(wide);
    offset += 8;
  }
  let maskKey: Buffer | undefined;
  if (masked) {
    if (buffer.byteLength < offset + 4) return undefined;
    maskKey = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.byteLength < offset + length) return undefined;
  const raw = buffer.subarray(offset, offset + length);
  const payload = Buffer.alloc(length);
  if (maskKey === undefined) {
    raw.copy(payload);
  } else {
    for (let index = 0; index < length; index += 1) {
      payload[index] = (raw[index] ?? 0) ^ (maskKey[index % 4] ?? 0);
    }
  }
  return { fin, opcode, payload, consumed: offset + length };
};

const closeCodeOf = (payload: Buffer): number | undefined =>
  payload.byteLength >= 2 ? payload.readUInt16BE(0) : undefined;

const closeReasonOf = (payload: Buffer): string | undefined =>
  payload.byteLength > 2 ? payload.subarray(2).toString("utf8") : undefined;

/**
 * Open a WebSocket, exchange the requested frames, and close.
 *
 * Every failure mode returns a result. A caller that asked "does this endpoint
 * upgrade" needs the handshake status whether the answer was 101 or 500, and a
 * transport error is more useful as a field than as a rejected promise.
 */
export const probeWebSocket = async (
  options: WebSocketProbeOptions,
): Promise<WebSocketProbeResult> => {
  const started = Date.now();
  const url = new URL(options.url);
  const secure = url.protocol === "wss:";
  const requestFn = secure ? httpsRequest : httpRequest;
  const key = randomBytes(16).toString("base64");

  const frames: WebSocketFrame[] = [];
  const push = (frame: Omit<WebSocketFrame, "atMs">): void => {
    frames.push({ ...frame, atMs: Date.now() - started });
  };

  return await new Promise<WebSocketProbeResult>((resolve) => {
    let settled = false;
    let socket: Socket | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    let handshake: WebSocketHandshake | undefined;
    let closeInfo: { code: number | undefined; reason: string | undefined } | undefined;
    let closedCleanly = false;
    let transportError: string | undefined;
    let cancelled = false;
    let receivedFrames = 0;
    let sentIndex = 0;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      socket?.destroy();
      resolve({
        handshake: handshake ?? {
          status: 0,
          statusText: "",
          headers: {},
          negotiatedSubprotocol: undefined,
        },
        upgraded: handshake?.status === 101,
        frames,
        close: closeInfo,
        closedCleanly,
        elapsedMs: Date.now() - started,
        transportError,
        cancelled,
      });
    };

    const armIdleTimer = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(finish, options.idleTimeoutMs);
      // An idle probe must not be the reason a CLI invocation hangs on exit.
      idleTimer.unref?.();
    };

    const onResponse = (response: IncomingMessage): void => {
      // A non-101 response is the answer, not a failure. Its headers and status
      // are the most useful thing this probe can return.
      handshake = {
        status: response.statusCode ?? 0,
        statusText: response.statusMessage ?? "",
        headers: Object.fromEntries(
          Object.entries(response.headers).flatMap(([name, value]) =>
            value === undefined
              ? []
              : [[name.toLowerCase(), Array.isArray(value) ? value.join(", ") : value]],
          ),
        ),
        negotiatedSubprotocol: undefined,
      };
      response.resume();
      response.on("end", finish);
    };

    const request: ClientRequest = requestFn({
      method: "GET",
      hostname: url.hostname,
      port: url.port === "" ? (secure ? 443 : 80) : Number(url.port),
      path: `${url.pathname}${url.search}`,
      headers: {
        ...options.headers,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": key,
        "sec-websocket-version": "13",
        ...(options.subprotocols.length === 0
          ? {}
          : { "sec-websocket-protocol": options.subprotocols.join(", ") }),
      },
      ...(secure ? { rejectUnauthorized: options.verifyTls } : {}),
    });

    request.on("response", onResponse);
    request.on("error", (error: Error) => {
      transportError = error.message;
      finish();
    });

    request.on("upgrade", (response, upgradedSocket, head) => {
      socket = upgradedSocket;
      const headers = Object.fromEntries(
        Object.entries(response.headers).flatMap(([name, value]) =>
          value === undefined
            ? []
            : [[name.toLowerCase(), Array.isArray(value) ? value.join(", ") : value]],
        ),
      );
      const expected = acceptFor(key);
      const accepted = headers["sec-websocket-accept"];
      handshake = {
        status: response.statusCode ?? 101,
        statusText: response.statusMessage ?? "Switching Protocols",
        headers,
        negotiatedSubprotocol: headers["sec-websocket-protocol"],
      };

      if (accepted !== expected) {
        // The peer said 101 but did not prove it is speaking WebSocket.
        transportError = `Sec-WebSocket-Accept mismatch: expected ${expected}, got ${String(accepted)}.`;
        finish();
        return;
      }

      let buffer = Buffer.alloc(0);
      // Fragmented messages are reassembled before they are reported, so a
      // 1 MB message split into 64 KB frames is one frame to the caller.
      let fragments: Buffer[] = [];
      let fragmentOpcode: WebSocketOpcode = "text";

      const handleFrame = (fin: boolean, opcode: WebSocketOpcode, payload: Buffer): void => {
        if (opcode === "ping") {
          push({
            direction: "received",
            opcode: "ping",
            bytes: payload.byteLength,
            payload,
            protocolError: false,
          });
          upgradedSocket.write(encodeFrame("pong", payload));
          push({
            direction: "sent",
            opcode: "pong",
            bytes: payload.byteLength,
            payload,
            protocolError: false,
          });
          armIdleTimer();
          return;
        }
        if (opcode === "pong") {
          push({
            direction: "received",
            opcode: "pong",
            bytes: payload.byteLength,
            payload,
            protocolError: false,
          });
          armIdleTimer();
          return;
        }
        if (opcode === "close") {
          closeInfo = { code: closeCodeOf(payload), reason: closeReasonOf(payload) };
          push({
            direction: "received",
            opcode: "close",
            bytes: payload.byteLength,
            payload,
            protocolError: false,
          });
          upgradedSocket.write(encodeFrame("close", payload));
          closedCleanly = true;
          finish();
          return;
        }
        if (opcode === "continuation") {
          fragments.push(payload);
          if (!fin) return;
          const whole = Buffer.concat(fragments);
          fragments = [];
          receivedFrames += 1;
          push({
            direction: "received",
            opcode: fragmentOpcode,
            bytes: whole.byteLength,
            payload: whole,
            protocolError: false,
          });
        } else {
          if (!fin) {
            fragmentOpcode = opcode;
            fragments = [payload];
            return;
          }
          receivedFrames += 1;
          push({
            direction: "received",
            opcode,
            bytes: payload.byteLength,
            payload,
            protocolError: false,
          });
        }
        armIdleTimer();
        if (receivedFrames >= options.maxFrames) void closeSequence();
      };

      const readFrames = (): void => {
        for (;;) {
          const parsed = parseFrame(buffer);
          if (parsed === undefined) break;
          buffer = buffer.subarray(parsed.consumed);
          if (parsed.opcode === undefined) {
            push({
              direction: "received",
              opcode: "continuation",
              bytes: parsed.payload.byteLength,
              payload: parsed.payload,
              protocolError: true,
            });
            transportError = "Received a frame with a reserved opcode.";
            finish();
            return;
          }
          handleFrame(parsed.fin, parsed.opcode, parsed.payload);
          if (settled) return;
        }
      };

      upgradedSocket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        readFrames();
      });
      upgradedSocket.on("error", (error: Error) => {
        transportError = error.message;
        finish();
      });
      upgradedSocket.on("close", () => {
        finish();
      });

      const sendNext = async (): Promise<void> => {
        while (sentIndex < options.send.length && !settled) {
          const message = options.send[sentIndex];
          sentIndex += 1;
          if (message === undefined) break;
          const payload =
            message.encoding === "base64"
              ? Buffer.from(message.payload, "base64")
              : Buffer.from(message.payload, "utf8");
          const opcode = message.encoding === "base64" ? "binary" : "text";
          upgradedSocket.write(encodeFrame(opcode, payload));
          push({
            direction: "sent",
            opcode,
            bytes: payload.byteLength,
            payload,
            protocolError: false,
          });
          if (message.waitMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, message.waitMs));
          }
        }
        // A probe that was given nothing to send is testing the upgrade, not the
        // echo, so it closes as soon as it has the handshake.
        if (options.send.length === 0 && !settled) await closeSequence();
      };

      const closeSequence = async (): Promise<void> => {
        if (settled) return;
        upgradedSocket.write(encodeFrame("close", Buffer.from([0x03, 0xe8])));
        push({
          direction: "sent",
          opcode: "close",
          bytes: 2,
          payload: Buffer.from([0x03, 0xe8]),
          protocolError: false,
        });
        // Give the peer a moment to answer with its own close frame, then stop
        // regardless: a peer that never answers must not hold the call open.
        setTimeout(finish, 250).unref?.();
      };

      if (head.byteLength > 0) {
        buffer = Buffer.concat([buffer, head]);
        readFrames();
      }
      armIdleTimer();
      void sendNext();
    });

    if (options.signal !== undefined) {
      // A signal that was already aborted ends this before the request is sent:
      // the listener below cannot fire for an abort that has happened, so a
      // caller who withdrew first would otherwise have a connection opened on
      // their behalf and waited on.
      if (options.signal.aborted) {
        cancelled = true;
        transportError = CANCELLED_TRANSPORT;
        // Nothing is opened: `http.request` allocates a socket on `end()`, and
        // this path returns before `end()` is reached.
        finish();
        return;
      }
      options.signal.addEventListener(
        "abort",
        () => {
          cancelled = true;
          transportError = CANCELLED_TRANSPORT;
          finish();
        },
        { once: true },
      );
    }

    request.end();
  });
};

/** Turn a received frame into the text or base64 a tool result carries. */
export const framePayload = (
  frame: WebSocketFrame,
  maxBytes: number,
): { text?: string; base64?: string; truncated: boolean } => {
  const truncated = frame.payload.byteLength > maxBytes;
  const slice = truncated ? frame.payload.subarray(0, maxBytes) : frame.payload;
  if (frame.opcode === "binary") return { base64: slice.toString("base64"), truncated };
  return { text: slice.toString("utf8"), truncated };
};
