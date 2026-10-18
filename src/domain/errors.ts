import { z } from "zod";

/**
 * Error categories for the uvp error contract.
 *
 * These are deliberately coarser than the individual codes below. A caller that
 * only needs to decide "retry, re-ask the user, or give up" reads `category`; a
 * caller that needs to render a specific remedy reads `code` and `remediation`.
 */
export const uvpErrorCategorySchema = z.enum([
  "invalid_input",
  "unsupported_toolchain",
  "unsupported_target",
  "unavailable",
  "build_failure",
  "timeout",
  "cancelled",
  "resource_constraint",
  "truncated",
  "integrity_mismatch",
  "execution_failure",
]);
export type UvpErrorCategory = z.infer<typeof uvpErrorCategorySchema>;

/** Stable machine-readable failure codes. One code, one remedy. */
export const uvpErrorCodeSchema = z.enum([
  "invalid_request",
  "missing_requirement",
  "unsupported_toolchain",
  "toolchain_unavailable",
  "compiler_unavailable",
  "libuvcpp_unavailable",
  "unsupported_target",
  "workspace_not_found",
  "workspace_integrity_mismatch",
  "target_unavailable",
  "service_unavailable",
  "build_failed",
  "configure_failed",
  "launch_failed",
  "endpoint_unreachable",
  "timeout",
  "cancelled",
  "resource_constraint",
  "truncated",
  "artifact_modified",
  "capture_listen_failed",
  "capture_not_found",
  "template_not_found",
  "assertion_failed",
  "execution_failure",
  "cleanup_incomplete",
]);
export type UvpErrorCode = z.infer<typeof uvpErrorCodeSchema>;

/**
 * A remedy the caller can actually act on.
 *
 * `action` is an imperative sentence addressed to the agent, not to a human
 * reading a log. It names the concrete next step ("install Ninja, or pass
 * --generator=make"), never "check your configuration".
 */
export const uvpRemediationSchema = z.object({
  action: z.string().min(1),
  docs: z.string().optional(),
});

export type UvpRemediation = z.infer<typeof uvpRemediationSchema>;

export const uvpErrorSchema = z.object({
  code: uvpErrorCodeSchema,
  category: uvpErrorCategorySchema,
  message: z.string().min(1),
  retryable: z.boolean(),
  remediation: uvpRemediationSchema,
  details: z.record(z.string(), z.unknown()).optional(),
});
export type UvpError = z.infer<typeof uvpErrorSchema>;

/** The error contract is closed: unknown keys are a contract violation. */
export const parseUvpError = (value: unknown): UvpError => uvpErrorSchema.parse(value);

export interface UvpErrorInit {
  readonly code: UvpErrorCode;
  readonly message: string;
  readonly retryable?: boolean;
  readonly remediation: { readonly action: string; readonly docs?: string };
  readonly details?: Record<string, unknown>;
}

/** Category is derived from the code so the two can never drift apart. */
const CATEGORY_BY_CODE: Record<UvpErrorCode, UvpErrorCategory> = {
  invalid_request: "invalid_input",
  missing_requirement: "invalid_input",
  unsupported_toolchain: "unsupported_toolchain",
  toolchain_unavailable: "unsupported_toolchain",
  compiler_unavailable: "unsupported_toolchain",
  libuvcpp_unavailable: "unsupported_toolchain",
  unsupported_target: "unsupported_target",
  workspace_not_found: "unsupported_target",
  workspace_integrity_mismatch: "integrity_mismatch",
  target_unavailable: "unsupported_target",
  service_unavailable: "unavailable",
  build_failed: "build_failure",
  configure_failed: "build_failure",
  launch_failed: "execution_failure",
  endpoint_unreachable: "unavailable",
  timeout: "timeout",
  cancelled: "cancelled",
  resource_constraint: "resource_constraint",
  truncated: "truncated",
  artifact_modified: "integrity_mismatch",
  capture_listen_failed: "execution_failure",
  capture_not_found: "unsupported_target",
  template_not_found: "unsupported_target",
  assertion_failed: "execution_failure",
  execution_failure: "execution_failure",
  cleanup_incomplete: "execution_failure",
};

/**
 * Whether the same call could plausibly succeed on a retry with no changes.
 *
 * The set is exactly the codes whose category says the environment might be
 * different next time — `unavailable`, `timeout`, `resource_constraint`. Nothing
 * in `unsupported_target` is here, and `target_unavailable` was the exception
 * that proved the rule: the target does not stop being the wrong target by being
 * asked again. Every one of the ways that code is raised — a certificate this
 * client will not accept, a service that answers in a version the caller pinned
 * away from — is something the caller has to change (hand over the CA, ask over
 * the version the service speaks), and a `retryable: true` beside that remedy
 * invites exactly the loop the remedy exists to end.
 */
const RETRYABLE_BY_CODE: ReadonlySet<UvpErrorCode> = new Set<UvpErrorCode>([
  "service_unavailable",
  "endpoint_unreachable",
  "timeout",
  "resource_constraint",
]);

