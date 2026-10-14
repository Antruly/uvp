import type { Coverage, Evidence, EvidenceSource } from "../domain/evidence.js";
import { createEvidence, evidenceDigest } from "../domain/evidence.js";
import type {
  EvidenceRef,
  ResidualUnknownOutput,
  ToolEnvelope,
} from "../contracts/toolOutputSchemaPrimitives.js";
import { newId } from "../domain/identity.js";
import { createResidualUnknown, sortUnknowns } from "../domain/unknown.js";
import type { ResidualUnknown } from "../domain/unknown.js";
import type { UnknownReason } from "../domain/unknown.js";
import type { ToolchainIdentity } from "./ToolchainProvider.js";

/**
 * Helpers for the two things every tool does: describe what it saw, and admit
 * what it did not.
 *
 * These exist so that "we did not check" is cheap to express. If recording an
 * unknown costs more than omitting it, tools will omit it, and the honesty of
 * the framework will quietly decay.
 */

export interface EvidenceRecorder {
  readonly now: () => Date;
  readonly evidence: Evidence[];
  readonly unknowns: ResidualUnknown[];
}

export const createRecorder = (now: () => Date = () => new Date()): EvidenceRecorder => ({
  now,
  evidence: [],
  unknowns: [],
});

export interface RecordEvidenceInit {
  readonly kind: Evidence["kind"];
  readonly subject: Record<string, unknown>;
  readonly observed: Record<string, unknown>;
  readonly derived?: Record<string, unknown>;
  readonly coverage: Coverage;
  readonly sources: readonly EvidenceSource[];
  readonly limitations?: readonly string[];
}

export const record = (recorder: EvidenceRecorder, init: RecordEvidenceInit): Evidence => {
  const evidence = createEvidence({
    kind: init.kind,
    subject: init.subject,
    observedAt: recorder.now().toISOString(),
    observed: init.observed,
    ...(init.derived === undefined ? {} : { derived: init.derived }),
    coverage: init.coverage,
    sources: init.sources,
    ...(init.limitations === undefined ? {} : { limitations: init.limitations }),
  });
  recorder.evidence.push(evidence);
  return evidence;
};

/** Record something that could not be established, and why. */
export const recordUnknown = (
  recorder: EvidenceRecorder,
  question: string,
  reason: UnknownReason,
  options: { blockedBy?: string; partialEvidence?: readonly string[] } = {},
): ResidualUnknown => {
  const unknown = createResidualUnknown({
    id: newId("unknown"),
    question,
    reason,
    ...(options.blockedBy === undefined ? {} : { blockedBy: options.blockedBy }),
    ...(options.partialEvidence === undefined ? {} : { partialEvidence: options.partialEvidence }),
  });
  recorder.unknowns.push(unknown);
  return unknown;
};

/** Project an evidence record into the shape tool outputs carry. */
export const toEvidenceRef = (evidence: Evidence): EvidenceRef => ({
  evidence_id: evidence.evidence_id,
  kind: evidence.kind,
  observed_at: evidence.observed_at,
  digest: evidenceDigest(evidence),
  coverage: evidence.coverage,
  sources: [...evidence.sources],
  limitations: [...evidence.limitations],
});

/**
 * The unknown as the tool output contract carries it.
 *
 * `partial_evidence` is deliberately dropped rather than forwarded: the output
 * schema does not have a field for it, and the alternative — widening the schema
 * to match the domain — would make every caller of every tool parse a field that
 * only `uvp_verify` ever populates. The ids are still reachable through the
 * bundle the workflow returns.
 */
export const toUnknownOutput = (unknown: ResidualUnknown): ResidualUnknownOutput => ({
  unknown_id: unknown.unknown_id,
  question: unknown.question,
  reason: unknown.reason,
  ...(unknown.blocked_by === undefined ? {} : { blocked_by: unknown.blocked_by }),
});

/**
 * Seal a recorder into the envelope every tool result carries.
 *
 * Everything a tool did not put here is a claim it is not making. That is why
 * this is one call at the end of a handler rather than something assembled field
 * by field: a tool whose envelope is easy to build is a tool whose envelope gets
 * built, and `unknowns` is the field most likely to be forgotten.
 *
 * Unknowns are sorted by id so that two runs of the same tool produce envelopes
 * that are equal as bytes.
 */
export const envelopeOf = (
  recorder: EvidenceRecorder,
  init: {
    readonly tool: string;
    readonly provider: ToolchainIdentity;
    readonly limitations?: readonly string[];
  },
): ToolEnvelope => ({
  tool: init.tool,
  provider: {
    id: init.provider.id,
    ...(init.provider.version === undefined ? {} : { version: init.provider.version }),
    platform: init.provider.platform,
  },
  evidence: recorder.evidence.map(toEvidenceRef),
  unknowns: sortUnknowns(recorder.unknowns).map(toUnknownOutput),
  limitations: [...(init.limitations ?? [])],
});

export const coverageComplete = (scope: string): Coverage => ({ scope, status: "complete" });

export const coveragePartial = (
  scope: string,
  note: string,
  examined?: number,
  total?: number,
): Coverage => ({
  scope,
  status: "partial",
  note,
  ...(examined === undefined ? {} : { examined }),
  ...(total === undefined ? {} : { total }),
});

export const coverageUnknown = (scope: string, note: string): Coverage => ({
  scope,
  status: "unknown",
  note,
});

export const commandSource = (command: string): EvidenceSource => ({
  kind: "command",
  ref: command,
});

export const fileSource = (path: string, digest?: string): EvidenceSource => ({
  kind: "file",
  ref: path,
  ...(digest === undefined ? {} : { digest }),
});

export const endpointSource = (url: string): EvidenceSource => ({ kind: "endpoint", ref: url });

export const processSource = (pid: number | undefined, command: string): EvidenceSource => ({
  kind: "process",
  ref: pid === undefined ? command : `pid=${String(pid)} ${command}`,
});
