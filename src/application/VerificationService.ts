import { canonicalJson, newId, sha256 } from "../domain/identity.js";
import {
  coverageComplete,
  coverageUnknown,
  createRecorder,
  endpointSource,
  envelopeOf,
  fileSource,
  processSource,
  record,
  recordUnknown,
} from "./evidenceHelpers.js";
import type { EvidenceRecorder } from "./evidenceHelpers.js";
import { evaluateAssertions } from "./assertions.js";
import type { AssertionSpec } from "./assertions.js";
import type { ToolchainIdentity } from "./ToolchainProvider.js";
import type { WebService } from "./WebService.js";
import type { WorkspaceService } from "./WorkspaceService.js";
import type { SessionStore } from "./sessionStore.js";

/**
 * The verification workflow.
 *
 * This is the shape the whole framework exists to produce: a claim, the evidence
 * behind it, and an explicit list of what was not established. It creates
 * nothing and installs nothing — it takes a workspace that already exists,
 * builds it, starts it, exercises it, and then stops it.
 *
 * The status is computed from what was actually *evaluated*, never from what was
 * requested. A run where the service never came up is `unknown`, not `failed`:
 * uvp did not check the assertions and find them false, it could not check them
 * at all. Collapsing those two would make the one status a caller can trust
 * (`verified`) unreliable in exactly the case where it matters most.
 */

export type VerificationStatus = "verified" | "partial" | "failed" | "unknown";

export interface VerifyRequest {
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
  readonly assertions: readonly {
    readonly kind: AssertionSpec["kind"];
    readonly target?: string | undefined;
    /** Absent for the presence checks, which carry nothing to compare against. */
    readonly expected?: unknown;
  }[];
}

export interface VerifyInput {
  readonly path: string;
  readonly build: {
    readonly build_type: "Debug" | "RelWithDebInfo" | "Release";
    readonly generator?: "ninja" | "unix-makefiles" | "msbuild" | undefined;
  };
  readonly run: {
    readonly port: number;
    readonly ready_path: string;
    readonly timeout_ms: number;
    readonly args: readonly string[];
  };
  readonly requests: readonly VerifyRequest[];
  readonly keep_running: boolean;
  readonly goal: string | undefined;
}

export interface VerifyContext {
  readonly workspace: WorkspaceService;
  readonly web: WebService;
  readonly store: SessionStore;
  readonly identity: ToolchainIdentity;
  readonly now: () => Date;
  readonly signal: AbortSignal;
}

export interface VerifyResult {
  /** The goal the caller stated, when it stated one. See `goalOf`. */
  goal?: string;
  workspace_id: string;
  bundle_id: string;
  /** Content digest of the pass; see `bundleDigest`. Equal digests mean equal findings. */
  bundle_digest: string;
  status: VerificationStatus;
  build: { succeeded: boolean; exit_code: number };
  service: { run_id?: string; ready: boolean; endpoint?: string };
  exchanges: {
    name: string;
    exchange_id: string;
    status?: number;
    elapsed_ms?: number;
    assertions_passed: number;
    assertions_failed: number;
    failures: string[];
  }[];
  unverified: { question: string; reason: string }[];
}

/**
 * Decide the status from what was evaluated.
 *
 * Kept as its own function because it is the one place where a status is chosen,
 * and a second place would eventually choose differently.
 */
export const verificationStatus = (init: {
  readonly evaluated: number;
  readonly failed: number;
  readonly unanswered: number;
  readonly unknownCount: number;
}): VerificationStatus => {
  if (init.evaluated === 0) return "unknown";
  if (init.failed > 0) return "failed";
  if (init.unanswered > 0 || init.unknownCount > 0) return "partial";
  return "verified";
};

/**
 * The goal the caller named, as a bundle field.
 *
 * Echoed rather than kept: a bundle is "the goal it was given, everything it
 * established, and everything it did not", and a bundle that does not say what
 * it was for is one a reader has to reconstruct from the exchange names. The
 * field was accepted all the way from the CLI and the contract and then read
 * nowhere, so `uvp verify --goal …` changed nothing about the output.
 *
 * Absent when the caller named none. An empty string would look like a goal
 * somebody stated, which is a claim about the pass that nobody made.
 */
