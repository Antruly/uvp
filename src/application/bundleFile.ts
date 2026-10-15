import { readFile, stat } from "node:fs/promises";
import type { z } from "zod";

import { verificationBundleSchema } from "../contracts/projectToolContracts.js";
import { UvpFailure } from "../domain/errors.js";
import { sha256 } from "../domain/identity.js";
import type { BundleIdentity, ComparedBundle } from "./bundleDiff.js";

/**
 * Reading a saved verification pass.
 *
 * A pass reaches this module as a file — `uvp verify --json > pass.json` is how
 * one is kept — and what the file holds is a *claim*: a status, a digest, and the
 * list of things the pass established. Two of those claims can be checked against
 * the file itself and one cannot, so the distinction is kept rather than
 * flattened:
 *
 * - `bytes` and `byte_digest` describe the **file**. The byte digest is over the
 *   raw bytes, so a byte that moved changes it whether or not the change survives
 *   JSON parsing — a reordered key, or a trailing newline, or a `é` written
 *   two ways.
 * - `bundle.bundle_digest` is the **pass's** own semantic digest: what the pass
 *   that wrote the file said about its findings. It survives reformatting, which
 *   is what lets two passes be compared by it at all.
 *
 * This module does not recompute the semantic digest, and that is deliberate.
 * Whether the digest describes the bundle's own contents is the comparison's
 * question, not the reader's: a reader that silently recomputed it would erase
 * the one case worth reporting — a file whose digest and contents disagree.
 *
 * One limit, stated: a bundle file larger than `MAX_BUNDLE_FILE_BYTES` is
 * refused rather than read. Every tool in uvp bounds what one call holds, and the
 * bound has to be at the read, because a caller can always name a file that is
 * not a bundle.
 */

/** What one call will read into memory. A bundle is a report, not a dataset. */
export const MAX_BUNDLE_FILE_BYTES = 64 * 1024 * 1024;

/** How many schema violations a refusal names before it stops listing them. */
const MAX_REPORTED_ISSUES = 4;

export interface SavedBundle {
  /** The path as the caller spelled it; not resolved, so it reads back as given. */
  readonly path: string;
  readonly bytes: number;
  /** sha256 over the file's raw bytes. Not the bundle's semantic digest. */
  readonly byte_digest: string;
  readonly bundle: ComparedBundle;
}

/** Why a file could not be read, in terms a caller can act on. */
const describeReadFailure = (cause: unknown): string => {
  const code = (cause as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") return "there is no file at that path";
  if (code === "EISDIR") return "that path is a directory";
  if (code === "EACCES") return "that path is not readable by this process";
  return cause instanceof Error ? cause.message : String(cause);
};

const badBundle = (message: string, action: string, details?: Record<string, unknown>) =>
  new UvpFailure({
    code: "invalid_request",
    message,
    remediation: { action, docs: "docs/cli.md" },
    ...(details === undefined ? {} : { details }),
  });

const wroteOne = (path: string): string =>
  `Write one with \`uvp verify --json > ${path}\`, then pass that path.`;

/**
 * A parsed report, shaped exactly like one the workflow has just produced.
 *
 * Not a formality, and not a cast. Zod's optional fields are `T | undefined`
 * where the workflow's are `T`, so a parsed value can carry an explicit
 * `undefined` in a place the workflow carries nothing — and a reader that handed
 * that straight on would be comparing two reports of different shapes. The keys
 * that are absent are dropped here, the envelope's fields are dropped with them
 * (they describe the call that produced a report, not the report), and a field
 * added to the contract's schema becomes a compile error here rather than a
 * silently missing comparison.
 */
const asComparedBundle = (parsed: z.infer<typeof verificationBundleSchema>): ComparedBundle => ({
  ...(parsed.goal === undefined ? {} : { goal: parsed.goal }),
  workspace_id: parsed.workspace_id,
  bundle_id: parsed.bundle_id,
  bundle_digest: parsed.bundle_digest,
  status: parsed.status,
  build: { succeeded: parsed.build.succeeded, exit_code: parsed.build.exit_code },
  service: {
    ready: parsed.service.ready,
    ...(parsed.service.run_id === undefined ? {} : { run_id: parsed.service.run_id }),
    ...(parsed.service.endpoint === undefined ? {} : { endpoint: parsed.service.endpoint }),
  },
  exchanges: parsed.exchanges.map((entry) => ({
    name: entry.name,
    exchange_id: entry.exchange_id,
    ...(entry.status === undefined ? {} : { status: entry.status }),
    ...(entry.http_version === undefined ? {} : { http_version: entry.http_version }),
    ...(entry.elapsed_ms === undefined ? {} : { elapsed_ms: entry.elapsed_ms }),
    assertions_passed: entry.assertions_passed,
    assertions_failed: entry.assertions_failed,
    failures: [...entry.failures],
  })),
  unverified: parsed.unverified.map((entry) => ({
    question: entry.question,
    reason: entry.reason,
  })),
});

/**
 * Parse the text of a bundle file.
 *
 * Separated from the read so that "not JSON" and "JSON that is not a bundle" stay
 * distinguishable outcomes rather than one "could not read it": the first means
 * the wrong file, the second means the right file in a shape nothing writes, and
 * a caller repairs those differently.
 */
export const parseSavedBundle = (text: string, path: string): ComparedBundle => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw badBundle(
      `The file at ${path} is not JSON: ${cause instanceof Error ? cause.message : String(cause)}.`,
      wroteOne(path),
    );
  }

  // The same schema the pass that writes a bundle is declared with, so a reader
  // cannot accept a shape the writer never produces.
  const parsed = verificationBundleSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)");
    // The first few issues, not all of them. A file that is some *other* tool's
    // output fails on a dozen fields at once, and the twelve-line message that
    // produces says less than the first line does. The complete list is in
    // `details`, where a caller that wants to enumerate them can read it.
    const shown = issues.slice(0, MAX_REPORTED_ISSUES);
    const rest = issues.length - shown.length;
    throw badBundle(
      `The file at ${path} is JSON but is not a verification report: ` +
        `${String(shown.length)} of ${String(issues.length)} fields are wrong, starting with ` +
        `${shown.join(", ")}${rest > 0 ? ` (and ${String(rest)} more)` : ""}.`,
      wroteOne(path),
      { issues },
    );
  }
  return asComparedBundle(parsed.data);
};

