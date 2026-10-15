import { describe, expect, it } from "vitest";

import {
  type Fuzzer,
  fuzzer,
  fuzzIterations,
  fuzzSeeds,
  replay,
  reportFuzzRun,
  seedFor,
} from "../../tests/support/fuzz.js";
import { TransportFailure, decodeBody, transportFailureKind } from "./httpClient.js";

/**
 * What the response decoder and the failure classifier do with generated input.
 *
 * Two functions at the same boundary: one turns a peer's bytes into something a
 * caller can read, the other turns whatever a catch block caught into one of four
 * kinds. Both are called *inside* the paths that report failures, which is why
 * "never throws" is a property here rather than a nicety — an exception raised
 * while classifying an exception replaces the caller's error handling with a
 * `TypeError` about a value nobody was looking at.
 *
 * `httpClient.test.ts` covers both through real sockets, which is the only way to
 * know the classification matches what Node raises. This file cannot say that; it
 * generates bytes and error shapes a socket on this host would not produce, and
 * states properties that hold for all of them.
 *
 * **What this does not establish.** A bounded search over generated inputs is not
 * a statement about the input space, and the seed list and iteration count are
 * printed by every run for that reason. The decoder's lane states the presence
 * rule for `textLossy` as a property — present exactly when re-encoding the text
 * does not return the bytes it came from — and the shapes the rule turns on are
 * pinned as known answers beside it, so the rule is readable rather than only
 * sampled.
 */

const SEEDS = fuzzSeeds();
const ITERATIONS = fuzzIterations();

/**
 * Content types a peer really sends, with no ambiguity about their class.
 *
 * Kept apart from the soup below because two of the properties decide what the
 * answer *must be*, and deciding that needs a vocabulary whose class is not in
 * question. `text/html` with a charset parameter, `application/json`, and no
 * `Content-Type` at all are text; `image/png` and `application/octet-stream` are
 * not, whatever the bytes look like.
 */
const TEXT_CONTENT_TYPES = [
  undefined,
  "text/plain",
  "text/html; charset=utf-8",
  "text/csv; charset=UTF-8",
  "application/json",
  "application/xml",
  "application/soap+xml",
  "application/javascript",
];

const NON_TEXT_CONTENT_TYPES = [
  "application/octet-stream",
  "image/png",
  "application/pdf",
  "application/zip",
  "audio/mpeg",
  "font/woff2",
  "application/x-protobuf",
  "video/mp4",
];

/** Characters a peer can put in a body, ASCII and multi-byte both. */
const TEXT_ALPHABET = "abcXYZ 0123\n\té中ü—🙂'\"/<>&";

const contentTypes = (f: Fuzzer): string | undefined => {
  const source = f.pick([TEXT_CONTENT_TYPES, NON_TEXT_CONTENT_TYPES]);
  const chosen = f.pick(source);
  if (chosen === undefined || f.chance(0.75)) return chosen;
  // A mutated spelling, so the classifier meets the shapes a proxy or a buggy
  // service produces: a stray space before the parameter, shouting case, a
  // suffix nobody planned for.
  return f.pick([
    chosen.toUpperCase(),
    ` ${chosen}`,
    `${chosen} ; charset=utf-8`,
    `${chosen}extra`,
    `${chosen};charset="iso-8859-1"`,
    f.string('abtext/JSONXML+-;= "0', 0, 12),
  ]);
};

const validText = (f: Fuzzer): string => f.string(TEXT_ALPHABET, 0, 60);

/** Bytes with no claim to being text at all. */
const arbitraryBytes = (f: Fuzzer): Buffer => f.bytes(0, 40);

/** A body with a NUL somewhere in the first stretch of it. */
const bytesWithNul = (f: Fuzzer): Buffer => {
  const before = f.string("abcdefg ", 0, 30);
  const after = f.string("hijklmn ", 0, 30);
  return Buffer.from(`${before}\u0000${after}`, "utf8");
};

const BODY_GENERATORS = [validText, arbitraryBytes, bytesWithNul];

