import { createHash, randomUUID } from "node:crypto";

import canonicalize from "canonicalize";

/**
 * Prefixed, opaque identifiers.
 *
 * Every id carries its own kind, so a log line or an evidence reference is
 * self-describing without a lookup. The prefix is part of the contract; user
 * input never supplies one.
 */
export const ID_PREFIXES = {
  evidence: "ev",
  bundle: "bun",
  unknown: "unk",
  workspace: "wsp",
  run: "run",
  exchange: "exc",
  capture: "cap",
  session: "ses",
} as const;
export type IdKind = keyof typeof ID_PREFIXES;

export type PrefixedId<Kind extends IdKind> = `${(typeof ID_PREFIXES)[Kind]}_${string}`;

/** Mint a new id of the given kind. Never derived from user input. */
export const newId = <Kind extends IdKind>(kind: Kind): PrefixedId<Kind> => {
  const body = randomUUID().replaceAll("-", "").slice(0, 22);
  return `${ID_PREFIXES[kind]}_${body}` as PrefixedId<Kind>;
};

const ID_PATTERN = /^(ev|bun|unk|wsp|run|exc|cap|ses)_[0-9a-f]{22}$/u;

export const isPrefixedId = (value: unknown): value is PrefixedId<IdKind> =>
  typeof value === "string" && ID_PATTERN.test(value);

/**
 * Content digest used for integrity and identity claims.
 *
 * Digests are how uvp separates "the file we built" from "the file that is
 * there now". They are always sha256 over raw bytes.
 */
export const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Short digest for display and equality checks where 128 bits is plenty. */
export const shortDigest = (digest: string): string => digest.slice(0, 16);

/**
 * Stable JSON canonicalisation, so the same logical value digests the same.
 *
 * This is RFC 8785 (JSON Canonicalization Scheme), not a hand-rolled key sort.
 * The difference is visible in the places a hand-rolled version gets wrong:
 * number formatting (`1e21`, `-0`, integers above 2^53), and the ordering of
 * keys that differ only outside the BMP. Two agents digesting the same evidence
 * on two machines must agree, so the algorithm is a specification and not an
 * implementation detail.
 *
 * `canonicalize` returns undefined for a value it declines — a bare `undefined`,
 * a function, a symbol — and those fall through to `JSON.stringify`, which
 * handles them the same way. A cyclic value is different: both throw, and the
 * throw is left to propagate. Substituting `"null"` would be worse than failing,
 * because two different cyclic subjects would then digest identically, which is
 * the one outcome a digest exists to prevent.
 */
export const canonicalJson = (value: unknown): string =>
  canonicalize(value) ?? JSON.stringify(value) ?? "null";

/**
 * Timestamps are always UTC ISO-8601 with milliseconds.
 *
 * Evidence is only useful if it can be ordered against other evidence, so the
 * clock is injectable and never read implicitly inside the domain.
 */
export const timestamp = (clock: () => Date): string => clock().toISOString();
