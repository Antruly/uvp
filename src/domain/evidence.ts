import { z } from "zod";

import { canonicalJson, newId, sha256, shortDigest } from "./identity.js";

/**
 * Evidence is the unit of delivery.
 *
 * A tool that changes the world returns Evidence, not prose. Every claim about
 * what happened is either `observed` (something we directly saw: an exit code,
 * a byte count, a response body) or `derived` (something computed from
 * observations: a percentile, a pass/fail verdict). The two are never mixed,
 * because a caller auditing a conclusion needs to know which parts of it are
 * checkable against the world and which are our arithmetic.
 */
export const evidenceKindSchema = z.enum([
  "toolchain",
  "build",
  "launch",
  "exchange",
  "capture",
  "assertion",
  "benchmark",
  /**
   * Evidence about a template package: a stored `id@version`, a source
   * directory being validated or scanned, or the store's inventory.
   *
   * The subject is a filesystem path and the observation is what was read or
   * written there. Filing it under `build` would claim a build that did not
   * happen; filing it under `assertion` would claim a check the call did not
   * make.
   */
  "template",
  /**
   * Evidence about two reports rather than about a live subject.
   *
   * The other kinds are named for what uvp went and looked at. This one is the
   * exception: a comparison looked at nothing, and every fact in it came out of
   * records someone else wrote. Giving it their kind would claim an observation
   * that was never made, so it is named for what it is — second-hand, and saying
   * so in the one field a caller filters on.
   */
  "comparison",
]);
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;

/**
 * How much of the subject this evidence actually covers.
 *
 * `complete` means the stated scope was examined without hitting a known read
 * limit. It is never a claim about anything outside that scope. Absent coverage
 * information is `unknown`, never `complete` — silence is not a pass.
 */
export const coverageSchema = z.object({
  scope: z.string().min(1),
  status: z.enum(["complete", "partial", "unknown"]),
  examined: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(),
  /** Why coverage is partial, when it is. */
  note: z.string().optional(),
});
export type Coverage = z.infer<typeof coverageSchema>;

/** Where a fact came from. Provenance is not optional. */
export const evidenceSourceSchema = z.object({
  kind: z.enum(["command", "file", "endpoint", "process"]),
  ref: z.string().min(1),
  digest: z.string().optional(),
});
export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;

export const evidenceSchema = z.object({
  evidence_id: z.string().regex(/^ev_[0-9a-f]{22}$/u),
  kind: evidenceKindSchema,
  /** What this is evidence about, in a form that survives the session. */
  subject: z.record(z.string(), z.unknown()),
  observed_at: z.string(),
  /** Directly observed facts. Free-form, but never a conclusion. */
  observed: z.record(z.string(), z.unknown()),
  /** Facts computed from `observed`. Always explainable from it. */
  derived: z.record(z.string(), z.unknown()),
  coverage: coverageSchema,
  sources: z.array(evidenceSourceSchema),
  limitations: z.array(z.string()),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export interface CreateEvidenceInit {
  readonly id?: string;
  readonly kind: EvidenceKind;
  readonly subject: Record<string, unknown>;
  readonly observedAt: string;
  readonly observed: Record<string, unknown>;
  readonly derived?: Record<string, unknown>;
  readonly coverage: Coverage;
  readonly sources: readonly EvidenceSource[];
  readonly limitations?: readonly string[];
}

export const createEvidence = (init: CreateEvidenceInit): Evidence =>
  evidenceSchema.parse({
    evidence_id: init.id ?? newId("evidence"),
    kind: init.kind,
    subject: init.subject,
    observed_at: init.observedAt,
    observed: init.observed,
    derived: init.derived ?? {},
    coverage: init.coverage,
    sources: [...init.sources],
    limitations: [...(init.limitations ?? [])],
  });

/**
 * Semantic identity of an evidence record.
 *
 * Two records with the same digest make the same claim about the same subject.
 * Timestamps and ids are excluded: re-running the same probe produces the same
 * identity, which is what makes "is this still true?" answerable.
 *
 * `limitations` is excluded too, which is worth stating because the field is
 * required and a reader would expect it to count. It is commentary on the
 * record; how much of the subject was actually seen is `coverage`'s job, and a
 * truncation that matters shows up in `observed` as well. Including prose here
 * would make the identity of a run depend on how its caveats were phrased.
 */
export const evidenceDigest = (evidence: Evidence): string =>
  sha256(
    canonicalJson({
      kind: evidence.kind,
      subject: evidence.subject,
      observed: evidence.observed,
      derived: evidence.derived,
      coverage: evidence.coverage,
    }),
  );

/** Short, human-facing handle for an evidence record. */
export const evidenceRef = (evidence: Evidence): string =>
  `${evidence.evidence_id}@${shortDigest(evidenceDigest(evidence))}`;
