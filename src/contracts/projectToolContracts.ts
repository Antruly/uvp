import { z } from "zod";

import { defineTool } from "./toolContractTypes.js";
import { toolEnvelopeShape } from "./toolOutputSchemaPrimitives.js";
import { ASSERTION_KINDS } from "../domain/assertionKinds.js";
import { UVP_FEATURES } from "../domain/features.js";
import { TOOLCHAIN_KINDS } from "../domain/toolchain.js";
import { WORKSPACE_NAME_MESSAGE, WORKSPACE_NAME_PATTERN } from "../domain/workspaceName.js";

const workspaceIdSchema = z.string().regex(/^wsp_[0-9a-f]{22}$/u);
const runIdSchema = z.string().regex(/^run_[0-9a-f]{22}$/u);

/**
 * Workspace creation.
 *
 * A workspace is a real CMake project that builds against libuvcpp — not a
 * snippet. Anything uvp generates must be something `cmake --build` accepts on
 * its own, so that a user can walk away from uvp and keep the code.
 */
export const workspaceCreateContract = defineTool({
  name: "uvp_workspace_create",
  title: "Create a libuvcpp workspace",
  description:
    "Scaffold a buildable C++ web service project wired against libuvcpp, with the requested " +
    "transport features enabled. Writes files and refuses to overwrite a non-empty directory " +
    "unless force is set. Returns the file manifest with digests and the routes the generated " +
    "service registers, so the first request can be made without reading the generated source.",
  kind: "workspace",
  inputSchema: z.object({
    path: z.string().min(1).describe("Absolute path to create the workspace at."),
    name: z
      .string()
      .min(1)
      .regex(WORKSPACE_NAME_PATTERN, WORKSPACE_NAME_MESSAGE)
      .describe(
        "Project name; used for the CMake target and the default binary name. " +
          WORKSPACE_NAME_MESSAGE,
      ),
    template: z
      .enum([
        "hello-http",
        "rest-api",
        "websocket-echo",
        "websocket-test",
        "soap-service",
        "static-files",
        "http3-service",
      ])
      .default("hello-http"),
    features: z
      .array(z.enum(UVP_FEATURES))
      .default(["websocket"])
      .describe(
        "Transport and service modules to build against. Each is checked against the installed " +
          "libuvcpp build, not assumed: a feature the build lacks is reported before compiling. " +
          "`db` also changes what the generated service keeps, on the one template that keeps " +
          "anything: `rest-api` is written with libuvcpp's connection pool in place of its " +
          "in-memory map, and the other templates carry it as a build requirement only.",
      ),
    port: z.number().int().min(1).max(65535).default(8080),
    force: z
      .boolean()
      .default(false)
      .describe("Allow writing into a directory that already contains files."),
  }),
  outputSchema: z.object({
    ...toolEnvelopeShape,
    workspace_id: workspaceIdSchema,
    path: z.string(),
    template: z.string(),
    files: z.array(z.object({ path: z.string(), bytes: z.number().int(), digest: z.string() })),
    /**
     * The routes the generated service registers, as `METHOD /path`.
     *
     * A first request has to guess otherwise: the smallest template answers
     * `GET /hello`, not `GET /`, and an unlisted path is a 404 from a service
     * that is working exactly as generated.
     */
    routes: z.array(z.string()),
    /** The exact command that turns this workspace into a running binary. */
    next_steps: z.array(z.string()),
  }),
  effects: {
    readsFilesystem: true,
    writesFilesystem: true,
    network: false,
    spawnsProcess: false,
    mutatesTarget: false,
  },
  examples: [
    {
      description: "A JSON API on port 8080 with WebSocket support",
      input: { path: "/home/dev/svc", name: "svc", template: "rest-api", port: 8080 },
    },
  ],
});

