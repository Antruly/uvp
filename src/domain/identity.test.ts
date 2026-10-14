import { describe, expect, it } from "vitest";

import {
  ID_PREFIXES,
  canonicalJson,
  isPrefixedId,
  newId,
  sha256,
  shortDigest,
  timestamp,
} from "./identity.js";

/**
 * Identity is what makes a claim checkable twice. If an id is not opaque, or a
 * digest is not stable across processes, then "the same evidence" stops meaning
 * anything and every downstream comparison is quietly wrong.
 */

const KINDS = Object.keys(ID_PREFIXES) as (keyof typeof ID_PREFIXES)[];

describe("newId", () => {
  it("mints an id whose prefix names its kind", () => {
    for (const kind of KINDS) {
      expect(newId(kind)).toMatch(new RegExp(`^${ID_PREFIXES[kind]}_[0-9a-f]{22}$`, "u"));
    }
  });

  it("never repeats, over a sample large enough to catch a constant", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId("evidence")));
    expect(ids.size).toBe(500);
  });

  it("is not derived from anything the caller passed", () => {
    // The prefix is the only input, so two calls with the same kind differ.
    expect(newId("run")).not.toBe(newId("run"));
  });
});

describe("isPrefixedId", () => {
  it("accepts every id it minted", () => {
    for (const kind of KINDS) expect(isPrefixedId(newId(kind))).toBe(true);
  });

  it.each([
    ["a bare uuid", "0f8fad5bd9cb469fa16570867728950e"],
    ["no prefix separator", "ev0f8fad5bd9cb469fa16570867728950"],
    ["an unknown prefix", "zz_0f8fad5bd9cb469fa16570867"],
    ["too short a body", "ev_0f8fad5bd9cb469fa165708"],
    ["too long a body", "ev_0f8fad5bd9cb469fa16570867728950e"],
    ["uppercase hex", "ev_0F8FAD5BD9CB469FA1657086"],
    ["non-hex body", "ev_0f8fad5bd9cb469fa165708g"],
    ["a number", 12345],
    ["null", null],
  ])("rejects %s", (_label, value) => {
    expect(isPrefixedId(value)).toBe(false);
  });
});

describe("sha256", () => {
  it("is the standard digest, over text and over bytes alike", () => {
    // Known-answer tests: a changed implementation has to fail here rather than
    // silently produce digests that no other tool can reproduce.
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256(new Uint8Array([0x61, 0x62, 0x63]))).toBe(sha256("abc"));
  });

  it("distinguishes inputs that differ by one byte", () => {
    expect(sha256("abc")).not.toBe(sha256("abd"));
  });
});

describe("shortDigest", () => {
  it("takes the leading 128 bits", () => {
    expect(shortDigest("0123456789abcdef0123456789abcdef")).toBe("0123456789abcdef");
  });
});

describe("canonicalJson", () => {
  it("gives the same string for the same value whatever the key order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("keeps array order, which carries meaning", () => {
    expect(canonicalJson({ x: [3, 1, 2] })).toBe('{"x":[3,1,2]}');
  });

  it("follows RFC 8785 on the numbers a hand-rolled sort gets wrong", () => {
    // `JSON.stringify(-0)` is `"0"` but the sign is dropped by the spec, not by
    // this implementation; `1e21` is where ES switches to exponent form.
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson(1e21)).toBe("1e+21");
    expect(canonicalJson(1.5)).toBe("1.5");
    // 2^53 + 1 is not representable as a double, so the literal *is* 2^53 by the
    // time it reaches the function. Written as an expression rather than the
    // literal, because the lint warning it would otherwise raise ("loses
    // precision at runtime") is the correct diagnosis of a deliberate input.
    expect(canonicalJson(2 ** 53 + 1)).toBe("9007199254740992");
  });

  it("falls back to JSON for a value canonicalize declines", () => {
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson(() => undefined)).toBe("null");
  });

  it("throws on a cycle rather than inventing a digest", () => {
    // Substituting a placeholder would make every cyclic subject digest the
    // same, so two different values would compare equal. Failing is the honest
    // outcome, and the caller sees `execution_failure` rather than a collision.
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/circular/iu);
  });
});

describe("timestamp", () => {
  it("formats the injected clock as UTC with milliseconds", () => {
    expect(timestamp(() => new Date("2026-10-15T04:05:06.789Z"))).toBe("2026-10-15T04:05:06.789Z");
  });

  it("never reads the wall clock implicitly", () => {
    // A frozen clock yields a frozen string at any point in real time.
    const fixed = (): Date => new Date(0);
    expect(timestamp(fixed)).toBe("1970-01-01T00:00:00.000Z");
  });
});
