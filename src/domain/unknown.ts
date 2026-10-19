import { z } from "zod";

/**
 * A residual unknown is a question uvp could not answer, recorded on purpose.
 *
 * This is the single most important difference between uvp and a code
 * generator. A generator that cannot verify its output is silent about it; uvp
 * is required to say what it did not establish, and why. "We did not check" and
 * "we checked and it was fine" must never look the same to the caller.
 */
export const unknownReasonSchema = z.enum([
  "not_attempted",
  "toolchain_missing",
  "unsupported_by_platform",
  "unsupported_by_build",
  "out_of_scope",
  "resource_limit",
  /**
   * The thing being observed stopped before it could be observed.
   *
   * Distinct from `resource_limit`, which says a bound was reached while the
   * subject was still there: a service that exited during a readiness wait did
   * not time out, and reporting a timeout would send the caller to a longer
   * wait instead of to the process's own output.
   */
  "process_exit",
  "cancelled",
  "ambiguous_requirement",
]);
export type UnknownReason = z.infer<typeof unknownReasonSchema>;

export const residualUnknownSchema = z.object({
  unknown_id: z.string().regex(/^unk_[0-9a-f]{22}$/u),
  /** The question, phrased so a caller could go and answer it. */
  question: z.string().min(1),
  reason: unknownReasonSchema,
  /** What would have to change for this to become answerable. */
  blocked_by: z.string().optional(),
  /** Evidence ids that partially bear on the question, if any. */
  partial_evidence: z.array(z.string()).optional(),
});
export type ResidualUnknown = z.infer<typeof residualUnknownSchema>;

export interface ResidualUnknownInit {
  readonly id: string;
  readonly question: string;
  readonly reason: UnknownReason;
  readonly blockedBy?: string;
  readonly partialEvidence?: readonly string[];
}

export const createResidualUnknown = (init: ResidualUnknownInit): ResidualUnknown =>
  residualUnknownSchema.parse({
    unknown_id: init.id,
    question: init.question,
    reason: init.reason,
    ...(init.blockedBy === undefined ? {} : { blocked_by: init.blockedBy }),
    ...(init.partialEvidence === undefined || init.partialEvidence.length === 0
      ? {}
      : { partial_evidence: [...init.partialEvidence] }),
  });

/** Total order for unknown lists, so bundles are byte-stable across runs. */
export const compareUnknowns = (left: ResidualUnknown, right: ResidualUnknown): number =>
  left.unknown_id < right.unknown_id ? -1 : left.unknown_id > right.unknown_id ? 1 : 0;

export const sortUnknowns = (unknowns: readonly ResidualUnknown[]): readonly ResidualUnknown[] =>
  [...unknowns].sort(compareUnknowns);