/**
 * Build.
 *
 * Build output is where most of uvp's evidence comes from. A build that fails
 * is a successful tool call: the diagnostics are the result. Only a failure to
 * run the toolchain at all is an error.
 *
 * ## Where the build happens
 *
 * A workspace whose `uvp.json` declares `{"toolchain": {"kind": "container",
 * "image": "..."}}` is built inside that image, which starts a container on this
 * host: the workspace is mounted at the same absolute path, the image's cmake
 * compiles it, and the artifacts land back in the caller's build directory. The
 * `spawnsProcess` effect below is what declares that — a container start is a
 * process on this host, not a network endpoint, and uvp never pulls an image:
 * one that is not present is reported as missing, with the runtime's own tooling
 * named as the way to fetch it.
 *
 * The `toolchain` input can require a container and can refuse one. It cannot
 * choose an image, because that is the one decision this tool deliberately
 * leaves to a file inside the workspace — see `selectToolchain` for why.
 */
export const buildContract = defineTool({
  name: "uvp_build",
  title: "Build a workspace",
  description:
    "Configure and build a uvp workspace with CMake, returning structured compiler diagnostics, " +
    "phase timings, and the digests of the produced artifacts. " +
    "A workspace that declares a container toolchain in uvp.json is built inside that image, " +
    "which starts a container on this host. " +
    "Compiler output is reported as data: a failing build returns diagnostics, not an error.",
  kind: "build",
  inputSchema: z.object({
    path: z.string().min(1),
    build_dir: z.string().optional().describe("Defaults to <path>/build."),
    build_type: z.enum(["Debug", "RelWithDebInfo", "Release"]).default("Debug"),
    toolchain: z
      .enum(TOOLCHAIN_KINDS)
      .optional()
      .describe(
        "Where to build. Defaults to what the workspace's uvp.json declares, and to this host " +
          "when it declares nothing. `container` insists on the image uvp.json names and fails " +
          "if it names none; `local` refuses a container the workspace asked for.",
      ),
    generator: z.enum(["ninja", "unix-makefiles", "msbuild"]).optional(),
    target: z.string().optional(),
    clean: z.boolean().default(false),
    jobs: z.number().int().min(1).optional(),
    timeout_ms: z.number().int().min(1000).default(600_000),
    /** Fail before configuring if the build would exceed this budget. */
    configure_only: z.boolean().default(false),
  }),
  outputSchema: z.object({
    ...toolEnvelopeShape,
    workspace_id: workspaceIdSchema,
    build_dir: z.string(),
    exit_code: z.number().int(),
    succeeded: z.boolean(),
    configure_duration_ms: z.number().int(),
    compile_duration_ms: z.number().int(),
    from_cache: z.boolean(),
    diagnostics: z.array(
      z.object({
        severity: z.enum(["error", "warning", "note"]),
        file: z.string().optional(),
        line: z.number().int().optional(),
        column: z.number().int().optional(),
        message: z.string(),
        /** Which phase produced it, so a parse failure is distinguishable from a link failure. */
        phase: z.enum(["configure", "compile", "link", "post"]),
      }),
    ),
    artifacts: z.array(z.object({ path: z.string(), bytes: z.number().int(), digest: z.string() })),
    commands: z.array(z.string()),
  }),
  effects: {
    readsFilesystem: true,
    writesFilesystem: true,
    network: false,
    spawnsProcess: true,
    mutatesTarget: false,
  },
  returnsTargetContent: true,
  examples: [
    {
      description: "Build a workspace with Ninja",
      input: { path: "/home/dev/svc", generator: "ninja" },
    },
  ],
});

/**
 * Launch.
 *
 * Readiness is established by observation, never by a sleep. `ready` is only
 * true when the declared readiness probe actually succeeded, and `startup_ms`
 * is measured from spawn to that success.
 */
