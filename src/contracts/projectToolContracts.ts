import { z } from "zod";

import { defineTool } from "./toolContractTypes.js";
import { toolEnvelopeShape } from "./toolOutputSchemaPrimitives.js";
import { ASSERTION_KINDS } from "../domain/assertionKinds.js";
import { UVP_FEATURES } from "../domain/features.js";

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
    "unless force is set. Returns the file manifest with digests.",
  kind: "workspace",
  inputSchema: z.object({
    path: z.string().min(1).describe("Absolute path to create the workspace at."),
    name: z
      .string()
      .min(1)
      .describe("Project name; used for the CMake target and the default binary name."),
    template: z
      .enum(["hello-http", "rest-api", "websocket-echo", "soap-service", "static-files"])
      .default("hello-http"),
    features: z
      .array(z.enum(UVP_FEATURES))
      .default(["websocket"])
      .describe(
        "Transport and service modules to build against. Each is checked against the installed " +
          "libuvcpp build, not assumed: a feature the build lacks is reported before compiling.",
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
 */
export const buildContract = defineTool({
  name: "uvp_build",
  title: "Build a workspace",
  description:
    "Configure and build a uvp workspace with CMake, returning structured compiler diagnostics, " +
    "phase timings, and the digests of the produced artifacts. " +
    "Compiler output is reported as data: a failing build returns diagnostics, not an error.",
  kind: "build",
  inputSchema: z.object({
    path: z.string().min(1),
    build_dir: z.string().optional().describe("Defaults to <path>/build."),
    build_type: z.enum(["Debug", "RelWithDebInfo", "Release"]).default("Debug"),
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
  }),
  outputSchema: z.object({
    ...toolEnvelopeShape,
    /**
     * The goal the caller gave, echoed back so the bundle says what it was for.
     *
     * Absent when the caller named none — not an empty string, which would read
     * as a goal somebody stated.
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
        elapsed_ms: z.number().int().optional(),
        assertions_passed: z.number().int(),
        assertions_failed: z.number().int(),
        failures: z.array(z.string()),
      }),
    ),
    /** What the pass could not establish, each tied to a reason. */
    unverified: z.array(z.object({ question: z.string(), reason: z.string() })),
  }),
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