const goalOf = (input: VerifyInput): { goal?: string } =>
  input.goal === undefined ? {} : { goal: input.goal };

export const verify = async (input: VerifyInput, context: VerifyContext): Promise<VerifyResult> => {
  const recorder = createRecorder(context.now);
  const unverified: { question: string; reason: string }[] = [];

  const buildResult = await context.workspace.build({
    path: input.path,
    buildDir: undefined,
    buildType: input.build.build_type,
    generator: input.build.generator,
    target: undefined,
    clean: false,
    jobs: undefined,
    timeoutMs: 600_000,
    configureOnly: false,
    signal: context.signal,
  });

  const buildEvidence = record(recorder, {
    kind: "build",
    subject: { workspace_id: buildResult.workspaceId, workspace_path: input.path },
    observed: {
      exit_code: buildResult.outcome.exitCode,
      succeeded: buildResult.outcome.succeeded,
      diagnostics: buildResult.outcome.diagnostics.length,
      artifacts: buildResult.outcome.artifacts.length,
    },
    derived: { from_cache: buildResult.outcome.fromCache },
    coverage: { scope: "build", status: "complete" },
    sources: buildResult.outcome.commands.map((command) => ({
      kind: "command" as const,
      ref: command,
    })),
  });

  if (!buildResult.outcome.succeeded) {
    // No assertion can be evaluated, so nothing is claimed. The build's own exit
    // code and diagnostics are already in the output; they are not a verdict on
    // the service.
    unverified.push({
      question: "Do the requested endpoints behave as asserted?",
      reason: "the workspace did not build, so nothing was launched",
    });
    recordUnknown(recorder, "Does the service satisfy the goal?", "not_attempted", {
      blockedBy: "the build failed",
      partialEvidence: [buildEvidence.evidence_id],
    });

    return {
      ...envelopeOf(recorder, {
        tool: "uvp_verify",
        provider: context.identity,
        limitations: [
          "Nothing was launched: the build failed, so nothing about the service was observed.",
        ],
      }),
      ...goalOf(input),
      workspace_id: buildResult.workspaceId,
      bundle_id: newId("bundle"),
      bundle_digest: bundleDigest({ status: "unknown", exchanges: [], unverified }),
      status: "unknown",
      build: { succeeded: false, exit_code: buildResult.outcome.exitCode },
      service: { ready: false },
      exchanges: [],
      unverified,
    };
  }

  const runResult = await context.workspace.run({
    path: input.path,
    buildDir: undefined,
    binary: undefined,
    args: input.run.args,
    env: {},
    ready: {
      port: input.run.port,
      path: input.run.ready_path,
      timeoutMs: input.run.timeout_ms,
    },
    detach: true,
    // The pass takes the caller's signal as a whole, not only while it is
    // building: a Ctrl-C during the readiness wait is the same withdrawal, and
    // without this the wait ignored it and reported its own deadline as the
    // reason the service was never reached.
    signal: context.signal,
  });

  record(recorder, {
    kind: "launch",
    subject: { workspace_id: runResult.workspaceId, run_id: runResult.runId },
    observed: {
      pid: runResult.pid,
      ready: runResult.ready,
      still_running: runResult.stillRunning,
    },
    ...(runResult.startupMs === undefined ? {} : { derived: { startup_ms: runResult.startupMs } }),
    coverage: { scope: "service readiness", status: runResult.ready ? "complete" : "unknown" },
    sources: [
      processSource(runResult.pid, [runResult.command, ...runResult.args].join(" ")),
      ...(runResult.endpoint === undefined ? [] : [endpointSource(runResult.endpoint)]),
      fileSource(input.path),
    ],
  });

  if (!runResult.ready || runResult.endpoint === undefined) {
    unverified.push({
      question: "Do the requested endpoints behave as asserted?",
      reason: "the service did not become ready within the readiness timeout",
    });
    recordUnknown(recorder, "Did the service accept connections?", "resource_limit", {
      blockedBy: `the readiness probe on port ${String(input.run.port)} never succeeded`,
      partialEvidence: [buildEvidence.evidence_id],
    });
    if (!input.keep_running) await stopQuietly(context, recorder, runResult.runId);

    return {
      ...envelopeOf(recorder, {
        tool: "uvp_verify",
        provider: context.identity,
        limitations: [
          `The service was started but ${input.run.ready_path} on port ${String(input.run.port)} never answered.`,
        ],
      }),
      ...goalOf(input),
      workspace_id: runResult.workspaceId,
      bundle_id: newId("bundle"),
      bundle_digest: bundleDigest({ status: "unknown", exchanges: [], unverified }),
      status: "unknown",
      build: { succeeded: true, exit_code: buildResult.outcome.exitCode },
      service: {
        run_id: runResult.runId,
        ready: false,
        ...(runResult.endpoint === undefined ? {} : { endpoint: runResult.endpoint }),
      },
      exchanges: [],
      unverified,
    };
  }

  const base = `http://127.0.0.1:${String(input.run.port)}`;
  const exchangeResults: VerifyResult["exchanges"][number][] = [];
  let evaluated = 0;
  let failed = 0;

  for (const spec of input.requests) {
    const url = `${base}${spec.path.startsWith("/") ? spec.path : `/${spec.path}`}`;
    const startedAt = Date.now();

    const exchange = await context.web
      .httpRequest(
        {
          url,
          method: spec.method,
          headers: spec.headers,
          body: spec.body,
          body_encoding: "utf8",
          http_version: "auto",
          follow_redirects: false,
          max_redirects: 0,
          verify_tls: false,
          timeout_ms: 30_000,
          max_body_bytes: 1_048_576,
        },
        recorder,
        context.signal,
      )
      .catch((cause: unknown) => {
        recordUnknown(
          recorder,
          `Does ${spec.name} (${spec.method} ${spec.path}) behave as asserted?`,
          "not_attempted",
          { blockedBy: cause instanceof Error ? cause.message : String(cause) },
        );
        return undefined;
      });

    if (exchange === undefined) {
      exchangeResults.push({
        name: spec.name,
        // No exchange happened, so there is no id to report. An empty string
        // would look like one.
        exchange_id: "",
        assertions_passed: 0,
        assertions_failed: 0,
        failures: ["the request did not complete"],
      });
      continue;
    }

    const record_ = context.store.exchange(exchange.exchange_id);
    const outcomes =
      record_ === undefined
        ? []
        : evaluateAssertions(
            record_,
            spec.assertions.map((assertion) => ({
              kind: assertion.kind,
              ...(assertion.target === undefined ? {} : { target: assertion.target }),
              ...(assertion.expected === undefined ? {} : { expected: assertion.expected }),
            })),
          );

    evaluated += outcomes.length;
    const failures = outcomes
      .filter((outcome) => !outcome.passed)
      .map((outcome) => outcome.message);
    failed += failures.length;

    if (spec.assertions.length === 0) {
      unverified.push({
        question: `Does ${spec.name} return the expected content?`,
        reason: "no assertions were supplied for this request, so only its status was observed",
      });
      recordUnknown(recorder, `Is the body of ${spec.name} correct?`, "not_attempted", {
        blockedBy: "no assertions were supplied for this request",
      });
    }

    record(recorder, {
      kind: "assertion",
      subject: { name: spec.name, url, exchange_id: exchange.exchange_id },
      observed: {
        status: exchange.status,
        assertions: outcomes.length,
        passed: outcomes.length - failures.length,
        failed: failures.length,
      },
      derived: { elapsed_ms: Date.now() - startedAt },
      coverage:
        outcomes.length === 0
          ? coverageUnknown(`${spec.name} assertions`, "no assertions were supplied")
          : coverageComplete(`${spec.name} assertions`),
      sources: [endpointSource(url)],
      limitations: failures,
    });

    exchangeResults.push({
      name: spec.name,
      exchange_id: exchange.exchange_id,
      status: exchange.status,
      elapsed_ms: Date.now() - startedAt,
      assertions_passed: outcomes.length - failures.length,
      assertions_failed: failures.length,
      failures,
    });
  }

  if (!input.keep_running) await stopQuietly(context, recorder, runResult.runId);
  else
    record(recorder, {
      kind: "launch",
      subject: { run_id: runResult.runId },
      observed: { left_running: true },
      coverage: coverageUnknown("cleanup", "keep_running was set"),
      sources: [],
      limitations: [
        "The service is still running. Stop it with uvp_run_stop when it is no longer needed.",
      ],
    });

  const status = verificationStatus({
    evaluated,
    failed,
    unanswered: unverified.filter((entry) => entry.reason.includes("no assertions")).length,
    unknownCount: recorder.unknowns.length,
  });

  const limitations = [
    ...(input.keep_running
      ? ["The service was left running; stop it with uvp_run_stop."]
      : [
          "The service was stopped after the pass; the evidence describes a process that no longer exists.",
        ]),
    ...(failed > 0
      ? ["Listeners on the loopback interface were assumed to be this workspace's service."]
      : []),
  ];

  return {
    ...envelopeOf(recorder, { tool: "uvp_verify", provider: context.identity, limitations }),
    ...goalOf(input),
    workspace_id: runResult.workspaceId,
    bundle_id: newId("bundle"),
    bundle_digest: bundleDigest({ status, exchanges: exchangeResults, unverified }),
    status,
    build: { succeeded: true, exit_code: buildResult.outcome.exitCode },
    service: { run_id: runResult.runId, ready: true, endpoint: runResult.endpoint },
    exchanges: exchangeResults,
    unverified,
  };
};