export const runContract = defineTool({
  name: "uvp_run",
  title: "Run a built service",
  description:
    "Start a built service and hold it under uvp supervision. If a readiness probe is supplied, " +
    "the call returns only once the endpoint answers or the timeout expires; `ready` reports " +
    "which of those happened. Returns a run_id for later probing and cleanup.",
  kind: "runtime",
  inputSchema: z.object({
    path: z.string().min(1),
    build_dir: z.string().optional(),
    binary: z.string().optional().describe("Defaults to the workspace's declared binary."),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    ready: z
      .object({
        port: z.number().int().min(1).max(65535),
        path: z.string().default("/"),
        timeout_ms: z.number().int().min(100).default(10_000),
      })
      .optional(),
    detach: z
      .boolean()
      .default(true)
      .describe("Keep the process alive after the call returns, so it can be probed."),
  }),
  outputSchema: z.object({
    ...toolEnvelopeShape,
    workspace_id: workspaceIdSchema,
    run_id: runIdSchema,
    pid: z.number().int().optional(),
    /** Only true when the declared probe succeeded within the timeout. */
    ready: z.boolean(),
    endpoint: z.string().optional(),
    startup_ms: z.number().int().optional(),
    stdout_tail: z.string(),
    stderr_tail: z.string(),
    /** True when the service was still running at the end of the call. */
    still_running: z.boolean(),
    /**
     * True when the process was released rather than left under supervision.
     *
     * `still_running: true, detached: true` is the ordinary result of a
     * `detach: true` call over MCP: the service is up and can still be stopped
     * with `uvp_run_stop` in this session, but nothing observes its exit, so a
     * crash after this point reaches nobody. It is also the state that lets the
     * *CLI* exit — a detached child holds its parent's stdout pipe open, and a
     * CLI that kept that pipe would print this result and then hang.
     */
    detached: z.boolean(),
  }),
  effects: {
    readsFilesystem: true,
    writesFilesystem: true,
    network: true,
    spawnsProcess: true,
    mutatesTarget: true,
  },
  returnsTargetContent: true,
  examples: [
    {
      description: "Start on 8080 and wait until it answers",
      input: { path: "/home/dev/svc", ready: { port: 8080, path: "/healthz" } },
    },
  ],
});

/**
 * Stop. Kept separate from `uvp_run` so cleanup can be retried on its own, and
 * so a failed cleanup is reported rather than inferred from a run's absence.
 */
export const runStopContract = defineTool({
  name: "uvp_run_stop",
  title: "Stop a supervised service",
  description:
    "Stop a service started by uvp_run and report whether the process tree actually exited. " +
    "Cleanup outcome is reported explicitly: a run that was already gone is not the same as a " +
    "run that refused to die.",
  kind: "runtime",
  inputSchema: z.object({
    run_id: runIdSchema.optional(),
    all: z.boolean().default(false).describe("Stop every service this session started."),
    grace_ms: z.number().int().min(0).default(3_000),
    force: z.boolean().default(false).describe("Escalate to a hard kill after the grace period."),
  }),
  outputSchema: z.object({
    ...toolEnvelopeShape,
    stopped: z.array(
      z.object({
        run_id: runIdSchema,
        pid: z.number().int().optional(),
        exit_code: z.number().int().optional(),
        signal: z.string().optional(),
        killed: z.boolean(),
        /** `exited` | `already_gone` | `unresponsive` */
        outcome: z.enum(["exited", "already_gone", "unresponsive"]),
      }),
    ),
    cleanup_complete: z.boolean(),
  }),
  effects: {
    readsFilesystem: false,
    writesFilesystem: false,
    network: false,
    spawnsProcess: true,
    mutatesTarget: true,
  },
  examples: [{ description: "Stop everything this session started", input: { all: true } }],
});

/**
 * The verification workflow.
 *
 * This is the milestone-one deliverable in one call: create nothing, but build,
 * launch, exercise, and assert against an existing workspace, then hand back a
 * bundle whose status is honest about what was and was not established.
 */
/**
 * The shape of a saved verification report.
 *
 * Named once because two tools have to agree about it: the pass that writes one
 * (`uvp_verify`) and the comparison that reads two of them (`uvp_bundle_diff`).
 * A reader carrying its own idea of the shape would accept files the writer never
 * produces, and a field added here would reach the writer's callers before it
 * reached the reader's, which is how the two drift.
 */
