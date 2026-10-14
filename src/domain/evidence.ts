import { z } from "zod";

import { canonicalJson, newId, sha256, shortDigest } from "./identity.js";
import { residualUnknownSchema, sortUnknowns } from "./unknown.js";
import type { ResidualUnknown } from "./unknown.js";

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

export const EVIDENCE_BUNDLE_STATUSES = ["verified", "partial", "failed", "unknown"] as const;
export type EvidenceBundleStatus = (typeof EVIDENCE_BUNDLE_STATUSES)[number];

/**
 * The deliverable. A bundle is what a workflow tool hands back: the goal it was
 * given, everything it established, and everything it did not.
 */
export const evidenceBundleSchema = z.object({
  bundle_id: z.string().regex(/^bun_[0-9a-f]{22}$/u),
  goal: z.string(),
  status: z.enum(EVIDENCE_BUNDLE_STATUSES),
  created_at: z.string(),
  evidence: z.array(evidenceSchema),
  unknowns: z.array(residualUnknownSchema),
  limitations: z.array(z.string()),
});
export type EvidenceBundle = z.infer<typeof evidenceBundleSchema>;

export interface CreateEvidenceBundleInit {
  readonly id?: string;
  readonly goal: string;
  readonly status: EvidenceBundleStatus;
  readonly createdAt: string;
  readonly evidence: readonly Evidence[];
  readonly unknowns: readonly ResidualUnknown[];
  readonly limitations?: readonly string[];
}

export const createEvidenceBundle = (init: CreateEvidenceBundleInit): EvidenceBundle =>
  evidenceBundleSchema.parse({
    bundle_id: init.id ?? newId("bundle"),
    goal: init.goal,
    status: init.status,
    created_at: init.createdAt,
    evidence: [...init.evidence],
    unknowns: sortUnknowns(init.unknowns),
    limitations: [...(init.limitations ?? [])],
  });
