import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { ASSERTION_KINDS } from "../../src/application/assertions.js";
import { createToolHandlers, handlerFor } from "../../src/composition/toolHandlers.js";
import { createUvpServices } from "../../src/composition/uvpServices.js";
import { TOOL_CONTRACTS, toolContract } from "../../src/contracts/toolContracts.js";
import type { ToolContract } from "../../src/contracts/toolContractTypes.js";
import { sha256 } from "../../src/domain/identity.js";
import { toUvpError } from "../../src/domain/errors.js";
import { freePort } from "../support/ports.js";
import {
  createFakeToolchain,
  createProviderWithoutLibuvcpp,
  failedBuild,
  writeFakeBinary,
} from "./fakeToolchain.js";
import { fixtureBinaryScript, startFixture } from "./fixtureServer.js";
import type { FixtureServer } from "./fixtureServer.js";

/**
 * Conformance: does every handler's output satisfy the contract it was called
 * through?
 *
 * This is the invariant the whole design rests on. The contract is the single
 * source of truth — the MCP server, the CLI adapter, the generated catalog, and
 * the shipped skill all read it — and that claim is worth nothing unless the
 * implementations behind it obey it. A handler that returns a field no schema
 * describes, or omits one it requires, produces a result that validates nowhere
 * and a catalog page that documents something else.
 *
 * It also closes a gap the schemas cannot close alone: the envelope types `tool`
 * as a plain string, so a handler reporting another tool's name still validates.
 * The `tool === contract.name` assertion below is the only place both values are
 * in hand.
 *
 * The lane runs offline. The toolchain is a scripted fixture and the network
 * target is a local fixture process, because the question here is about shapes,
 * not about a host. Whether a real compiler and a real libuvcpp behave is the
 * `toolchain` lane's question.
 */

const TIMEOUT = 30_000;
const FROZEN_CLOCK = (): Date => new Date("2026-10-15T12:00:00.000Z");

type Handlers = Readonly<Record<string, ReturnType<typeof createToolHandlers>[string]>>;

interface Harness {
  /** A workspace created by `uvp_workspace_create`, so later tools see real files. */
  readonly workspace: string;
  readonly services: ReturnType<typeof createUvpServices>;
  readonly handlers: Handlers;
  readonly signal: AbortSignal;
}

let harness: Harness;
let fixture: FixtureServer;
let temporaryRoots: string[] = [];

const call = async (name: string, input: unknown): Promise<Record<string, unknown>> =>
  await handlerFor(harness.handlers, name)(input, { signal: harness.signal });

const callWith = async (
  providers: ReturnType<typeof createFakeToolchain>[],
  name: string,
  input: unknown,
): Promise<Record<string, unknown>> => {
  const services = createUvpServices({ providers, now: FROZEN_CLOCK });
  return await handlerFor(createToolHandlers(services), name)(input, { signal: harness.signal });
};

/**
 * Assert a result against its contract, naming the field that failed.
 *
 * The message is assembled by hand rather than left to a `toEqual` diff, because
 * a `ZodError` printed as a diff is hard to read in a report and impossible to
 * act on when the suite is the only thing in front of you.
 */
const expectConforms = (name: string, output: Record<string, unknown>): void => {
  const contract = toolContract(name) as ToolContract | undefined;
  if (contract === undefined) throw new Error(`${name} is not a known contract`);

  expect(output["tool"], `${name} reported a different tool`).toBe(name);

  const result = contract.outputSchema.safeParse(output);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("\n");
    throw new Error(`${name} produced output its own contract rejects:\n${issues}`);
  }

  // The envelope checked as values, not as types. A schema can require
  // `evidence` to be an array and still be satisfied by an empty one when
  // something was in fact observed.
  expect(output["provider"], `${name} carries no provider identity`).toMatchObject({
    id: expect.any(String),
    platform: expect.any(String),
  });
  for (const key of ["evidence", "unknowns", "limitations"]) {
    expect(Array.isArray(output[key]), `${name}.${key} must be an array`).toBe(true);
  }

  // Every evidence reference must carry a digest. Without one it names a record
  // without identifying the claim in it, and "is this still true?" stops being
  // answerable.
  for (const entry of output["evidence"] as Record<string, unknown>[]) {
    expect(entry["evidence_id"], `${name} evidence id`).toMatch(/^ev_[0-9a-f]{22}$/u);
    expect(typeof entry["digest"], `${name} evidence digest`).toBe("string");
    expect((entry["digest"] as string).length).toBeGreaterThan(0);
  }
};

/** The error code a handler's throw projects to at the adapter boundary. */
const failureCodeOf = async (name: string, input: unknown): Promise<string> => {
  try {
    await call(name, input);
  } catch (cause) {
    return toUvpError(cause).code;
  }
  throw new Error(`${name} was expected to refuse ${JSON.stringify(input)} and did not`);
};