const asBody = (f: Fuzzer): { readonly body: Buffer; readonly text: string | undefined } => {
  const generator = f.pick(BODY_GENERATORS);
  if (generator === validText) {
    const text = validText(f);
    return { body: Buffer.from(text, "utf8"), text };
  }
  return { body: generator(f) as Buffer, text: undefined };
};

/**
 * The invariants every decode must satisfy, whatever it was given.
 *
 * The one that matters most is the pair of "exactly one": a caller reads
 * `decoded.text` or `decoded.base64`, and a result that carried both would make
 * the choice between them depend on the order a caller happened to check —
 * two answers to one question, which is the shape the evidence model exists to
 * forbid.
 */
const decodeProblem = (
  body: Buffer,
  result: { readonly text?: string; readonly base64?: string; readonly decodedAsText: boolean },
): string | undefined => {
  if ((result.text === undefined) === (result.base64 === undefined)) {
    return `expected exactly one of text/base64, got ${JSON.stringify(result)}`;
  }
  if (result.decodedAsText !== (result.text !== undefined)) {
    return `decodedAsText is ${String(result.decodedAsText)} with text ${String(result.text !== undefined)}`;
  }
  if (result.base64 !== undefined) {
    const roundTripped = Buffer.from(result.base64, "base64");
    if (!roundTripped.equals(body)) {
      return `base64 is not the bytes: ${result.base64} for ${body.toString("hex")}`;
    }
    // The exact size of base64, not a loose cap: a decoder that appended
    // anything to what it produced would show up here.
    if (result.base64.length !== 4 * Math.ceil(body.byteLength / 3)) {
      return `base64 of ${String(result.base64.length)} characters for ${String(body.byteLength)} bytes`;
    }
  }
  if (result.text !== undefined && result.text.length > body.byteLength) {
    return `text of ${String(result.text.length)} characters from ${String(body.byteLength)} bytes`;
  }
  return undefined;
};

/**
 * The invariant `textLossy` exists to make checkable, and the consequence of each
 * value it can take.
 *
 * The property a caller is really asking about is "is this text these bytes?", and
 * the answer is decidable here without restating the rule: re-encode the text and
 * compare. A presence rule that disagrees with that comparison is exactly the
 * defect the field was added to end — text that is not the body's bytes with
 * nothing in the output saying so.
 *
 * The consequence of `truncated` is stated independently of how the rule is
 * computed: dropping the text's last character must land on a byte boundary, with
 * one to three bytes of the body left over. A `truncated` answer that did not
 * satisfy that would be a cut claimed where no byte is missing.
 */
const lossyProblem = (
  body: Buffer,
  result: {
    readonly text?: string;
    readonly textLossy?: "truncated" | "invalid-utf8";
  },
  cutShort: boolean,
): string | undefined => {
  if (result.text === undefined) {
    return result.textLossy === undefined
      ? undefined
      : `textLossy is ${result.textLossy} with no text to be lossy about`;
  }
  const isTheBytes = Buffer.from(result.text, "utf8").equals(body);
  if ((result.textLossy === undefined) !== isTheBytes) {
    return isTheBytes
      ? `textLossy is ${String(result.textLossy)} for text that is the bytes`
      : `the text is not the bytes (${body.toString("hex")}) and no textLossy says why`;
  }
  if (result.textLossy === "truncated") {
    if (!cutShort) {
      // The same bytes arriving whole are a peer's invalid byte, so nothing in
      // this result may attribute the loss to a cut nobody mentioned.
      return "a cut is reported with nobody having claimed one";
    }
    const kept = Buffer.from(result.text.slice(0, -1), "utf8");
    const missing = body.byteLength - kept.byteLength;
    if (!body.subarray(0, kept.byteLength).equals(kept) || missing < 1 || missing > 3) {
      return `a cut is reported with ${String(missing)} byte(s) after the text's last whole character`;
    }
  }
  return undefined;
};