export const verificationBundleShape = {
  ...toolEnvelopeShape,
  /**
   * The goal the caller gave, echoed back so the bundle says what it was for.
   *
   * Absent when the caller named none — not an empty string, which would read as
   * a goal somebody stated.
   */
  goal: z.string().optional(),
  workspace_id: workspaceIdSchema,
  bundle_id: z.string(),
  bundle_digest: z.string(),
  status: z.enum(["verified", "partial", "failed", "unknown"]),
  build: z.object({ succeeded: z.boolean(), exit_code: z.number().int() }),
  service: z.object({
    run_id: runIdSchema.optional(),
    ready: z.boolean(),
    endpoint: z.string().optional(),
  }),
  exchanges: z.array(
    z.object({
      name: z.string(),
      exchange_id: z.string(),
      status: z.number().int().optional(),
      /**
       * The protocol version the response actually arrived in — `"1.1"`, `"2.0"`.
       *
       * Absent for a request that never completed, because nothing negotiated
       * anything; that is a different record from a request answered over HTTP/1.1,
       * and the same distinction `status` makes between absent and `0`.
       *
       * Reported rather than left to the caller's `http_version` input, which says
       * what was *attempted*. A pass that asked for `2` and was answered over `1.1`
       * is exactly the pass a reader has to be able to see, and one field carrying
       * both meanings is a field that cannot report it.
       */
      http_version: z.string().optional(),
      /**
       * What the certificate was, on an exchange that had one.
       *
       * Absent for a cleartext exchange, which has no certificate and so has no
       * answer to give here — the same distinction `status` and `http_version`
       * make by being absent rather than `0`.
       */
      tls_verification: z.enum(["verified", "failed", "not_checked", "undetermined"]).optional(),
      /**
       * What OpenSSL said was wrong with the chain, in its own spelling.
       *
       * Present whenever it recorded a reason, which is not only when a chain
       * failed: `verify_tls: false` turns the verdict off, not the observation.
       * A pass that reports `not_checked` without this would be saying a chain
       * was not examined when it was examined and not acted on.
       */
      tls_reason: z.string().optional(),
      elapsed_ms: z.number().int().optional(),
      assertions_passed: z.number().int(),
      assertions_failed: z.number().int(),
      failures: z.array(z.string()),
    }),
  ),
  /** What the pass could not establish, each tied to a reason. */
  unverified: z.array(z.object({ question: z.string(), reason: z.string() })),
};

export const verificationBundleSchema = z.object(verificationBundleShape);