export class UvpFailure extends Error {
  readonly detail: UvpError;

  constructor(init: UvpErrorInit) {
    super(init.message);
    this.name = "UvpFailure";
    this.detail = uvpErrorSchema.parse({
      code: init.code,
      category: CATEGORY_BY_CODE[init.code],
      message: init.message,
      retryable: init.retryable ?? RETRYABLE_BY_CODE.has(init.code),
      remediation: {
        action: init.remediation.action,
        ...(init.remediation.docs === undefined ? {} : { docs: init.remediation.docs }),
      },
      ...(init.details === undefined ? {} : { details: init.details }),
    });
  }
}

export const isUvpFailure = (value: unknown): value is UvpFailure => value instanceof UvpFailure;

/**
 * A cancellation, as a failure rather than as a finding.
 *
 * An aborted call has established nothing about its subject, and every shape
 * below the tool boundary can express one as an answer instead: an empty
 * compiler list reads as "this host has no compiler", a `found: false` reads as
 * "there is no libuvcpp here", a build with no diagnostics reads as "this code
 * does not compile". A caller cannot tell any of those from a run that was
 * interrupted one line earlier, and the difference decides whether they go and
 * install something.
 *
 * `cancelled` is already in the contract for exactly this reason, so every layer
 * that notices a signal spells it here rather than assembling the failure again
 * — that way the code, the category, and the remedy cannot drift between the
 * layer that saw the abort and the layer that reports it.
 */
export const cancelledFailure = (message: string): UvpFailure =>
  new UvpFailure({
    code: "cancelled",
    message,
    remediation: {
      action: "Re-run the call; the interruption established nothing about its subject.",
    },
  });

/**
 * Whether a throw is the caller's own withdrawal, as opposed to a finding.
 *
 * A layer that catches errors to classify them — a transport translating Node
 * errors into the error contract, a workflow deciding whether an exchange was
 * observed — must not classify a cancellation as anything about the subject.
 * A named predicate says that intent once; testing for the type alone would also
 * be true for a validation failure or a missing workspace, which are findings.
 */
export const isCancelledFailure = (value: unknown): value is UvpFailure =>
  isUvpFailure(value) && value.detail.code === "cancelled";

/**
 * Project any thrown value into the error contract.
 *
 * An unrecognised throw becomes `execution_failure` and keeps its message: we
 * would rather report a vague failure than invent a specific one.
 *
 * A `ZodError` is the exception that must *not* be treated as unrecognised. It
 * is how every tool contract reports a bad input — the parse happens at the
 * handler's edge — and the documentation promises a schema violation arrives as
 * `invalid_request` naming the field. Left in the generic branch it would arrive
 * as `execution_failure` with a JSON dump for a message, telling an agent that
 * uvp broke rather than that its own call was malformed.
 */
export const toUvpError = (cause: unknown): UvpError => {
  if (isUvpFailure(cause)) return cause.detail;
  if (cause instanceof z.ZodError) return invalidRequest(cause);
  if (cause instanceof Error) {
    return uvpErrorSchema.parse({
      code: "execution_failure",
      category: "execution_failure",
      message: describeCause(cause.message),
      retryable: false,
      remediation: { action: "Inspect the reported message and re-run the tool." },
      details: { name: cause.name },
    });
  }
  return uvpErrorSchema.parse({
    code: "execution_failure",
    category: "execution_failure",
    message: describeCause(cause),
    retryable: false,
    remediation: { action: "Inspect the reported message and re-run the tool." },
  });
};

/**
 * A message the contract will accept.
 *
 * `message` has a minimum length of one, and the values that stringify to `""`
 * are the reachable ones: `throw new Error()`, `throw ""`, a rejected promise
 * with no reason. This is the last-resort projector — the caller is already in a
 * catch block — so it must not be the thing that throws. A throw here would
 * replace a reportable failure with a stack trace.
 */
const describeCause = (cause: unknown): string => {
  const text = (cause instanceof Error ? cause.message : String(cause)).trim();
  return text === "" ? "The tool failed without reporting a reason." : text;
};

/** A dotted path to the offending field, or `""` when the failure is the whole value. */
const fieldPath = (path: readonly PropertyKey[]): string => path.map(String).join(".");

const invalidRequest = (error: z.ZodError): UvpError => {
  const issues = error.issues.map((issue) => ({
    field: fieldPath(issue.path),
    message: issue.message,
  }));
  const first = issues[0];
  // The first issue leads, because a caller fixing one field at a time wants the
  // one the schema reached first. The rest stay in `details` — a form with three
  // bad fields should not need three round trips to discover them.
  const message =
    first === undefined
      ? "The input did not match the tool's schema."
      : first.field === ""
        ? first.message
        : `${first.field}: ${first.message}`;
  return uvpErrorSchema.parse({
    code: "invalid_request",
    category: "invalid_input",
    message,
    retryable: false,
    remediation: {
      action:
        "Correct the field named in the message and call the tool again. The tool's input " +
        "schema is in the tool catalog.",
    },
    details: { issues },
  });
};