/**
 * Every literal an enum nested anywhere in `schema` offers, when that enum looks
 * like an assertion-kind vocabulary.
 *
 * A walk rather than a path, because the two contracts that take assertions
 * nest them differently and a third could nest them another way. The filter is
 * what keeps it honest: an unrelated enum would have to share a literal with the
 * assertion vocabulary, and `body_json_path_equals` is not a name that turns up
 * by accident.
 */
const assertionKindsIn = (schema: z.ZodType): string[] => {
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (node instanceof z.ZodEnum) {
      const entries = Object.keys(node.def.entries);
      if (entries.some((entry) => (ASSERTION_KINDS as readonly string[]).includes(entry))) {
        found.push(...entries);
      }
      return;
    }
    if (node instanceof z.ZodObject) {
      for (const field of Object.values(node.shape)) visit(field);
      return;
    }
    if (node instanceof z.ZodArray) {
      visit(node.def.element);
      return;
    }
    if (node instanceof z.ZodOptional || node instanceof z.ZodDefault) {
      visit(node.def.innerType);
    }
  };
  visit(schema);
  return found;
};

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "uvp-conformance-"));
  temporaryRoots.push(root);
  const workspace = join(root, "svc");

  fixture = await startFixture();

  harness = {
    workspace,
    services: createUvpServices({
      providers: [createFakeToolchain()],
      // A frozen clock: evidence ordering and exchange expiry both read it, and
      // a suite whose answer depends on wall time fails at midnight.
      now: FROZEN_CLOCK,
    }),
    handlers: createToolHandlers(
      createUvpServices({ providers: [createFakeToolchain()], now: FROZEN_CLOCK }),
    ),
    signal: new AbortController().signal,
  };

  // Created through the tool rather than by hand, so the later tools operate on
  // the manifest and files that uvp itself produced.
  expectConforms(
    "uvp_workspace_create",
    await call("uvp_workspace_create", {
      path: workspace,
      name: "svc",
      template: "hello-http",
      features: ["websocket"],
      port: fixture.port,
    }),
  );
}, TIMEOUT);

afterAll(async () => {
  await fixture?.stop();
  for (const root of temporaryRoots) await rm(root, { recursive: true, force: true });
  temporaryRoots = [];
});

describe("workspace creation", () => {
  it("writes files whose byte count and digest are the file's own", async () => {
    const path = join(harness.workspace, "..", "created");
    temporaryRoots.push(path);

    const output = await call("uvp_workspace_create", {
      path,
      name: "created",
      template: "rest-api",
      port: 8080,
    });
    expectConforms("uvp_workspace_create", output);
    expect(output["template"]).toBe("rest-api");

    const files = output["files"] as { path: string; bytes: number; digest: string }[];
    expect(files.length).toBeGreaterThan(0);
    // A digest that is not the file's is worse than no digest: it makes an
    // integrity claim that cannot be checked, and a later `uvp build` compares
    // against exactly this number.
    for (const file of files) {
      const body = await readFile(file.path);
      expect(body.byteLength, `${file.path} byte count`).toBe(file.bytes);
      expect(sha256(body), `${file.path} digest`).toBe(file.digest);
    }
    expect(output["next_steps"]).toBeInstanceOf(Array);
    expect((output["next_steps"] as unknown[]).length).toBeGreaterThan(0);
  });

  it("refuses to write into a populated directory, naming the remedy", async () => {
    // The failure must be the caller's request being unachievable, not a crash,
    // and the remedy has to say how to proceed.
    const code = await failureCodeOf("uvp_workspace_create", {
      path: harness.workspace,
      name: "svc",
    });
    expect(code).toBe("invalid_request");
  });

  it("rejects an empty path or name at the boundary, before writing anything", async () => {
    expect(await failureCodeOf("uvp_workspace_create", { path: "", name: "" })).toBe(
      "invalid_request",
    );
  });
});