describe("the response decoder, against generated bytes", () => {
  reportFuzzRun("response decoding, invariants", SEEDS, ITERATIONS);

  it("never throws, returns exactly one of text and base64, and is a function of its arguments", () => {
    for (const seed of SEEDS) {
      for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
        const f = fuzzer(seedFor(seed, iteration));
        const contentType = contentTypes(f);
        const { body } = asBody(f);
        // Both halves, because a body the caller cut and the same body whole are
        // the two inputs the field has to tell apart — and it is the caller's
        // claim, not the bytes, that decides which one it was.
        const cutShort = f.chance(0.5);
        const result = decodeBody(body, contentType, { cutShort });
        const problem = decodeProblem(body, result) ?? lossyProblem(body, result, cutShort);
        if (problem !== undefined) {
          throw new Error(replay({ seed, iteration, input: body, problem }));
        }
        const again = decodeBody(body, contentType, { cutShort });
        if (JSON.stringify(again) !== JSON.stringify(result)) {
          throw new Error(
            replay({
              seed,
              iteration,
              input: body,
              problem: `a second call answered differently: ${JSON.stringify(again)}`,
            }),
          );
        }
      }
    }
  });

  it("gives back a text body unchanged, byte for byte", () => {
    for (const seed of SEEDS) {
      for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
        const f = fuzzer(seedFor(seed, iteration));
        const text = validText(f);
        const body = Buffer.from(text, "utf8");
        const contentType = f.pick(TEXT_CONTENT_TYPES);
        const result = decodeBody(body, contentType);
        // A valid UTF-8 body a peer *declared* to be text is the case the decoder
        // exists for, and the only honest answer is the text itself — not a
        // near-miss with a replacement character in it, and not a `textLossy`
        // about a loss that did not happen.
        if (result.text !== text) {
          throw new Error(
            replay({
              seed,
              iteration,
              input: body,
              problem: `expected ${JSON.stringify(text)}, received ${JSON.stringify(result)}`,
            }),
          );
        }
        const problem = lossyProblem(body, result, false);
        if (problem !== undefined) {
          throw new Error(replay({ seed, iteration, input: body, problem }));
        }
      }
    }
  });

  it("decodes nothing as text that was not declared text", () => {
    for (const seed of SEEDS) {
      for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
        const f = fuzzer(seedFor(seed, iteration));
        const contentType = f.pick(NON_TEXT_CONTENT_TYPES);
        const body = Buffer.from(validText(f), "utf8");
        const result = decodeBody(body, contentType);
        // Even when the bytes are perfectly good ASCII: the declaration is what
        // the caller asked about, and a `Content-Type: image/png` body returned as
        // text would be this tool deciding it knows better than the peer.
        if (result.decodedAsText || result.base64 === undefined) {
          throw new Error(
            replay({
              seed,
              iteration,
              input: body,
              problem: `${contentType} was decoded as text: ${JSON.stringify(result)}`,
            }),
          );
        }
      }
    }
  });

  it("lets a NUL byte overrule the content type, at the boundary the code describes", () => {
    // The guard is on the first 1024 *characters* of the decoded string, which is
    // at least the first 1024 bytes — never fewer, since a character is at least a
    // byte. Both ends are pinned because "the first kilobyte" and "the first 1024
    // characters" are different claims and only one of them is true.
    const at = (before: number, filler: string): Buffer =>
      Buffer.from(`${filler.repeat(before)}\u0000tail`, "utf8");
    expect(decodeBody(at(1_023, "a"), "text/html").decodedAsText).toBe(false);
    expect(decodeBody(at(1_024, "a"), "text/html").decodedAsText).toBe(true);
    // A NUL at character 1000 but byte 2000: a check on the first kilobyte of
    // bytes would have read this body as text.
    const late = decodeBody(at(1_000, "é"), "text/html");
    expect(late.decodedAsText).toBe(false);
    expect(at(1_000, "é").indexOf(0)).toBeGreaterThan(1_024);
  });

  it("tells a cap that cut a character from a peer that sent something else", () => {
    // Written as a code point rather than as the character, because the whole
    // point of the assertions below is which character it is and a replacement
    // character pasted into source is indistinguishable from one that arrived
    // there by accident.
    const replacement = String.fromCodePoint(0xff_fd);

    // A peer's bytes with nothing cut: `ff fe` start no UTF-8 sequence at all, so
    // this is a finding about the sender. The text is still handed over — a caller
    // may want to see it — but not as something that can be compared with the
    // digest.
    const peer = Buffer.from([0x48, 0x69, 0xff, 0xfe, 0x21]);
    const declared = decodeBody(peer, "text/html");
    expect(declared.decodedAsText).toBe(true);
    expect(declared.text).toBe(`Hi${replacement.repeat(2)}!`);
    expect(declared.textLossy).toBe("invalid-utf8");

    // The shape a byte-count cap leaves: two of the three bytes of 中. The bytes
    // are identical either way, which is the reason this cannot be decided from
    // them — the caller's claim about the body is what decides.
    const twoThirds = Buffer.from([0xe4, 0xb8]);
    expect(decodeBody(twoThirds, "text/html").textLossy).toBe("invalid-utf8");
    const capped = decodeBody(twoThirds, "text/html", { cutShort: true });
    expect(capped.decodedAsText).toBe(true);
    expect(capped.text).toBe(replacement);
    expect(capped.textLossy).toBe("truncated");

    // And the case that made "refuse to call it text whenever a re-encode differs"
    // the wrong fix: a cap that landed between two characters lost nothing, so
    // there is no loss to report and the text is the bytes that were kept.
    const betweenCharacters = decodeBody(Buffer.from("中中", "utf8").subarray(0, 3), "text/html", {
      cutShort: true,
    });
    expect(betweenCharacters.text).toBe("中");
    expect(betweenCharacters.textLossy).toBeUndefined();

    // A peer that cut itself off — the bytes stop mid-character and nobody cut
    // them — is the peer's doing, and reported as such rather than as a cap.
    expect(decodeBody(Buffer.from([0xf0, 0x9f, 0x98]), "text/html").textLossy).toBe("invalid-utf8");
  });

  it("answers the same way for the shapes the rule was measured against", () => {
    // Known answers, one shape each, because these are the cases the rule turns
    // on and a rule that is only exercised through random bytes is a rule nobody
    // can read. Each is `[bytes, cutShort, expected]`.
    const cases: [number[], boolean, string | undefined][] = [
      // Nothing to report: empty, ASCII, multi-byte, and a whole 4-byte sequence.
      [[], false, undefined],
      [[0x41], false, undefined],
      [[0xe4, 0xb8, 0xad], false, undefined],
      [[0xf0, 0x9f, 0x98, 0x80], false, undefined],
      // Cut inside a character, at each of the three lengths a sequence can have.
      [[0xc3], true, "truncated"],
      [[0xe4], true, "truncated"],
      [[0xe4, 0xb8], true, "truncated"],
      [[0xf0], true, "truncated"],
      [[0xf0, 0x9f], true, "truncated"],
      [[0xf0, 0x9f, 0x98], true, "truncated"],
      // The same bytes with nobody claiming a cut: the peer's.
      [[0xc3], false, "invalid-utf8"],
      [[0xf0, 0x9f], false, "invalid-utf8"],
      // Not a sequence a peer could have started and a cap could have cut: a byte
      // no sequence begins with, a lone continuation, an overlong encoding, a
      // surrogate, and a complete sequence followed by rubbish.
      [[0xff], true, "invalid-utf8"],
      [[0x80], true, "invalid-utf8"],
      [[0xc0, 0xaf], true, "invalid-utf8"],
      [[0xed, 0xa0, 0x80], true, "invalid-utf8"],
      [[0x41, 0xff], true, "invalid-utf8"],
      [[0x41, 0x80, 0x80, 0x80, 0x80], true, "invalid-utf8"],
      // A cap that cut a character *and* bytes the peer sent that are not UTF-8:
      // the earlier invalid byte is not the cut's doing, so the cut is not the
      // whole answer.
      [[0xff, 0xe4, 0xb8], true, "invalid-utf8"],
    ];
    for (const [bytes, cutShort, expected] of cases) {
      const body = Buffer.from(bytes);
      const result = decodeBody(body, "text/html", { cutShort });
      expect([...bytes, cutShort, result.textLossy]).toStrictEqual([...bytes, cutShort, expected]);
      const problem = lossyProblem(body, result, cutShort);
      expect(problem).toBeUndefined();
    }
  });
});

