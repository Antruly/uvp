import { z } from "zod";

import { evidenceKindSchema, coverageSchema, evidenceSourceSchema } from "../domain/evidence.js";

/**
 * Shared output fragments.
 *
 * Output schemas describe the success shape only. Failures travel as the error
 * contract with `isError: true` and no structured content, so that a caller can
 * never mistake a partial failure payload for a successful result.
 */

export type EvidenceRef = z.infer<typeof evidenceRefSchema>;
export type ResidualUnknownOutput = z.infer<typeof residualUnknownOutputSchema>;

export const evidenceRefSchema = z.object({
  evidence_id: z.string(),
  kind: evidenceKindSchema,
  observed_at: z.string(),
  /** Semantic digest: the same claim about the same subject yields the same value. */
  digest: z.string(),
  coverage: coverageSchema,
  sources: z.array(evidenceSourceSchema),
  limitations: z.array(z.string()),
});

export const residualUnknownOutputSchema = z.object({
  unknown_id: z.string(),
  question: z.string(),
  reason: z.string(),
  blocked_by: z.string().optional(),
});

/** The standard envelope every uvp tool result carries. */
export const toolEnvelopeShape = {
  tool: z.string(),
  /** Provider identity, so a result is attributable to a specific toolchain. */
  provider: z.object({
    id: z.string(),
    version: z.string().optional(),
    platform: z.string(),
  }),
  evidence: z.array(evidenceRefSchema),
  unknowns: z.array(residualUnknownOutputSchema),
  limitations: z.array(z.string()),
} as const;

export const toolEnvelopeSchema = z.object(toolEnvelopeShape);
export type ToolEnvelope = z.infer<typeof toolEnvelopeSchema>;