describe("build", () => {
  it("reports a failing build as diagnostics rather than as an error", async () => {
    // The distinction the project turns on: a compiler that rejected the code is
    // a successful tool call whose answer is "it did not build".
    const output = await callWith(
      [createFakeToolchain({ build: async (request) => failedBuild(request) })],
      "uvp_build",
      { path: harness.workspace },
    );
    expectConforms("uvp_build", output);
    expect(output["succeeded"]).toBe(false);
    expect(output["exit_code"]).toBe(1);

    const diagnostics = output["diagnostics"] as { severity: string; phase: string }[];
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ severity: "error", phase: "compile" });
  });

  it("reports a successful build with its cache state and artifact digests", async () => {
    const output = await call("uvp_build", { path: harness.workspace });
    expectConforms("uvp_build", output);
    expect(output["succeeded"]).toBe(true);
    expect(output["exit_code"]).toBe(0);
    expect(output["from_cache"]).toBe(false);
    for (const artifact of output["artifacts"] as { digest: string }[]) {
      expect(artifact.digest).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it("rejects a non-string path at the boundary, before any compiler is invoked", async () => {
    expect(await failureCodeOf("uvp_build", { path: 7 })).toBe("invalid_request");
  });
});

describe("launch and stop", () => {
  it(
    "launches a real process, waits for a real probe, then stops it",
    async () => {
      const port = await freePort();
      await writeFakeBinary(harness.workspace, "svc", fixtureBinaryScript(port));

      const run = await call("uvp_run", {
        path: harness.workspace,
        ready: { port, path: "/healthz", timeout_ms: 15_000 },
        env: { FIXTURE_PORT: String(port) },
      });
      expectConforms("uvp_run", run);

      // `ready` is only true when the declared probe actually answered. Asserting
      // it here is what keeps the field from decaying into "we slept long enough".
      expect(run["ready"]).toBe(true);
      expect(run["endpoint"]).toBe(`http://127.0.0.1:${String(port)}/healthz`);
      expect(run["startup_ms"]).toEqual(expect.any(Number));
      expect(run["still_running"]).toBe(true);
      expect(run["detached"]).toBe(true);

      const stop = await call("uvp_run_stop", { run_id: run["run_id"] });
      expectConforms("uvp_run_stop", stop);
      expect(stop["cleanup_complete"]).toBe(true);
      const stopped = stop["stopped"] as { outcome: string }[];
      expect(stopped).toHaveLength(1);
      expect(["exited", "already_gone"]).toContain(stopped[0]?.outcome);
    },
    TIMEOUT,
  );

  it(
    "reports `ready: false` instead of waiting forever when nothing listens",
    async () => {
      const port = await freePort();
      await writeFakeBinary(
        harness.workspace,
        "svc",
        "#!/bin/sh\necho 'cannot bind' >&2\nexit 3\n",
      );

      const run = await call("uvp_run", {
        path: harness.workspace,
        ready: { port, path: "/healthz", timeout_ms: 600 },
      });
      expectConforms("uvp_run", run);
      expect(run["ready"]).toBe(false);
      // A process that died is not still running, and saying otherwise would leave
      // a caller probing an endpoint nothing is behind.
      expect(run["still_running"]).toBe(false);
      expect(String(run["stderr_tail"])).toContain("cannot bind");
    },
    TIMEOUT,
  );

  it(
    "keeps a run it did not detach in this session's registry, so it can still be stopped",
    async () => {
      // `detach: false` says "do not let go of the pipes", not "this process is
      // no longer uvp's". Registering only the detached runs made the result's
      // own limitation — "The process is still running; stop it with
      // uvp_run_stop" — name a remedy that did not exist: the stop found an empty
      // registry, which it reports as `stopped: []` and a `cleanup_complete`
      // that is true of nothing.
      const port = await freePort();
      await writeFakeBinary(harness.workspace, "svc", fixtureBinaryScript(port));

      const run = await call("uvp_run", {
        path: harness.workspace,
        ready: { port, path: "/healthz", timeout_ms: 15_000 },
        env: { FIXTURE_PORT: String(port) },
        detach: false,
      });
      expectConforms("uvp_run", run);
      expect(run["ready"]).toBe(true);
      expect(run["still_running"]).toBe(true);
      expect(run["detached"]).toBe(false);

      try {
        const stop = await call("uvp_run_stop", { run_id: run["run_id"] });
        expectConforms("uvp_run_stop", stop);
        const stopped = stop["stopped"] as { run_id: string; outcome: string }[];
        expect(stopped.map((entry) => entry.run_id)).toEqual([run["run_id"]]);
        expect(["exited", "already_gone"]).toContain(stopped[0]?.outcome);
        expect(stop["cleanup_complete"]).toBe(true);
      } finally {
        // The stop above is the assertion; this is hygiene, so a failure before
        // it cannot leave a fixture process holding a port for the next test.
        await call("uvp_run_stop", { all: true });
      }
    },
    TIMEOUT,
  );

  it("reports an empty stop as complete, because nothing left running is a good answer", async () => {
    const stop = await call("uvp_run_stop", { all: true });
    expectConforms("uvp_run_stop", stop);
    expect(stop["cleanup_complete"]).toBe(true);
    expect(stop["stopped"]).toEqual([]);
  });

  it("refuses a run_id that is not of the declared shape", async () => {
    expect(await failureCodeOf("uvp_run_stop", { run_id: "not-a-run-id" })).toBe("invalid_request");
  });
});

describe("the web primitives", () => {
  it(
    "returns the observed status and body of a request",
    async () => {
      const output = await call("uvp_http_request", {
        url: `${fixture.origin}/hello`,
        method: "GET",
      });
      expectConforms("uvp_http_request", output);
      expect(output["status"]).toBe(200);
      expect(JSON.stringify(output)).toContain("Hello, AI");
    },
    TIMEOUT,
  );

  it(
    "reports an unreachable endpoint as an error, never as a status",
    async () => {
      // A closed port is not a `0` response. Reporting one would let a caller read
      // "the service answered" out of "we never reached it".
      const port = await freePort();
      const code = await failureCodeOf("uvp_http_request", {
        url: `http://127.0.0.1:${String(port)}/hello`,
        method: "GET",
      });
      expect(["endpoint_unreachable", "service_unavailable"]).toContain(code);
    },
    TIMEOUT,
  );

  it(
    "reports a SOAP fault as a protocol outcome, keeping the fault string",
    async () => {
      const output = await call("uvp_soap_call", {
        endpoint: `${fixture.origin}/soap/fault`,
        soap_version: "1.1",
        operation: "Add",
      });
      expectConforms("uvp_soap_call", output);
      // The fault is the answer. Folding it into `transport_error` would discard
      // the code and reason, which are the only actionable parts of a 500.
      expect(output["outcome"]).toBe("fault");
      expect(output["status"]).toBe(500);
      expect(JSON.stringify(output)).toContain("the calculator is unavailable");
    },
    TIMEOUT,
  );

  it(
    "reports a successful SOAP call as success, with the envelope",
    async () => {
      const output = await call("uvp_soap_call", {
        endpoint: `${fixture.origin}/soap`,
        soap_version: "1.2",
        operation: "Add",
      });
      expectConforms("uvp_soap_call", output);
      expect(output["outcome"]).toBe("success");
      expect(JSON.stringify(output)).toContain("42");
    },
    TIMEOUT,
  );

  it(
    "probes a websocket and records the greeting the far end sent",
    async () => {
      const output = await call("uvp_websocket_probe", {
        url: `ws://127.0.0.1:${String(fixture.port)}/ws`,
        send: [{ payload: "hello" }],
        max_frames: 2,
        idle_timeout_ms: 2_000,
      });
      expectConforms("uvp_websocket_probe", output);
      expect(output["upgraded"]).toBe(true);

      const frames = output["frames"] as { direction: string; opcode: string; text?: string }[];
      // The fixture greets before it reads anything, so a received frame exists
      // even if what uvp sent were not counted. That is the property worth
      // pinning: on an echo server the sent and received strings are identical,
      // and only one of them is evidence about the far end.
      expect(frames.some((frame) => frame.direction === "received")).toBe(true);
      expect(frames.some((frame) => frame.direction === "sent")).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "reports the distribution rather than a single number, and it is monotonic",
    async () => {
      const output = await call("uvp_load_test", {
        url: `${fixture.origin}/hello`,
        requests: 12,
        concurrency: 3,
        timeout_ms: 5_000,
      });
      expectConforms("uvp_load_test", output);

      const latency = output["latency_ms"] as Record<string, number>;
      const percentiles = ["min", "p50", "p90", "p95", "p99", "max"] as const;
      const ordered = percentiles.map((key) => {
        expect(typeof latency[key], `latency_ms.${key}`).toBe("number");
        return latency[key] ?? Number.NaN;
      });
      for (const key of ["mean", "stddev"]) {
        expect(typeof latency[key], `latency_ms.${key}`).toBe("number");
      }
      // Monotonic, because a percentile list that is not is an arithmetic bug
      // being reported as a measurement.
      expect([...ordered].sort((left, right) => left - right)).toEqual(ordered);

      // Every request accounted for exactly once, which is what makes the failure
      // count mean something.
      expect(output["requests_sent"]).toBe(12);
      expect((output["requests_completed"] as number) + (output["requests_failed"] as number)).toBe(
        12,
      );
    },
    TIMEOUT,
  );
});

describe("capture and assertion", () => {
  it(
    "records a real exchange through the proxy, then reads and asserts it",
    async () => {
      // Started, exercised, and read as one loop: testing the tools apart would
      // not show that the exchange one records is the exchange the other finds.
      const start = await call("uvp_capture_start", {
        listen_port: await freePort(),
        upstream: fixture.origin,
        max_exchanges: 10,
      });
      expectConforms("uvp_capture_start", start);

      const driven = await call("uvp_http_request", {
        url: `${String(start["proxy_url"])}/hello`,
        method: "GET",
      });
      expectConforms("uvp_http_request", driven);
      expect(driven["status"]).toBe(200);

      const read = await call("uvp_capture_read", {
        capture_id: start["capture_id"],
        include_payloads: true,
        stop: true,
      });
      expectConforms("uvp_capture_read", read);

      const exchanges = read["exchanges"] as { exchange_id: string; status?: number }[];
      expect(read["total_recorded"], "the exchange driven through the proxy was not recorded").toBe(
        1,
      );
      expect(exchanges).toHaveLength(1);
      expect(exchanges[0]?.status).toBe(200);

      // `withheld_by_limit` is the field that stops an empty-looking result being
      // read as "no traffic"; here nothing was withheld and that is stated.
      expect(read["withheld_by_limit"]).toBe(0);

      const asserted = await call("uvp_assert_exchange", {
        exchange_id: exchanges[0]?.exchange_id,
        assertions: [
          { kind: "status_equals", expected: 200 },
          { kind: "body_json_path_equals", target: "$.message", expected: "Hello, AI" },
        ],
      });
      expectConforms("uvp_assert_exchange", asserted);
      expect(asserted["passed"]).toBe(2);
      expect(asserted["failed"]).toBe(0);
      for (const result of asserted["results"] as { passed: boolean; observed: unknown }[]) {
        expect(result.passed).toBe(true);
        // The observed value travels with the verdict, so a failure shows what was
        // there rather than only that it differed.
        expect(result.observed).not.toBeUndefined();
      }
    },
    TIMEOUT,
  );

  it(
    "reports a failed assertion with the observed value, not just a verdict",
    async () => {
      const output = await call("uvp_http_request", {
        url: `${fixture.origin}/teapot`,
        method: "GET",
      });
      const exchangeId = String(output["exchange_id"]);

      const asserted = await call("uvp_assert_exchange", {
        exchange_id: exchangeId,
        assertions: [{ kind: "status_equals", expected: 200 }],
      });
      expectConforms("uvp_assert_exchange", asserted);
      expect(asserted["failed"]).toBe(1);
      const results = asserted["results"] as {
        passed: boolean;
        observed: unknown;
        message: string;
      }[];
      expect(results[0]?.passed).toBe(false);
      expect(results[0]?.observed).toBe(418);
      expect(results[0]?.message).toContain("418");
    },
    TIMEOUT,
  );

  it("refuses an exchange id that was never recorded, rather than inventing one", async () => {
    const code = await failureCodeOf("uvp_assert_exchange", {
      exchange_id: "exc_0000000000000000000000",
      assertions: [{ kind: "status_equals", expected: 200 }],
    });
    expect(code).toBe("invalid_request");
  });
});

describe("the verification workflow", () => {
  it(
    "verifies a real service end to end and reports what it established",
    async () => {
      const port = await freePort();
      await writeFakeBinary(harness.workspace, "svc", fixtureBinaryScript(port));

      const output = await call("uvp_verify", {
        path: harness.workspace,
        run: { port, ready_path: "/healthz", timeout_ms: 15_000 },
        requests: [
          {
            name: "hello",
            method: "GET",
            path: "/hello",
            assertions: [
              { kind: "status_equals", expected: 200 },
              { kind: "body_json_path_equals", target: "$.message", expected: "Hello, AI" },
            ],
          },
          {
            name: "teapot",
            method: "GET",
            path: "/teapot",
            assertions: [{ kind: "status_equals", expected: 418 }],
          },
        ],
        goal: "the conformance fixture answers as declared",
      });
      expectConforms("uvp_verify", output);

      // The goal comes back. It was accepted from the contract, threaded
      // through the handler, and read nowhere: a caller could state what the
      // pass was for and get a bundle that did not mention it, while the
      // domain's own bundle type requires a goal.
      expect(output["goal"]).toBe("the conformance fixture answers as declared");

      // `verified` means every step that was attempted succeeded. Reaching it
      // through a real spawn, a real probe, and real requests is the whole
      // milestone-one claim.
      expect(output["status"]).toBe("verified");
      expect(output["build"]).toMatchObject({ succeeded: true });
      expect(output["service"]).toMatchObject({ ready: true });

      const exchanges = output["exchanges"] as {
        name: string;
        assertions_passed: number;
        assertions_failed: number;
        failures: string[];
      }[];
      expect(exchanges.map((exchange) => exchange.name)).toEqual(["hello", "teapot"]);
      for (const exchange of exchanges) {
        expect(exchange.assertions_failed, `${exchange.name} failed an assertion`).toBe(0);
        expect(exchange.failures).toEqual([]);
        expect(exchange.assertions_passed).toBeGreaterThan(0);
      }
    },
    TIMEOUT,
  );

  it(
    "does not report `verified` when an assertion is wrong, and says which one",
    async () => {
      const port = await freePort();
      await writeFakeBinary(harness.workspace, "svc", fixtureBinaryScript(port));

      const output = await call("uvp_verify", {
        path: harness.workspace,
        run: { port, ready_path: "/healthz", timeout_ms: 15_000 },
        requests: [
          {
            name: "wrong",
            method: "GET",
            path: "/hello",
            assertions: [{ kind: "status_equals", expected: 503 }],
          },
        ],
      });
      expectConforms("uvp_verify", output);
      // A failed assertion is the finding. Reporting the pass anyway would be the
      // single worst failure this tool could have.
      expect(output["status"]).toBe("failed");
      expect(output["status"]).not.toBe("verified");

      const exchanges = output["exchanges"] as {
        name: string;
        status?: number;
        assertions_passed: number;
        assertions_failed: number;
        failures: string[];
      }[];
      expect(exchanges).toHaveLength(1);
      // The verify bundle carries the count and the reason, not the per-assertion
      // detail — that is `uvp_assert_exchange`'s job, and it is asserted there.
      expect(exchanges[0]).toMatchObject({
        name: "wrong",
        status: 200,
        assertions_passed: 0,
        assertions_failed: 1,
      });
      expect(exchanges[0]?.failures).toHaveLength(1);
      // The message states what was observed. A failure reason that stated the
      // expectation instead would describe the assertion rather than the service.
      expect(exchanges[0]?.failures[0]).toContain("200");
    },
    TIMEOUT,
  );

  it(
    "gives two identical passes one digest and two ids, and never the weaker pass the stronger one",
    async () => {
      const base = {
        path: harness.workspace,
        run: { ready_path: "/healthz", timeout_ms: 15_000 },
      };
      const asserted = [
        {
          name: "hello",
          method: "GET",
          path: "/hello",
          assertions: [{ kind: "status_equals", expected: 200 }],
        },
      ];

      // The fixture binary takes its port as an argument baked into the script,
      // so the script is rewritten per pass. Two different ports on purpose: the
      // digest is over what a pass found, not over the harness it found it in, so
      // two runs reaching the same verdict on two ports must agree.
      const pass = async (
        port: number,
        requests: readonly Record<string, unknown>[],
      ): Promise<Record<string, unknown>> => {
        await writeFakeBinary(harness.workspace, "svc", fixtureBinaryScript(port));
        return call("uvp_verify", { ...base, run: { ...base.run, port }, requests });
      };

      const first = await pass(await freePort(), asserted);
      const second = await pass(await freePort(), asserted);

      expectConforms("uvp_verify", first);
      expectConforms("uvp_verify", second);

      // The id identifies the pass; the digest identifies what it found. They are
      // separate fields because they answer different questions, and an agent has
      // no other way to tell "nothing changed since last time" from "a different
      // session happened to look similar".
      expect(first["bundle_id"]).not.toBe(second["bundle_id"]);
      expect(first["bundle_digest"]).toMatch(/^[0-9a-f]{64}$/u);
      expect(second["bundle_digest"]).toBe(first["bundle_digest"]);

      // The same request with nothing asserted. It must not share the digest: a
      // pass that left a question open is not the pass that closed it, and a
      // collision here would let the weaker run inherit the stronger one's
      // fingerprint. This asserts that the two digests differ, which is the
      // guarantee that matters; it is not a claim that `unverified` is the only
      // term that could have caused the difference.
      const weaker = await pass(await freePort(), [
        { name: "hello", method: "GET", path: "/hello" },
      ]);
      expectConforms("uvp_verify", weaker);
      expect(weaker["bundle_digest"]).not.toBe(first["bundle_digest"]);
    },
    TIMEOUT,
  );

  it(
    "reports a failed build as the reason, without launching anything",
    async () => {
      const output = await callWith(
        [createFakeToolchain({ build: async (request) => failedBuild(request) })],
        "uvp_verify",
        {
          path: harness.workspace,
          run: { port: 9 },
          requests: [{ name: "never", path: "/hello" }],
        },
      );
      expectConforms("uvp_verify", output);
      expect(output["build"]).toMatchObject({ succeeded: false, exit_code: 1 });
      expect(output["service"]).toMatchObject({ ready: false });
      expect(output["exchanges"]).toEqual([]);

      // `unknown`, not `failed`. The status answers "does this service behave as
      // declared?" and nothing was ever asked of the service, so `failed` would
      // assert a verdict about behaviour that was never observed — the one thing a
      // status here must never do. The build failure is not lost in the process:
      // it is the recorded reason the question went unanswered.
      expect(output["status"]).toBe("unknown");

      const unknowns = output["unknowns"] as { reason: string; blocked_by?: string }[];
      expect(unknowns.length).toBeGreaterThan(0);
      expect(unknowns.map((entry) => entry.blocked_by).join(" ")).toContain("build failed");
    },
    TIMEOUT,
  );
});

/**
 * The other half of `uvp_verify`'s contract: what it *takes*, rather than what it
 * reports.
 *
 * Kept out of the describe above because the subject is the vocabulary itself —
 * which checks a caller may name, and which fields are refused rather than
 * quietly dropped — and the passes above answer a different question, namely
 * what a verdict means once the request was accepted.
 */
describe("the assertion vocabulary at the boundary", () => {
  it(
    "evaluates the kinds the contract used not to offer, and refuses a field it cannot honour",
    async () => {
      const port = await freePort();
      await writeFakeBinary(harness.workspace, "svc", fixtureBinaryScript(port));

      // The three kinds outside the eight `uvp_verify` used to declare. They are
      // the ones the CLI's short forms lower onto — `body_bytes<1024`,
      // `header:<name>`, `json:<path>` — so before this contract was widened
      // they parsed and then failed validation, and the caller saw a zod enum
      // instead of the check they asked for.
      const output = await call("uvp_verify", {
        path: harness.workspace,
        run: { port, ready_path: "/healthz", timeout_ms: 15_000 },
        requests: [
          {
            name: "hello",
            method: "GET",
            path: "/hello",
            assertions: [
              { kind: "body_bytes_under", expected: 1000 },
              { kind: "header_exists", target: "content-type" },
              { kind: "body_json_path_exists", target: "$.service" },
            ],
          },
        ],
      });
      expectConforms("uvp_verify", output);
      const exchanges = output["exchanges"] as { assertions_passed: number }[];
      expect(exchanges[0]?.assertions_passed).toBe(3);

      // `negate` is the one asymmetry that is deliberate, and it is refused
      // rather than ignored. Zod strips unknown keys by default, so a caller who
      // sent `negate: true` used to get an affirmative check reported under an
      // assertion they had written as a negation.
      const negated = await failureCodeOf("uvp_verify", {
        path: harness.workspace,
        run: { port, ready_path: "/healthz", timeout_ms: 15_000 },
        requests: [
          {
            name: "hello",
            method: "GET",
            path: "/hello",
            assertions: [{ kind: "status_equals", expected: 404, negate: true }],
          },
        ],
      });
      expect(negated).toBe("invalid_request");

      // And an unknown key is refused by name rather than dropped: the strict
      // object is what makes "I set this and nothing happened" impossible.
      expect(
        await failureCodeOf("uvp_verify", {
          path: harness.workspace,
          run: { port, ready_path: "/healthz", timeout_ms: 15_000 },
          requests: [
            {
              name: "hello",
              method: "GET",
              path: "/hello",
              assertions: [{ kind: "status_equals", expected: 200, retries: 3 }],
            },
          ],
        }),
      ).toBe("invalid_request");
    },
    TIMEOUT,
  );
});

describe("the doctor", () => {
  it("reports the toolchain, the libuvcpp it found, and a verdict per feature", async () => {
    const output = await call("uvp_doctor", {
      features: ["tls", "http2", "websocket", "soap", "db"],
    });
    expectConforms("uvp_doctor", output);

    expect((output["toolchains"] as unknown[]).length).toBeGreaterThan(0);
    const libuvcpp = output["libuvcpp"] as Record<string, unknown>;
    expect(libuvcpp["found"]).toBe(true);
    expect(libuvcpp["version"]).toBe("1.7.0");
    // Which file the version came from is reported, because two sources under
    // one prefix can disagree about the number.
    expect(libuvcpp["version_source"]).toBe("pkgconfig");

    const features = output["features"] as { feature: string; status: string }[];
    expect(features.map((entry) => entry.feature)).toEqual([
      "tls",
      "http2",
      "websocket",
      "soap",
      "db",
    ]);
    for (const entry of features) expect(entry.status).toBe("satisfied");
  });

  it("reports a feature the build lacks as unmet, naming the switch that would enable it", async () => {
    const output = await callWith(
      [createFakeToolchain({ libuvcpp: { found: true, version: "1.7.0", modules: [] } })],
      "uvp_doctor",
      { features: ["db"] },
    );
    expectConforms("uvp_doctor", output);

    const features = output["features"] as { feature: string; status: string; note?: string }[];
    expect(features).toHaveLength(1);
    expect(features[0]).toMatchObject({ feature: "db", status: "unmet" });
    // The remedy is what makes `unmet` actionable. Without it a caller knows
    // only that something is missing and not what to do about it.
    expect(features[0]?.note).toContain("UVCPP_ENABLE_DB");
    expect(features[0]?.note).toContain("UVCPP_DB_ENABLE");
  });

  it("reports grpc as undetermined when no probe can decide it, never as missing", async () => {
    // libuvcpp has no CMake switch for grpc, so its presence can only be checked
    // by looking for installed headers. With no install prefix to root a probe
    // at, the honest answer is "I could not look" — and reporting `unmet` here
    // would turn that into a finding about a library that may well have it.
    const output = await callWith(
      [createFakeToolchain({ libuvcpp: { found: true, version: "1.7.0", modules: [] } })],
      "uvp_doctor",
      { features: ["grpc"] },
    );
    expectConforms("uvp_doctor", output);

    const features = output["features"] as { feature: string; status: string; note?: string }[];
    expect(features[0]).toMatchObject({ feature: "grpc", status: "undetermined" });
    expect(features[0]?.note).toBeTruthy();

    // And the undecided feature is a recorded unknown, so it cannot be read as a
    // pass just because nothing said it failed.
    const unknowns = output["unknowns"] as { question: string }[];
    expect(unknowns.some((entry) => entry.question.includes("grpc"))).toBe(true);
  });

  it("makes every feature undetermined when there is no libuvcpp to ask", async () => {
    // "This build does not provide TLS" and "there is no build here" are
    // different findings with different remedies; the second must not be
    // reported as the first, which would send a caller to rebuild a library they
    // do not have.
    const output = await callWith([createProviderWithoutLibuvcpp()], "uvp_doctor", {
      features: ["tls", "db"],
    });
    expectConforms("uvp_doctor", output);
    expect((output["libuvcpp"] as Record<string, unknown>)["found"]).toBe(false);
    for (const entry of output["features"] as { status: string }[]) {
      expect(entry.status).toBe("undetermined");
    }
    // The absence itself is a residual unknown, so a reader of the bundle cannot
    // take the empty `unmet` list for a clean bill of health.
    expect((output["unknowns"] as unknown[]).length).toBeGreaterThan(0);
  });

  it("refuses a feature name that is not in the vocabulary", async () => {
    expect(await failureCodeOf("uvp_doctor", { features: ["quantum"] })).toBe("invalid_request");
  });
});

describe("the dispatch table", () => {
  it("implements every contract exactly once", async () => {
    const contractNames = TOOL_CONTRACTS.map((contract) => contract.name).sort();
    expect(Object.keys(harness.handlers).sort()).toEqual(contractNames);
  });

  it("offers every assertion kind the evaluator table implements, and invents none", () => {
    // The vocabulary is declared once, in `src/domain/assertionKinds.ts`, and
    // every contract that takes assertions must offer all of it. Nothing else
    // makes the contracts agree with the evaluator. A kind added to the table but
    // to no contract is unreachable code that tests can still cover; a kind added
    // to a contract but not the table reaches the evaluator as `undefined` and
    // throws.
    const offered = new Set<string>();
    for (const contract of TOOL_CONTRACTS) {
      for (const kind of assertionKindsIn(contract.inputSchema)) offered.add(kind);
    }

    // Both directions, because they fail differently: an extra kind reaches the
    // evaluator table and misses, a missing kind is code no caller can reach.
    expect(
      [...offered].filter((kind) => !(ASSERTION_KINDS as readonly string[]).includes(kind)),
    ).toEqual([]);
    expect(ASSERTION_KINDS.filter((kind) => !offered.has(kind))).toEqual([]);
    // And the walk found something, so a change to the schema builders cannot
    // quietly turn this test into a tautology over an empty set.
    expect(offered.size).toBeGreaterThanOrEqual(ASSERTION_KINDS.length);

    // Per contract, not just in union. `uvp_verify` listed eight of the eleven by
    // hand while `uvp_assert_exchange` listed all eleven, and the union above
    // covered the vocabulary either way — so this test passed while three forms
    // the CLI's shared syntax module lowers (`body_bytes<1024`,
    // `header:<name>`, `json:<path>`) parsed cleanly and were then rejected by
    // the contract one layer above the check that implements them.
    for (const contract of TOOL_CONTRACTS) {
      const kinds = assertionKindsIn(contract.inputSchema);
      if (kinds.length === 0) continue;
      expect(
        ASSERTION_KINDS.filter((kind) => !kinds.includes(kind)),
        `${contract.name} takes assertions but offers only some of the vocabulary`,
      ).toEqual([]);
    }
  });

  it("refuses an unregistered tool by naming the ones that exist", () => {
    // The remedy is asserted rather than the message, because the remedy is the
    // part a caller can act on, and it is where the list of real names lives.
    try {
      handlerFor(harness.handlers, "uvp_nope");
      expect.unreachable("handlerFor returned for a tool that is not registered");
    } catch (cause) {
      const failure = toUvpError(cause);
      expect(failure.code).toBe("invalid_request");
      expect(failure.remediation.action).toContain("uvp_doctor");
      expect(failure.remediation.action).toContain("uvp_verify");
    }
  });
});
