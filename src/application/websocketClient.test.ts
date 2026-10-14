import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { encodeFrame, parseFrame } from "./websocketClient.js";

/**
 * The frame codec is the one part of the probe that talks to a foreign
 * implementation, so it is checked against the RFC's byte layout rather than
 * against itself. A round-trip through `parseFrame` would catch a header the
 * parser also misreads; asserting the actual bytes catches a header that is
 * merely wrong.
 *
 * The three length encodings are covered separately because they are three
 * different code paths, and the shortest one — where the length fits in the
 * seven-bit field — is the one every small payload takes.
 */

const lengths = [
  ["the seven-bit length field", 5],
  ["the sixteen-bit extension", 200],
  ["the sixty-four-bit extension", 70_000],
] as const;

/** Total header bytes: length field, then the four-byte mask key. */
const headerBytesFor = (length: number): number =>
  (length < 126 ? 2 : length < 65_536 ? 4 : 10) + 4;

describe("encodeFrame", () => {
  it.each(lengths)("round-trips a payload using %s", (_label, length) => {
    const payload = Buffer.alloc(length, 0x41);
    const frame = encodeFrame("text", payload);

    const parsed = parseFrame(frame);
    expect(parsed).toBeDefined();
    expect(parsed?.opcode).toBe("text");
    expect(parsed?.fin).toBe(true);
    expect(parsed?.payload.toString("utf8")).toBe(payload.toString("utf8"));
    // Parsing must consume the whole frame: a trailing byte means the encoder
    // wrote something the layout does not account for.
    expect(parsed?.consumed).toBe(frame.byteLength);
  });

  it.each(lengths)("lays out the header as the RFC requires for %s", (_label, length) => {
    const payload = Buffer.alloc(length, 0x41);
    const frame = encodeFrame("text", payload);
    const headerBytes = headerBytesFor(length);

    expect(frame.byteLength).toBe(headerBytes + length);
    expect(frame[0]).toBe(0x80 | 0x1);
    // The mask bit is mandatory on a client frame. A server that receives an
    // unmasked one is required to close the connection.
    expect((frame[1] ?? 0) & 0x80).toBe(0x80);

    // The mask key occupies the four bytes after the length field, and the
    // payload follows immediately. Reading the key from the wrong offset is the
    // bug this test exists for: it silently produces a frame whose payload
    // decodes to noise.
    const mask = frame.subarray(headerBytes - 4, headerBytes);
    for (let index = 0; index < length; index += 1) {
      expect(frame[headerBytes + index]).toBe((payload[index] ?? 0) ^ (mask[index % 4] ?? 0));
    }
  });

  it("encodes the declared length, not the buffer it was handed", () => {
    // The length field is what the peer trusts to find the payload. Reading the
    // wrong offset would make the two disagree, and the peer would read the next
    // frame's bytes as this frame's body.
    const frame = encodeFrame("binary", Buffer.alloc(200, 0x41));
    expect(frame[1]).toBe(0x80 | 126);
    expect(frame.readUInt16BE(2)).toBe(200);
  });

  it("masks a payload differently every time", () => {
    // A fixed mask key would be a constant in the wire format, and two runs of
    // the same probe would be byte-identical.
    const first = encodeFrame("text", Buffer.from("same"));
    const second = encodeFrame("text", Buffer.from("same"));
    expect(first.equals(second)).toBe(false);
    expect(parseFrame(second)?.payload.toString("utf8")).toBe("same");
  });

  it("encodes an empty payload as a bare header with no body", () => {
    // The close frame is empty, so this is the path a clean shutdown takes.
    const frame = encodeFrame("close", Buffer.alloc(0));
    expect(frame.byteLength).toBe(6);
    expect(parseFrame(frame)).toMatchObject({ opcode: "close", payload: expect.anything() });
    expect(parseFrame(frame)?.payload.byteLength).toBe(0);
  });

  it.each(["ping", "pong", "close"] as const)("carries the opcode for %s", (opcode) => {
    expect(parseFrame(encodeFrame(opcode, Buffer.from("x")))?.opcode).toBe(opcode);
  });
});

describe("parseFrame", () => {
  it("waits for a whole frame rather than reading a partial one", () => {
    const frame = encodeFrame("text", Buffer.from("hello"));
    for (let cut = 0; cut < frame.byteLength; cut += 1) {
      expect(parseFrame(frame.subarray(0, cut)), `truncated to ${String(cut)}`).toBeUndefined();
    }
  });

  it("unmasks a frame a peer masked, and passes through one it did not", () => {
    // Servers do not mask, so the unmasked path is the one real traffic takes
    // even though the encoder never produces it.
    const unframed = Buffer.concat([Buffer.from([0x81, 0x02]), Buffer.from("hi")]);
    expect(parseFrame(unframed)?.payload.toString("utf8")).toBe("hi");
  });

  it("reports a reserved opcode as a violation, not as a short read", () => {
    // The frame parses — its length fields are fine — but it carries no opcode,
    // which is how the caller tells "this is not a message" apart from "there
    // are not enough bytes yet". Returning `undefined` here would make a
    // malformed frame look like a truncated one and stall the read.
    const parsed = parseFrame(Buffer.from([0x83, 0x00]));
    expect(parsed).toBeDefined();
    expect(parsed?.opcode).toBeUndefined();
  });
});
