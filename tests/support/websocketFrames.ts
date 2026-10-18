import { randomBytes } from "node:crypto";
import { connect } from "node:net";

import { encodeFrame, parseFrame } from "../../src/application/websocketClient.js";
import type { WebSocketOpcode } from "../../src/application/websocketClient.js";

/**
 * A raw WebSocket client, for the frames the product cannot send.
 *
 * `uvp ws` and `probeWebSocket` send text and binary and tear the socket down;
 * neither sends PING or CLOSE, and CLOSE is the only way to observe what a
 * service does when a peer says goodbye. `encodeFrame` and `parseFrame` already
 * exist and are the same code the probe uses, so this helper is a socket and a
 * loop, not a second RFC 6455 implementation.
 */

export interface RawFrame {
  readonly opcode: WebSocketOpcode | undefined;
  readonly payload: Buffer;
}

export interface RawExchange {
  /** The HTTP status of the upgrade response; 101 for a real upgrade. */
  readonly status: number;
  /** Frames the service sent after the upgrade, in arrival order. */
  readonly frames: readonly RawFrame[];
  /** True when the service closed the connection rather than the timer. */
  readonly closedByService: boolean;
}

export interface OutgoingFrame {
  readonly opcode: "text" | "binary" | "ping" | "close";
  readonly payload: Buffer;
}

/** A CLOSE payload: the two-byte code, then the reason as UTF-8. */
export const closeFramePayload = (code: number, reason: string): Buffer => {
  const text = Buffer.from(reason, "utf8");
  const payload = Buffer.alloc(2 + text.byteLength);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);
  return payload;
};

/**
 * Upgrade to `path`, send `outgoing`, and collect what comes back.
 *
 * The service answering CLOSE ends the exchange the moment it closes the
 * socket. An exchange without CLOSE resolves after `settleMs` of quiet: the
 * frames under test have arrived by then, and a test that waits for a close the
 * caller did not ask for would hang rather than fail.
 */
export const exchangeWebSocketFrames = async (
  port: number,
  path: string,
  outgoing: readonly OutgoingFrame[],
  settleMs = 1_000,
): Promise<RawExchange> => {
  const socket = connect({ host: "127.0.0.1", port });
  const key = randomBytes(16).toString("base64");
  const frames: RawFrame[] = [];
  let buffer = Buffer.alloc(0);
  let status: number | undefined;
  let closedByService = false;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let settleTimer: NodeJS.Timeout | undefined;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      resolve();
    };

    socket.on("error", (cause) => {
      if (status === undefined) reject(cause);
      else settle();
    });
    socket.on("close", () => {
      closedByService = true;
      settle();
    });
    socket.on("connect", () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: 127.0.0.1:${String(port)}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (status === undefined) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end === -1) return;
        const head = buffer.subarray(0, end).toString("latin1");
        status = Number(head.split(" ")[1] ?? 0);
        buffer = buffer.subarray(end + 4);
        if (status !== 101) {
          settle();
          return;
        }
        for (const frame of outgoing) socket.write(encodeFrame(frame.opcode, frame.payload));
        // Armed even when CLOSE was sent: whether the service closes the
        // socket is a fact the exchange reports, not something to wait on.
        settleTimer = setTimeout(settle, settleMs);
      }
      for (;;) {
        const parsed = parseFrame(buffer);
        if (parsed.kind !== "frame") return;
        frames.push({ opcode: parsed.opcode, payload: parsed.payload });
        buffer = buffer.subarray(parsed.consumed);
      }
    });
  });

  socket.destroy();
  if (status === undefined) throw new Error(`no upgrade response from :${String(port)}${path}`);
  return { status, frames, closedByService };
};