export const verifyContract = defineTool({
  name: "uvp_verify",
  title: "Build, run, exercise, and report",
  description:
    "Compose a full verification pass over an existing workspace: build it, start it, run the " +
    "given requests against it, evaluate the given assertions, then stop it. Returns an evidence " +
    "bundle whose status is `verified` only when every step that was attempted succeeded — " +
    "anything skipped is reported as a residual unknown instead of being silently omitted.",
  kind: "workflow",
  inputSchema: z.object({
    path: z.string().min(1),
    build: z
      .object({
        build_type: z.enum(["Debug", "RelWithDebInfo", "Release"]).default("Debug"),
        generator: z.enum(["ninja", "unix-makefiles", "msbuild"]).optional(),
      })
      .default({ build_type: "Debug" }),
    run: z.object({
      port: z.number().int().min(1).max(65535),
      ready_path: z.string().default("/"),
      timeout_ms: z.number().int().min(100).default(10_000),
      args: z.array(z.string()).default([]),
    }),
    requests: z
      .array(
        z.object({
          name: z.string(),
          method: z
            .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
            .default("GET"),
          path: z.string(),
          headers: z.record(z.string(), z.string()).default({}),
          body: z.string().optional(),
          http_version: z
            .enum(["auto", "1.1", "2", "3"])
            .default("auto")
            .describe(
              "The protocol version to attempt for this request: auto, 1.1, 2, or 3. What came " +
                "back is reported per exchange and is assertable with `http_version_equals`.",
            ),
          assertions: z
            .array(
              // Strict, and with `negate` declared in order to refuse it. Both
              // halves are the same rule: a field the caller set is never
              // dropped without being named. Zod's default is to strip unknown
              // keys, so `negate: true` used to reach the evaluator as nothing
              // at all and the check ran affirmatively under an assertion the
              // caller had written as a negation.
              z.strictObject({
                kind: z.enum(ASSERTION_KINDS),
                target: z
                  .string()
                  .optional()
                  .describe("Header name or JSONPath, for the kinds that take one."),
                // Optional, because two of the kinds carry no expectation:
                // `header_exists` and `body_json_path_exists` are presence
                // checks, which is what the CLI's `header:<name>` and
                // `json:<path>` forms lower to. A required key rejected both of
                // them one layer above the evaluator that implements them.
                expected: z.unknown().optional(),
                negate: z
                  .boolean()
                  .optional()
                  .refine((value) => value !== true, {
                    message:
                      "uvp_verify evaluates every assertion affirmatively and has no `negate`. " +
                      "Assert the value you expect instead, or record the exchange with " +
                      "uvp_http_request and negate it with uvp_assert_exchange.",
                  })
                  .describe("Refused: uvp_verify has no negated assertions."),
              }),
            )
            .default([]),
        }),
      )
      .min(1),
    /** Keep the service running after the pass, for interactive follow-up. */
    keep_running: z.boolean().default(false),
    goal: z.string().optional(),
    /**
     * Where to build, when the workspace's own declaration is not what the
     * caller wants. `local` is the only value that can do anything here: a pass
     * builds a workspace and then starts what it built, so it refuses a
     * container rather than pretending to honour one. It is declared with both
     * kinds because a flag whose vocabulary is half a vocabulary is a flag
     * callers have to guess at, and because `container` is exactly the value
     * whose refusal this field exists to explain.
     */
    toolchain: z
      .enum(TOOLCHAIN_KINDS)
      .optional()
      .describe(
        "Where to build. Defaults to what the workspace's uvp.json declares. `local` checks a " +
          "container-declared workspace with this host's compilers; `container` is refused, " +
          "because a pass runs what it builds and a container-built binary does not start here.",
      ),
    /**
     * Whether a certificate has to verify for the exchange to count.
     *
     * Off by default, and that is the opposite of `uvp_http_request`'s default
     * for a reason worth stating. The subject of a verification pass is the
     * service's behaviour, not this client's trust store; and the workspaces uvp
     * generates for `--features tls` serve a development certificate, so a pass
     * that enforced by default would fail against the workspace uvp had just
     * generated — a default that makes the tool's own output unusable is not a
     * safe default, it is a broken one. What the certificate was is reported per
     * exchange either way (`tls_verification`, `tls_reason`), so the default is
     * visible rather than silent, and `verify_tls: true` is what makes a rejected
     * chain part of the verdict instead of a note in it.
     */
    verify_tls: z
      .boolean()
      .default(false)
      .describe(
        "Require the certificate to verify. Off by default; the certificate is reported " +
          "per exchange either way.",
      ),
  }),
  outputSchema: verificationBundleSchema,
  effects: {
    readsFilesystem: true,
    writesFilesystem: true,
    network: true,
    spawnsProcess: true,
    mutatesTarget: true,
  },
  examples: [
    {
      description: "Verify a JSON endpoint and its 404 behaviour",
      input: {
        path: "/home/dev/svc",
        run: { port: 8080 },
        requests: [
          {
            name: "hello",
            path: "/hello",
            assertions: [
              { kind: "status_equals", expected: 200 },
              { kind: "body_json_path_equals", target: "$.message", expected: "Hello, AI" },
            ],
          },
        ],
      },
    },
  ],
});

/**
 * One side of a comparison: the file it came from, and what the pass said.
 *
 * Both digests are here because they are different claims. `byte_digest` is over
 * the file's raw bytes — it changes when a byte of the file changes.
 * `digest` is the pass's own semantic digest, which survives reformatting and is
 * what two passes are compared by.
 */
const reportedSideSchema = z.object({
  path: z.string(),
  bytes: z.number().int(),
  byte_digest: z.string(),
  bundle_id: z.string(),
  workspace_id: workspaceIdSchema,
  status: z.enum(["verified", "partial", "failed", "unknown"]),
  digest: z.string(),
  goal: z.string().optional(),
});

/**
 * One request, as a comparison reports it.
 *
 * `exchange_id` and `elapsed_ms` are absent rather than optional. They are
 * per-pass facts — one is minted for each exchange, the other is a stopwatch
 * reading — so a comparison that carried them could read them, and two passes
 * that established exactly the same things would appear to differ in both. The
 * full record stays in the file each side names.
 */
const exchangeSummarySchema = z.object({
  status: z.number().int().optional(),
  /**
   * The version that answered, as the wire spells it. Absent when none did.
   *
   * Compared, unlike `elapsed_ms`: a run of the same assertions over HTTP/1.1 and
   * the same run over HTTP/2 established the same verdict by different means, and
   * that is a difference a reader of the comparison needs and `bundle_digest`
   * deliberately does not encode.
   */
  http_version: z.string().optional(),
  assertions_passed: z.number().int(),
  assertions_failed: z.number().int(),
  failures: z.array(z.string()),
});