/** A file too large to be a report, refused with the size that was actually seen. */
const tooLarge = (path: string, size: number) =>
  badBundle(
    `The file at ${path} is ${String(size)} bytes, above uvp's ${String(MAX_BUNDLE_FILE_BYTES)}-byte ` +
      "limit for a verification report. The limit is a bound on what one comparison holds in memory.",
    "Compare the passes you meant to compare; a bundle is a report, and a file this size is something else.",
    { bytes: size, limit_bytes: MAX_BUNDLE_FILE_BYTES },
  );

/**
 * Read one saved pass, or explain why it is not one.
 *
 * Both the `stat` and the read are guarded by the same description of what went
 * wrong. Guarding only the first would have been enough to compile and to pass a
 * test that named a missing file, while every failure that only the *read* can
 * discover — a directory is the one that matters, since `stat` reports a size
 * for it and it is not over the limit — escaped as an unclassified execution
 * failure, and the EISDIR sentence below it was unreachable.
 */
export const readSavedBundle = async (path: string): Promise<SavedBundle> => {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (cause) {
    throw badBundle(
      `The verification report at ${path} could not be read: ${describeReadFailure(cause)}.`,
      wroteOne(path),
    );
  }
  // Before the read, because that is where the memory is spent: a caller can
  // name a file of any size, and this is the bound on what one comparison holds.
  if (size > MAX_BUNDLE_FILE_BYTES) throw tooLarge(path, size);

  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (cause) {
    throw badBundle(
      `The verification report at ${path} could not be read: ${describeReadFailure(cause)}.`,
      wroteOne(path),
    );
  }
  // And again afterwards, because the file is not frozen between the two calls: a
  // report replaced by something larger while it was being read is refused rather
  // than parsed, so the limit is a fact about what was read rather than an
  // estimate made about what was there a moment earlier.
  if (bytes.byteLength > MAX_BUNDLE_FILE_BYTES) throw tooLarge(path, bytes.byteLength);

  const bundle = parseSavedBundle(bytes.toString("utf8"), path);
  return { path, bytes: bytes.byteLength, byte_digest: sha256(bytes), bundle };
};

/**
 * One side of a comparison, as the tool reports it.
 *
 * The file's facts and the pass's claim in one object, which is the point: a
 * reader can see that `byte_digest` describes the bytes it read and `digest` is
 * what the pass said about itself, and that nothing checked the second against
 * the first — that is `digest_consistent`'s job, and it is the comparison's.
 */
export interface ReportedSide {
  readonly path: string;
  readonly bytes: number;
  readonly byte_digest: string;
  readonly bundle_id: string;
  readonly workspace_id: string;
  readonly status: BundleIdentity["status"];
  readonly digest: string;
  readonly goal?: string | undefined;
}

export const reportedSide = (saved: SavedBundle, identity: BundleIdentity): ReportedSide => ({
  path: saved.path,
  bytes: saved.bytes,
  byte_digest: saved.byte_digest,
  bundle_id: identity.bundle_id,
  workspace_id: identity.workspace_id,
  status: identity.status,
  digest: identity.digest,
  ...(identity.goal === undefined ? {} : { goal: identity.goal }),
});