/**
 * Stop the run, and record it if the stop did not complete.
 *
 * A verification pass that leaves a listening socket behind has made the next
 * pass fail for a reason that has nothing to do with the code under test, so a
 * failed cleanup is reported rather than swallowed.
 */
const stopQuietly = async (
  context: VerifyContext,
  recorder: EvidenceRecorder,
  runId: string,
): Promise<void> => {
  try {
    const stopped = await context.workspace.stop({
      runId,
      all: false,
      graceMs: 3_000,
      force: true,
    });
    if (stopped.cleanupComplete) return;
    recordUnknown(recorder, "Was the service stopped after the pass?", "not_attempted", {
      blockedBy: `${runId} did not exit cleanly; it may still be listening.`,
    });
  } catch (cause) {
    recordUnknown(recorder, "Was the service stopped after the pass?", "not_attempted", {
      blockedBy: cause instanceof Error ? cause.message : String(cause),
    });
  }
};

/**
 * Digest of a verification pass, stable across runs that established the same
 * things.
 *
 * Kept separate from `bundle_id`, which is random, for the same reason an
 * evidence record carries both an id and a digest: the id says *which* record
 * this is, the digest says *what it found*. Two passes over an unchanged
 * workspace should mint different ids and the same digest, and that equality is
 * the only way to tell "nothing changed since last time" from "a different
 * session happened to look similar".
 *
 * `unverified` is part of it because a pass that asserted less is not the same
 * pass. Dropping it would make a run with an unasserted endpoint digest
 * identically to a run that covered it — the weaker pass wearing the stronger
 * one's fingerprint, which is the direction of error that costs something.
 */
export const bundleDigest = (
  result: Pick<VerifyResult, "status" | "exchanges" | "unverified">,
): string =>
  sha256(
    canonicalJson({
      status: result.status,
      exchanges: result.exchanges.map((entry) => [
        entry.name,
        entry.status ?? 0,
        entry.assertions_passed,
        entry.assertions_failed,
      ]),
      unverified: result.unverified.map((entry) => [entry.question, entry.reason]),
    }),
  );