const diffedExchangeSchema = z.object({
  name: z.string(),
  change: z.enum(["unchanged", "changed", "added", "absent"]),
  changed_fields: z.array(
    z.enum(["status", "http_version", "assertions_passed", "assertions_failed", "failures"]),
  ),
  /** Whether the change reached a field `bundle_digest` reads. */
  verdict_changed: z.boolean(),
  before: exchangeSummarySchema.optional(),
  after: exchangeSummarySchema.optional(),
});

const diffedUnknownSchema = z.object({
  question: z.string(),
  change: z.enum(["unchanged", "changed", "added", "absent"]),
  before: z.string().optional().describe("The reason the earlier pass gave."),
  after: z.string().optional().describe("The reason the later pass gave."),
});

/**
 * Comparing two verification reports.
 *
 * The unit of comparison is a report `uvp_verify` wrote, addressed by the file
 * it is in, because a bundle is the one artifact that carries a semantic digest
 * — and a comparison built on anything else would answer a different question
 * from the one the digest answers.
 */
export const bundleDiffContract = defineTool({
  name: "uvp_bundle_diff",
  title: "Compare two verification reports",
  description:
    "Compare two reports from earlier `uvp_verify` passes: what the status was, what each " +
    "request returned, and which questions were left unanswered. Reports separately what the " +
    "pass's own semantic digest covers and what falls outside it, and says so plainly when two " +
    "reports are not comparable at all — a different workspace, or a digest that does not match " +
    "the contents it arrived with.",
  kind: "workflow",
  inputSchema: z.object({
    before: z
      .string()
      .min(1)
      .describe("Path to the report of the earlier pass, as `uvp verify --json` wrote it."),
    after: z.string().min(1).describe("Path to the report of the later pass."),
    include_unchanged: z
      .boolean()
      .default(false)
      .describe(
        "Report every request the two passes have between them rather than only the ones that " +
          "differ. The counts are reported either way, so nothing is hidden by filtering.",
      ),
  }),
  outputSchema: z.object({
    ...toolEnvelopeShape,
    before: reportedSideSchema,
    after: reportedSideSchema,
    /** False when a difference between the two cannot be read as a change in one subject. */
    comparable: z.boolean(),
    incomparable_because: z.array(z.string()),
    /** Whether each side's supplied digest matches the contents it arrived with. */
    digest_consistent: z.object({ before: z.boolean(), after: z.boolean() }),
    /** Absent when either digest is inconsistent — a comparison that was not made. */
    same_digest: z.boolean().optional(),
    outcome: z
      .enum(["identical", "changed", "incomparable"])
      .describe("`incomparable` takes precedence over the other two."),
    status_changed: z.boolean(),
    goal_changed: z.boolean(),
    order_changed: z.boolean(),
    build: z.object({
      changed: z.boolean(),
      before: z.object({ succeeded: z.boolean(), exit_code: z.number().int() }),
      after: z.object({ succeeded: z.boolean(), exit_code: z.number().int() }),
    }),
    service: z.object({
      changed: z.boolean(),
      before: z.object({ ready: z.boolean(), endpoint: z.string().optional() }),
      after: z.object({ ready: z.boolean(), endpoint: z.string().optional() }),
    }),
    exchanges: z.object({
      unchanged: z.number().int(),
      before_count: z.number().int(),
      after_count: z.number().int(),
      entries: z.array(diffedExchangeSchema),
    }),
    unverified: z.object({
      unchanged: z.number().int(),
      before_count: z.number().int(),
      after_count: z.number().int(),
      entries: z.array(diffedUnknownSchema),
    }),
    not_compared: z.array(z.string()),
  }),
  effects: {
    readsFilesystem: true,
    writesFilesystem: false,
    network: false,
    spawnsProcess: false,
    mutatesTarget: false,
  },
  examples: [
    {
      description: "What changed between a pass before a change and one after it",
      input: { before: "/tmp/pass-before.json", after: "/tmp/pass-after.json" },
    },
  ],
});
