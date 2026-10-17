import { canonicalJson, newId, sha256 } from "../domain/identity.js";
import {
  coverageComplete,
  coveragePartial,
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
import { tallyVerdicts } from "../domain/verdict.js";
import { evaluateAssertions, requestLabel, unevaluatedQuestion } from "./assertions.js";
import type { AssertionSpec } from "./assertions.js";
import type { TlsVerification } from "./httpClient.js";
import type { ToolchainIdentity } from "./ToolchainProvider.js";
import type { ToolTlsReport, WebService } from "./WebService.js";
import type { WorkspaceService } from "./WorkspaceService.js";
import type { SessionStore } from "./sessionStore.js";
import { manifestOf, manifestProblemOf, readWorkspaceManifest } from "./workspaceManifest.js";
import { selectToolchain } from "./toolchainSelection.js";
import type { ToolchainKind } from "../domain/toolchain.js";
import { UvpFailure } from "../domain/errors.js";

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
  /**
   * The protocol version to **attempt**, in the same spelling
   * `uvp_http_request` takes: `auto`, `1.1`, `2`, `3`.
   *
   * Per request rather than per pass, because a verification whose subject is a
   * transport is a verification that has to say which transport — and because
   * the same service is legitimately asked over two of them in one pass, which
   * is how "h1 and h2c share this port" is established rather than assumed.
   * What came back is a separate fact, reported per exchange and assertable with
   * `http_version_equals`.
   */
  readonly http_version: "auto" | "1.1" | "2" | "3";
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
  /**
   * Where to build, when the call says. The workspace's manifest decides when it
   * does not, through the one rule that answers this for every workflow.
   */
  readonly toolchain: ToolchainKind | undefined;
  /**
   * Whether the certificate on an HTTPS exchange has to verify.
   *
   * Required rather than optional, unlike the tool inputs, because this is a
   * workflow and the caller here is the tool handler holding the parsed default.
   * A second default in this layer is a second place the two can disagree.
   */
  readonly verify_tls: boolean;
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
    /** The version the response arrived in. Absent when none did. */
    http_version?: string;
    elapsed_ms?: number;
    assertions_passed: number;
    assertions_failed: number;
    failures: string[];
    /**
     * What the certificate was, on an exchange that had one.
     *
     * Absent for a cleartext exchange, which has no certificate and no answer to
     * give — the same distinction `status` makes between `0` and absent. Reported
     * per exchange rather than once per pass, because a pass may ask a service
     * over two ports and only one of them be TLS.
     */
    tls_verification?: TlsVerification;
    /** OpenSSL's spelling of what was wrong, when verification was off or failed. */
    tls_reason?: string;
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

/**
 * What an exchange's certificate was, as the bundle carries it.
 *
 * Spread rather than assigned, so a cleartext exchange carries no certificate
 * fields at all — `verification: "undetermined"` on a plaintext port would be a
 * claim about a certificate that does not exist, and it is the same distinction
 * `status` makes between `0` and absent.
 *
 * Reported whether or not this pass was asked to *enforce* the certificate, and
 * that is the point of the pair. A pass that reports `not_checked` with no reason
 * reads as a pass that did not look; this client looks either way, because Node
 * validates the chain whether or not the caller acts on the answer. So a bundle
 * carries what OpenSSL said beside the fact that nothing was done about it.
 */
const certificateOf = (
  tls: ToolTlsReport | undefined,
): { tls_verification?: TlsVerification; tls_reason?: string } =>
  tls === undefined
    ? {}
    : {
        tls_verification: tls.verification,
        ...(tls.reason === undefined ? {} : { tls_reason: tls.reason }),
      };

export const verify = async (input: VerifyInput, context: VerifyContext): Promise<VerifyResult> => {
  const recorder = createRecorder(context.now);
  const unverified: { question: string; reason: string }[] = [];
  // The workspace's own declaration of how its service is reached. Read through
  // the owner rather than derived from the feature list here, so a workspace that
  // declares `tls` is asked over HTTPS by every part of uvp that builds a URL
  // from one place. Absent for a directory with no manifest, which is a workspace
  // that still builds — cleartext is then the only thing that could be on the
  // port, and saying so is more honest than a scheme uvp invented.
  const read = await readWorkspaceManifest(input.path);
  const manifest = manifestOf(read);

  // A pass builds a workspace and then starts what it built, and the second half
  // cannot honour a container: the binary would be linked against the image's
  // libuvcpp at an in-image path, so it does not start here. Refusing is the
  // honest answer, and it is refused *before* the build rather than after it —
  // "the service never came up" is a verdict about a service, and this is not
  // one. Passing `toolchain: "local"` is how a caller says they know, and the
  // bundle then says `local` in its provider, so nothing about the pass claims
  // to be what the manifest asked for.
  if (
    selectToolchain({
      manifest,
      manifestProblem: manifestProblemOf(read),
      requested: input.toolchain,
    }).kind === "container"
  ) {
    const image =
      manifest?.toolchain?.kind === "container" ? manifest.toolchain.image : "its image";
    throw new UvpFailure({
      code: "unsupported_toolchain",
      message:
        `This workspace declares the container toolchain ${image}, and a verification pass cannot ` +
        "run what that build produces: a binary built inside an image carries an in-image " +
        "RUNPATH and does not start on this host.",
      remediation: {
        action:
          "Build with uvp_build and launch the binary inside the image, or pass " +
          'toolchain: "local" to check this workspace with this host\'s own compilers.',
      },
      details: { declared: manifest?.toolchain ?? null },
    });
  }

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

  const base = `${manifest?.scheme ?? "http"}://127.0.0.1:${String(input.run.port)}`;
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
          http_version: spec.http_version,
          follow_redirects: false,
          max_redirects: 0,
          // The caller's choice, defaulted to "do not enforce" in the contract.
          //
          // The instinct is the other way — a tool called `verify` should verify
          // — and it is wrong here for a reason that is specific to what this
          // pass is about. Its subject is what the service *does*; a certificate
          // is a fact about the deployment, and uvp's own templates serve a
          // development certificate that no client can verify. Enforcing by
          // default would make `uvp verify` fail against the workspace uvp had
          // just generated, which is a footgun rather than a check. So the
          // default is declared in the contract, the flag is the caller's, and
          // the certificate is reported either way: a chain this client would
          // not accept is visible in the bundle as `not_checked` with the reason
          // OpenSSL gave, and `--tls` is what turns it into part of the verdict.
          verify_tls: input.verify_tls,
          timeout_ms: 30_000,
          max_body_bytes: 1_048_576,
        },
        recorder,
        context.signal,
      )
      .catch((cause: unknown) => {
        const blockedBy = cause instanceof Error ? cause.message : String(cause);
        const question = `Does ${requestLabel(spec)} behave as asserted?`;
        recordUnknown(recorder, question, "not_attempted", { blockedBy });
        // Carried into the bundle as well as into the evidence, because
        // `unverified` is where a caller reads what the pass could not establish
        // and why. Without it the bundle says only "the request did not complete",
        // which is one sentence for several unrelated facts: a request refused
        // before it was made — `--http-version 3` against this pass's own
        // `http://` base URL, which QUIC cannot carry — a stack that is not on
        // this host, and a connection that dropped. A reader deciding whether to
        // retry needs the difference, and the exchange record is the only other
        // place it is written down.
        unverified.push({ question, reason: `the request did not complete: ${blockedBy}` });
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

    // A check that could not run is neither satisfied nor unmet, and the counts
    // below are what `verificationStatus` reads. Counting an unevaluable
    // assertion as a pass was the whole of this defect: the bundle reported
    // `verified` for a pass that compared nothing.
    const tally = tallyVerdicts(outcomes.map((outcome) => outcome.status));
    const unrun = outcomes.filter((outcome) => outcome.status === "undetermined");
    evaluated += tally.satisfied + tally.unmet;
    const failures = outcomes
      .filter((outcome) => outcome.status === "unmet")
      .map((outcome) => outcome.message);
    failed += failures.length;

    for (const outcome of unrun) {
      const question = unevaluatedQuestion(outcome, `for ${requestLabel(spec)}`);
      // Both places, for the same reason the request-failure branch above
      // writes both: `unverified` is what a reader of the bundle sees, and the
      // envelope's `unknowns` is what a reader of the tool result sees.
      unverified.push({
        question,
        reason: `the assertion could not be evaluated: ${outcome.message}`,
      });
      recordUnknown(recorder, question, "not_attempted", { blockedBy: outcome.message });
    }

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
        // The same three words the engine's outcomes and `uvp_assert_exchange`'s
        // rows use. Renaming them in two places and not this one would leave the
        // bundle spelling "nobody could tell" one way and the tool result it
        // came from spelling it another.
        satisfied: tally.satisfied,
        unmet: tally.unmet,
        undetermined: tally.undetermined,
      },
      derived: { elapsed_ms: Date.now() - startedAt },
      coverage:
        outcomes.length === 0
          ? coverageUnknown(`${spec.name} assertions`, "no assertions were supplied")
          : tally.undetermined === 0
            ? coverageComplete(`${spec.name} assertions`)
            : coveragePartial(
                `${spec.name} assertions`,
                `${String(tally.undetermined)} of ${String(outcomes.length)} assertion(s) could not be evaluated ` +
                  "against this exchange; each one names its own reason",
                tally.satisfied + failures.length,
                outcomes.length,
              ),
      sources: [endpointSource(url)],
      limitations: failures,
    });

    exchangeResults.push({
      name: spec.name,
      exchange_id: exchange.exchange_id,
      status: exchange.status,
      // What the wire reported, not what was asked for. The two differ whenever a
      // request for `2` reached a service that only speaks `1.1`.
      http_version: exchange.http_version,
      elapsed_ms: Date.now() - startedAt,
      assertions_passed: tally.satisfied,
      assertions_failed: failures.length,
      failures,
      ...certificateOf(exchange.tls),
    });
  }

  let cleanupFailed = false;
  if (!input.keep_running) {
    cleanupFailed = !(await stopQuietly(context, recorder, runResult.runId));
  } else
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
      : cleanupFailed
        ? [
            "The pass asked the service to stop, but it did not exit cleanly and may still be " +
              "listening. The evidence describes what it did while it was observed, not a process " +
              "that is gone.",
          ]
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
): Promise<boolean> => {
  try {
    const stopped = await context.workspace.stop({
      runId,
      all: false,
      graceMs: 3_000,
      force: true,
    });
    if (stopped.cleanupComplete) return true;
    recordUnknown(recorder, "Was the service stopped after the pass?", "not_attempted", {
      blockedBy: `${runId} did not exit cleanly; it may still be listening.`,
    });
    return false;
  } catch (cause) {
    recordUnknown(recorder, "Was the service stopped after the pass?", "not_attempted", {
      blockedBy: cause instanceof Error ? cause.message : String(cause),
    });
    return false;
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