describe("the failure classifier, against generated errors", () => {
  reportFuzzRun("transport failure classification, invariants", SEEDS, ITERATIONS);

  const KINDS = ["timeout", "unreachable", "protocol", "tls"];
  const CODES = [
    "ETIMEDOUT",
    "ECONNREFUSED",
    "ENOTFOUND",
    "ECONNRESET",
    "EPIPE",
    "EHOSTUNREACH",
    "ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL",
    "ERR_HTTP2_STREAM_CANCEL",
    "ERR_HTTP2_ERROR",
    "HPE_INVALID_CONSTANT",
    "CERT_HAS_EXPIRED",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "SOMETHING_NOBODY_HAS_SEEN",
    "",
  ];

  /**
   * What a catch block can hold, as shaped by the draws.
   *
   * The cause chain is walked to a bounded depth by the classifier, so a chain
   * longer than that plus one that points at itself are both drawn: a bounded walk
   * is only bounded if the bound is what ends it rather than the data.
   */
  const caughtValue = (f: Fuzzer): unknown => {
    const depth = f.int(6);
    let current: Error = Object.assign(
      new Error(`level ${String(depth)}`),
      f.chance(0.8) ? { code: f.pick(CODES) } : {},
    );
    const first = current;
    for (let level = 0; level < depth; level += 1) {
      current = Object.assign(new Error(`cause ${String(level)}`), {
        ...(f.chance(0.8) ? { code: f.pick(CODES) } : {}),
        cause: current,
      });
    }
    if (f.chance(0.15)) (first as { cause?: unknown }).cause = current;
    if (f.chance(0.1))
      return new TransportFailure(f.pick(["timeout", "tls", "protocol"] as const), "generated");
    if (f.chance(0.1))
      return f.pick([undefined, null, 0, "", "a string, not an error", [], {}, () => 1]);
    return current;
  };

  it("answers with one of the four kinds for anything a catch block can hold", () => {
    for (const seed of SEEDS) {
      for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
        const f = fuzzer(seedFor(seed, iteration));
        const value = caughtValue(f);
        const kind = transportFailureKind(value);
        if (!KINDS.includes(kind)) {
          throw new Error(
            replay({
              seed,
              iteration,
              input: String(value),
              problem: `kind ${JSON.stringify(kind)} is not one of ${KINDS.join(", ")}`,
            }),
          );
        }
      }
    }
  });

  it("answers for an error whose `code` is not a string", () => {
    // Node sets `code` to a string, so this shape is not one the transport raises
    // today — which is exactly why the case is named rather than left to the
    // generator. The function's contract is "the kind of anything a caller caught",
    // and it is called from inside `catch` blocks: a throw from here does not
    // report a failure, it replaces the caller's error handling with a `TypeError`
    // about a field nobody asked about. Total over `unknown` is the claim, so it is
    // checked at its edge rather than only where the value came from Node.
    const weird = [
      Object.assign(new Error("numeric code"), { code: 42 }),
      Object.assign(new Error("null code"), { code: null }),
      Object.assign(new Error("object code"), { code: { toString: () => "ETIMEDOUT" } }),
      Object.assign(new Error("nested"), { cause: Object.assign(new Error("inner"), { code: 7 }) }),
    ];
    for (const value of weird) {
      expect(() => transportFailureKind(value)).not.toThrow();
      expect(KINDS).toContain(transportFailureKind(value));
    }
  });
});
