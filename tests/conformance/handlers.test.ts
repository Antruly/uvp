import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { ASSERTION_KINDS } from "../../src/application/assertions.js";
import type {
  NativeProbeAvailability,
  NativeWebSocketProbe,
} from "../../src/application/NativeWebSocketProbe.js";
import type { ToolchainProvider } from "../../src/application/ToolchainProvider.js";
import { createToolHandlers, handlerFor } from "../../src/composition/toolHandlers.js";
import { createUvpServices } from "../../src/composition/uvpServices.js";
import { TOOL_CONTRACTS, toolContract } from "../../src/contracts/toolContracts.js";
import type { ToolContract } from "../../src/contracts/toolContractTypes.js";
import { sha256 } from "../../src/domain/identity.js";
import { toUvpError } from "../../src/domain/errors.js";
import { NativeProbeRunner } from "../../src/toolchains/native/NativeProbeRunner.js";
import { freePort } from "../support/ports.js";
import { removeTree } from "../support/temporaryTree.js";
import {
  createFakeToolchain,
  createProviderWithoutLibuvcpp,
  failedBuild,
  writeFakeBinary,
  writeFakeService,
} from "./fakeToolchain.js";
import type { FakeToolchainOptions } from "./fakeToolchain.js";
import { startFixture } from "./fixtureServer.js";
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

/**
 * The fake binary that fails to start, as the program it runs.
 *
 * A file rather than a shell script written here, because the workspace is
 * launched by this host and only some hosts start shell scripts. What the fake
 * does is the same either way, and `tests/support/fakeExecutable.ts` owns the
 * rest.
 */
const REFUSES_TO_BIND = fileURLToPath(new URL("./fixtures/refusesToBind.mjs", import.meta.url));

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
 * Call a tool with a signal that was aborted before the call, as a Ctrl-C that
 * arrived while the caller was still typing the request would be.
 *
 * The whole path below the adapter reads this signal, so this is how a cancelled
 * call is reproduced without timing a real interrupt against a real run.
 */
const callAborted = async (name: string, input: unknown): Promise<Record<string, unknown>> => {
  const controller = new AbortController();
  controller.abort();
  return await handlerFor(createToolHandlers(harness.services), name)(input, {
    signal: controller.signal,
  });
};

/** The same, with the interruption arriving `delayMs` into the call. */
const callAbortingAfter = async (
  delayMs: number,
  name: string,
  input: unknown,
): Promise<Record<string, unknown>> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), delayMs);
  try {
    return await handlerFor(createToolHandlers(harness.services), name)(input, {
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
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
  for (const root of temporaryRoots) await removeTree(root);
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
  it("refuses a stop with neither a run id nor all, instead of stopping every run", async () => {
    // `{}` is valid input: `all` defaults to false and `run_id` is optional. The
    // service used to read the absent id as "every run", so this input killed the
    // whole session. The CLI already refused it; this is the MCP surface's half.
    expect(await failureCodeOf("uvp_run_stop", {})).toBe("invalid_request");
  });

  it(
    "launches a real process, waits for a real probe, then stops it",
    async () => {
      const port = await freePort();
      const svc = await writeFakeService(harness.workspace, "svc", port);

      const run = await call("uvp_run", {
        path: harness.workspace,
        args: svc.args,
        ready: { port, path: "/healthz", timeout_ms: 15_000 },
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
      const svc = await writeFakeBinary(harness.workspace, "svc", { module: REFUSES_TO_BIND });

      const run = await call("uvp_run", {
        path: harness.workspace,
        args: svc.args,
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
      const svc = await writeFakeService(harness.workspace, "svc", port);

      const run = await call("uvp_run", {
        path: harness.workspace,
        args: svc.args,
        ready: { port, path: "/healthz", timeout_ms: 15_000 },
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
});

describe("the SOAP call", () => {
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
    "keeps the fault, the lossy text and the bytes together on a mangled envelope",
    async () => {
      // Three answers about one response that a caller needs at once: the call
      // faulted, the envelope it read is not the bytes that arrived, and those
      // bytes come with the answer. Dropping any one of them loses something —
      // the fault is the only actionable part of a 500, the loss explains a text
      // that does not match the digest, and the bytes are what a caller needs to
      // see what was actually there.
      const output = await call("uvp_soap_call", {
        endpoint: `${fixture.origin}/soap/fault-not-utf8`,
        soap_version: "1.1",
        operation: "Add",
      });
      expectConforms("uvp_soap_call", output);
      expect(output["outcome"]).toBe("fault");
      expect(output["status"]).toBe(500);
      const fault = output["fault"] as { reason?: string };
      expect(fault.reason).toContain("the calculator is");
      expect(fault.reason).toContain(String.fromCodePoint(0xff_fd));

      const body = output["body"] as { text?: string; base64?: string; text_lossy?: string };
      expect(body.text_lossy).toBe("invalid-utf8");
      // The byte the fixture put in the faultstring is in the envelope handed over,
      // which is the property that makes these bytes worth carrying: only they can
      // say what the decode replaced.
      const sent = Buffer.from(body.base64 ?? "", "base64");
      expect(sent.includes(0xff)).toBe(true);
      // Not a re-encoding of the text beside it: that would carry the replacement
      // character's own bytes instead of the byte they replaced, which is the
      // difference between the envelope as it arrived and the envelope as it read.
      expect(sent.equals(Buffer.from(body.text ?? "", "utf8"))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "cuts the envelope on bytes, so a cut character is reported and a clean cut is not",
    async () => {
      // Two envelopes that differ only in where a three-byte character sits,
      // relative to the 64 KiB cut: one under it, one straddling it. Both arrive
      // as a prefix, and only the second lost anything — which a cut on characters
      // could not tell apart, since it cannot land inside one.
      const bodyOf = async (route: string): Promise<Record<string, unknown>> => {
        const output = await call("uvp_soap_call", {
          endpoint: `${fixture.origin}${route}`,
          soap_version: "1.1",
          operation: "Long",
        });
        expectConforms("uvp_soap_call", output);
        return output["body"] as Record<string, unknown>;
      };

      const cut = await bodyOf("/soap/cut-envelope");
      expect(cut["truncated"]).toBe(true);
      expect(cut["text_lossy"]).toBe("truncated");
      expect(cut["text"]).toMatch(new RegExp(`${String.fromCodePoint(0xff_fd)}$`, "u"));
      // The bytes behind the text handed over: the first 64 KiB of the envelope as
      // it was sent, not a re-encoding of a text that ends in half a character.
      const handedOver = Buffer.from(cut["base64"] as string, "base64");
      expect(handedOver.byteLength).toBe(64 * 1024);
      expect(handedOver[64 * 1024 - 1]).toBe(0xe4);

      const boundary = await bodyOf("/soap/boundary-envelope");
      expect(boundary["truncated"]).toBe(true);
      expect(boundary["text_lossy"]).toBeUndefined();
      // Nothing lost on the way in, so there is nothing to hand over beside a text
      // that is already the bytes it was decoded from.
      expect(boundary["base64"]).toBeUndefined();
      expect(boundary["text"]).toMatch(/<$/u);
    },
    TIMEOUT,
  );

  it(
    "takes the envelope cap from the caller, and describes the same envelope at every cap",
    async () => {
      // The cap used to be fixed at 64 KiB, so a caller holding a fault from a
      // longer envelope had no way to ask for the document it came from. It is an
      // input now, and the row that closed asked what `bytes` and `digest` mean
      // once a caller can ask for more than they were already given: they are the
      // envelope's, not the prefix's, so asking for more changes how much of one
      // body a caller sees and nothing about which body it is. Three caps over one
      // route, because that agreement is the claim — the largest is past the
      // envelope, which is also what says the default really was a cut, and the
      // smallest cuts on a character boundary.
      const bodyOf = async (max?: number): Promise<Record<string, unknown>> => {
        const output = await call("uvp_soap_call", {
          endpoint: `${fixture.origin}/soap/cut-envelope`,
          soap_version: "1.1",
          operation: "Long",
          ...(max === undefined ? {} : { max_body_bytes: max }),
        });
        expectConforms("uvp_soap_call", output);
        return output["body"] as Record<string, unknown>;
      };

      const whole = await bodyOf(1024 * 1024);
      expect(Number(whole["bytes"])).toBeGreaterThan(64 * 1024);
      expect(whole["truncated"]).toBe(false);
      expect(Buffer.byteLength(whole["text"] as string, "utf8")).toBe(whole["bytes"]);
      // Whole and whole again: the decode replaced nothing, so there is nothing to
      // hand over beside a text that is already the bytes it came from.
      expect(whole["text_lossy"]).toBeUndefined();
      expect(whole["base64"]).toBeUndefined();

      const capped = await bodyOf();
      expect(capped["truncated"]).toBe(true);
      expect(capped["text_lossy"]).toBe("truncated");
      // The same body at a smaller cap. A caller who asked for too little can read
      // the name of the response off the answer and ask again for the rest.
      expect(capped["bytes"]).toBe(whole["bytes"]);
      expect(capped["digest"]).toBe(whole["digest"]);

      // A cap that lands on a character boundary is `truncated` and not lossy: the
      // cap makes a cut, and only a cut inside a character loses anything.
      const tiny = await bodyOf(32);
      expect(tiny["truncated"]).toBe(true);
      expect(tiny["bytes"]).toBe(whole["bytes"]);
      expect(tiny["digest"]).toBe(whole["digest"]);
      expect(tiny["text_lossy"]).toBeUndefined();
      expect(tiny["text"]).toBe((whole["text"] as string).slice(0, 32));
    },
    TIMEOUT,
  );

  it(
    "sends a caller-supplied envelope verbatim rather than rebuilding one",
    async () => {
      // The input that decides what goes on the wire. Without this, a client
      // that ignored `raw_envelope` and built an envelope from the (empty)
      // parameters would pass every other SOAP assertion here — the call still
      // succeeds, the response still parses, and the bytes a caller carefully
      // wrote are gone. The fixture returns what it received inside CDATA, so
      // the comparison is against the exact string, not a reconstruction.
      const envelope =
        '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
        '<soap:Body><Add xmlns="http://uvp.test/calc"><a>7</a><b>35</b></Add></soap:Body></soap:Envelope>';
      const output = await call("uvp_soap_call", {
        endpoint: `${fixture.origin}/soap/echo`,
        soap_version: "1.1",
        raw_envelope: envelope,
      });
      expectConforms("uvp_soap_call", output);
      expect((output["body"] as { text?: string }).text).toContain(`<![CDATA[${envelope}]]>`);
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
      // A clean envelope is handed over as text and nothing else: the bytes are in
      // the text, so a `base64` here would be a second copy of the answer.
      const body = output["body"] as { base64?: string; text_lossy?: string };
      expect(body.base64).toBeUndefined();
      expect(body.text_lossy).toBeUndefined();
    },
    TIMEOUT,
  );
});

describe("the websocket probe", () => {
  it(
    "stamps each frame where it happened rather than at the end of the probe",
    async () => {
      const output = await call("uvp_websocket_probe", {
        url: `ws://127.0.0.1:${String(fixture.port)}/ws?echo_delay_ms=200`,
        send: [{ payload: "hello" }],
        max_frames: 2,
        idle_timeout_ms: 2_000,
      });
      expectConforms("uvp_websocket_probe", output);

      const frames = output["frames"] as { direction: string; text?: string; at_ms: number }[];
      const greeting = frames.findIndex((frame) => frame.text === "fixture: greeting");
      const echo = frames.findIndex((frame) => frame.text === "fixture: hello");
      expect(greeting, "the fixture greeting is missing from the frame log").toBeGreaterThanOrEqual(
        0,
      );
      expect(echo, "the delayed echo is missing from the frame log").toBeGreaterThan(greeting);

      // The property the field exists for. The greeting arrived at the start and
      // the echo after the delay the fixture was told to wait, so the two must not
      // read as simultaneous: reporting the probe's total duration for every frame,
      // which is what this did, makes a 1 ms greeting and a 900 ms reply identical.
      expect(frames[echo]?.at_ms ?? 0).toBeGreaterThanOrEqual((frames[greeting]?.at_ms ?? 0) + 150);
      for (let index = 1; index < frames.length; index += 1) {
        expect(frames[index]?.at_ms ?? 0).toBeGreaterThanOrEqual(frames[index - 1]?.at_ms ?? 0);
      }
    },
    TIMEOUT,
  );

  it(
    "answers an expectation from received frames and names the one that failed",
    async () => {
      const met = await call("uvp_websocket_probe", {
        url: `ws://127.0.0.1:${String(fixture.port)}/ws`,
        send: [{ payload: "hello" }],
        max_frames: 2,
        idle_timeout_ms: 2_000,
        expect: ["greeting"],
      });
      expectConforms("uvp_websocket_probe", met);
      expect(met["expectations_met"]).toBe(true);

      // The index is into the frame log the caller was handed, and it names the
      // frame that answered the question — so a caller can go and read it.
      const frames = met["frames"] as { direction: string; text?: string }[];
      const answered = (met["expectations"] as { text: string; matched: boolean }[])[0];
      expect(answered?.matched).toBe(true);
      const answeredFrame =
        frames[
          (met["expectations"] as { matched_frame_index?: number }[])[0]?.matched_frame_index ?? -1
        ];
      expect(answeredFrame?.direction).toBe("received");
      expect(answeredFrame?.text).toContain("greeting");
    },
    TIMEOUT,
  );

  it(
    "does not count a frame uvp sent as the far end speaking",
    async () => {
      // The trap. The payload sent is byte-identical to the text expected — which is
      // what an echo server makes of every expectation — and the echo that could
      // have answered it is delayed past the point where the probe stops reading.
      // A matcher that reads the whole log instead of the received frames passes
      // this expectation against a server that never replied. The unmet
      // expectation is a field and not an error: the frame log showing why is the
      // point of the call.
      const output = await call("uvp_websocket_probe", {
        url: `ws://127.0.0.1:${String(fixture.port)}/ws?echo_delay_ms=400`,
        send: [{ payload: "fixture: hello" }],
        max_frames: 1,
        idle_timeout_ms: 2_000,
        expect: ["fixture: hello", "never spoken"],
      });
      expectConforms("uvp_websocket_probe", output);
      expect(output["expectations_met"]).toBe(false);

      const frames = output["frames"] as { direction: string; text?: string }[];
      expect(
        frames.some((frame) => frame.direction === "sent" && frame.text === "fixture: hello"),
      ).toBe(true);
      expect(
        frames.some(
          (frame) =>
            frame.direction === "received" && (frame.text ?? "").includes("fixture: hello"),
        ),
      ).toBe(false);
      expect(
        (output["expectations"] as { matched: boolean }[]).map((entry) => entry.matched),
      ).toEqual([false, false]);
    },
    TIMEOUT,
  );

  it(
    "reports the close code and reason the far end chose",
    async () => {
      const output = await call("uvp_websocket_probe", {
        url: `ws://127.0.0.1:${String(fixture.port)}/ws?close_code=1001&close_reason=going%20away`,
        send: [{ payload: "hi" }],
        idle_timeout_ms: 2_000,
      });
      expectConforms("uvp_websocket_probe", output);
      // A closing handshake the peer started is a clean end with a reason, and
      // both halves of the reason are the actionable part of the report.
      expect(output["closed_cleanly"]).toBe(true);
      expect(output["close"]).toEqual({ code: 1001, reason: "going away" });
    },
    TIMEOUT,
  );

  it(
    "reports a stopped call as cancelled, not as an endpoint that could not be reached",
    async () => {
      // The target is the fixture this whole file runs against, and it is
      // listening: every other test in this block proves that. So "could not be
      // reached" here is not a reading of the evidence but the absence of one. The
      // client ends an aborted probe with a transport error and no handshake, and
      // that is the same shape a refused connection produces — which is how an
      // interrupted probe came to tell the caller to go and check that their
      // service was up.
      const failure = await callAborted("uvp_websocket_probe", {
        url: `ws://127.0.0.1:${String(fixture.port)}/ws`,
        idle_timeout_ms: 2_000,
      }).then(
        () => undefined,
        (cause: unknown) => toUvpError(cause),
      );

      expect(failure, "the probe answered after its call had been cancelled").toBeDefined();
      expect(failure?.code).toBe("cancelled");
      expect(failure?.message).not.toMatch(/could not be reached/u);
    },
    TIMEOUT,
  );

  it(
    "keeps the frames a stopped probe collected, and says why it stopped",
    async () => {
      // A probe that got as far as the upgrade and was stopped before the peer was
      // done has evidence, and throwing it away would be its own kind of lie. What
      // it must not do is let the rest of the report read as the peer's behaviour:
      // `closed_cleanly: false` here means the log ends where the caller ended it,
      // and the unknown below is what says so.
      const output = await callAbortingAfter(250, "uvp_websocket_probe", {
        url: `ws://127.0.0.1:${String(fixture.port)}/ws`,
        // Something to send, because a probe given nothing to send closes as soon
        // as it has the handshake — it would end on its own before the abort.
        send: [{ payload: "hello" }],
        // Room for more frames than the fixture will send, for the same reason:
        // the default cap is small enough that the probe would end by itself and
        // this test would establish nothing about a stop.
        max_frames: 50,
        // Longer than the abort, so the idle deadline cannot be what ended the run.
        idle_timeout_ms: 10_000,
      });
      expectConforms("uvp_websocket_probe", output);

      expect(output["upgraded"]).toBe(true);
      const frames = output["frames"] as { text?: string }[];
      expect(frames.some((frame) => (frame.text ?? "").includes("greeting"))).toBe(true);
      expect(output["transport_error"]).toMatch(/cancelled/u);

      const unknowns = output["unknowns"] as { reason: string; question: string }[];
      const health = unknowns.find((entry) => entry.question.includes("stay healthy"));
      expect(health?.reason, "the connection-health question was given a bound's reason").toBe(
        "cancelled",
      );
    },
    TIMEOUT,
  );

  it(
    "reports a far end that left without a closing handshake as an observation",
    async () => {
      const output = await call("uvp_websocket_probe", {
        url: `ws://127.0.0.1:${String(fixture.port)}/ws?hangup=1`,
        idle_timeout_ms: 2_000,
      });
      expectConforms("uvp_websocket_probe", output);
      expect(output["upgraded"]).toBe(true);
      // No close frame arrived, so there is no code to report and the connection
      // did not end cleanly. A `closed_cleanly: true` here — or a manufactured
      // 1000 — would turn "the peer vanished" into "the peer said goodbye".
      expect(output["closed_cleanly"]).toBe(false);
      expect("close" in output).toBe(false);
    },
    TIMEOUT,
  );
});

/**
 * Reports the real probe wrote, recorded rather than invented.
 *
 * Each was produced by `native/uvcpp-probe` — built against libuvcpp 1.7.0 —
 * driven against the conformance fixture, and pasted here byte for byte. They
 * are goldens because the C++ side of the contract is not something a test can
 * assert into existence: the field names, the base64, `close.code` carrying a
 * 1006 when no Close frame arrived, and `abandoned` on an idle-ended run are
 * all facts about what that program does, and a hand-written report would only
 * be a fact about this file.
 *
 * They are fed back through the *real* `NativeProbeRunner` with its child
 * scripted, so the bytes go through the real parser on their way to the tool's
 * output. Nothing here is a transcription of the report into the port's shape,
 * which is where a golden quietly becomes a second implementation.
 *
 * The URL inside each report is the recording's, and deliberately left alone:
 * editing it would make the golden no longer verbatim. What the tool reports as
 * the request is the caller's URL, which the calls below supply.
 */
const RECORDED_VERSION =
  '{"abi_version":1,"header_abi_version":1,"library_version":"1.7.0","probe":"uvcpp-capi"}';

/** An idle-ended run: the fixture greeted and echoed, and the run timed out. */
const RECORDED_IDLE =
  '{"abandoned":true,"abi_version":1,"close_sent_by_probe":false,"error":null,"frames":' +
  '[{"at_ms":1,"bytes":5,"direction":"sent","opcode":"text","text":"hello","truncated":false},' +
  '{"at_ms":2,"bytes":17,"direction":"received","opcode":"text","text":"fixture: greeting","truncated":false},' +
  '{"at_ms":2,"bytes":14,"direction":"received","opcode":"text","text":"fixture: hello","truncated":false}],' +
  '"frames_received":2,"frames_withheld":0,"handshake_completed":true,"library_version":"1.7.0",' +
  '"not_observable":["the upgrade response\'s status line and headers","the negotiated subprotocol",' +
  '"ping and pong frames","request headers or subprotocols supplied by the caller",' +
  '"pacing a send after the previous one","the peer\'s answer to a close this probe sent"],' +
  '"opened":true,"peer_closed":false,"probe":"uvcpp-capi","stop_reason":"idle","total_ms":1365,' +
  '"url":"ws://127.0.0.1:34335/ws"}';

/** The peer closed first, with a code and a reason. */
const RECORDED_PEER_CLOSE =
  '{"abi_version":1,"close":{"code":1001,"reason":"going away"},"close_sent_by_probe":false,' +
  '"error":null,"frames":[{"at_ms":1,"bytes":2,"direction":"sent","opcode":"text","text":"hi","truncated":false},' +
  '{"at_ms":1,"bytes":17,"direction":"received","opcode":"text","text":"fixture: greeting","truncated":false}],' +
  '"frames_received":1,"frames_withheld":0,"handshake_completed":true,"library_version":"1.7.0",' +
  '"loop_return":1,"not_observable":["the upgrade response\'s status line and headers",' +
  '"the negotiated subprotocol","ping and pong frames","request headers or subprotocols supplied by the caller",' +
  '"pacing a send after the previous one","the peer\'s answer to a close this probe sent"],' +
  '"opened":true,"peer_closed":true,"probe":"uvcpp-capi","stop_reason":null,"total_ms":40,' +
  '"url":"ws://127.0.0.1:34335/ws?close_code=1001&close_reason=going%20away"}';

/** The peer vanished after the upgrade: one frame sent, nothing received. */
const RECORDED_HANGUP =
  '{"abi_version":1,"close":{"code":1006,"reason":""},"close_sent_by_probe":false,"error":null,' +
  '"frames":[{"at_ms":0,"bytes":12,"direction":"sent","opcode":"text","text":"never-echoed","truncated":false}],' +
  '"frames_received":0,"frames_withheld":0,"handshake_completed":true,"library_version":"1.7.0",' +
  '"not_observable":["the upgrade response\'s status line and headers","the negotiated subprotocol",' +
  '"ping and pong frames","request headers or subprotocols supplied by the caller",' +
  '"pacing a send after the previous one","the peer\'s answer to a close this probe sent"],' +
  '"opened":true,"peer_closed":true,"probe":"uvcpp-capi","stop_reason":null,"total_ms":20,' +
  '"url":"ws://127.0.0.1:34335/ws?hangup=1"}';

/** The URL the recorded reports were taken against. Nothing connects to it. */
const RECORDED_URL = "ws://127.0.0.1:34335/ws";

/** What the scripted child answers with: a report, or a report and an exit code. */
type ProbeAnswer = string | { readonly stdout: string; readonly exitCode: number };

/**
 * A native probe whose child is scripted, with the requests it was given.
 *
 * The reports are handed out in call order, so a run that probes twice needs
 * two. `--version` is answered from the recording unconditionally: this fake is
 * standing in for a probe that is *available*, and a test that wants the other
 * answer supplies a probe of its own.
 */
const nativeProbeFrom = (...answers: readonly ProbeAnswer[]) => {
  const requests: Record<string, unknown>[] = [];
  const remaining = [...answers];
  const runner = new NativeProbeRunner({
    env: { UVP_NATIVE_PROBE: process.execPath },
    runProcess: async (options) => {
      const answer = options.stdin === undefined ? RECORDED_VERSION : (remaining.shift() ?? "");
      const stdout = typeof answer === "string" ? answer : answer.stdout;
      const exitCode = typeof answer === "string" ? 0 : answer.exitCode;
      if (options.stdin !== undefined) {
        requests.push(JSON.parse(options.stdin) as Record<string, unknown>);
      }
      return {
        command: options.command,
        exitCode,
        signal: null,
        timedOut: false,
        aborted: false,
        durationMs: 1,
        stdout,
        stderr: "",
        stdoutBytes: stdout.length,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    },
  });
  return { probe: runner, requests };
};

/** Call a tool through services whose native probe is `probe`. */
const callNative = async (
  probe: NativeWebSocketProbe,
  name: string,
  input: unknown,
): Promise<Record<string, unknown>> => {
  const services = createUvpServices({
    providers: [createFakeToolchain()],
    now: FROZEN_CLOCK,
    nativeProbe: probe,
  });
  return await handlerFor(createToolHandlers(services), name)(input, { signal: harness.signal });
};

/** The failure a call projects to, with the words the caller would read. */
const refusalFrom = async (
  probe: NativeWebSocketProbe,
  input: unknown,
): Promise<{ code: string; message: string; details: Record<string, unknown> }> => {
  try {
    await callNative(probe, "uvp_websocket_probe", input);
  } catch (cause) {
    const error = toUvpError(cause);
    return {
      code: error.code,
      message: error.message,
      details: (error.details ?? {}) as Record<string, unknown>,
    };
  }
  throw new Error(`uvp_websocket_probe was expected to refuse ${JSON.stringify(input)}`);
};

/**
 * A probe that reports itself unusable, without running anything.
 *
 * The port is total: it answers with an outcome of `stack-unavailable` rather
 * than throwing, which is what the real runner does — a `probe()` that threw
 * would arrive at the caller as `execution_failure`, saying the probe failed
 * rather than that this host has none.
 */
const unusableProbe = (
  availability: Exclude<NativeProbeAvailability, { readonly state: "available" }>,
): NativeWebSocketProbe => ({
  availability: async () => availability,
  probe: async () => ({ kind: "stack-unavailable", ...availability }),
});

describe("the websocket probe on the native stack: can it run here", () => {
  it(
    "reports a host with no probe as a toolchain it cannot use",
    async () => {
      const failure = await refusalFrom(
        unusableProbe({ state: "unavailable", reason: "not built here" }),
        {
          url: RECORDED_URL,
          stack: "libuvcpp",
          idle_timeout_ms: 1_000,
        },
      );
      // `toolchain_unavailable`, which the CLI exits 2 on: the question could not
      // be put to the service. Reported as a fact about this host, with the
      // reason the check produced rather than a description of the target.
      expect(failure.code).toBe("toolchain_unavailable");
      expect(failure.message).toContain("not available on this host");
      expect(failure.message).toContain("not built here");
      expect(failure.details["state"]).toBe("unavailable");
    },
    TIMEOUT,
  );

  it(
    "says a probe that could not be checked is undetermined, not absent",
    async () => {
      // The third state, at the tool boundary. A probe binary that is on the host
      // and did not answer its version check has established nothing: "you have no
      // probe" would be a finding the check never produced, and the remedy for the
      // two is different.
      const failure = await refusalFrom(
        unusableProbe({
          state: "undetermined",
          reason: "--version did not answer within 5000 ms",
          path: "/opt/uvcpp-probe",
        }),
        { url: RECORDED_URL, stack: "libuvcpp" },
      );
      expect(failure.code).toBe("toolchain_unavailable");
      expect(failure.message).toContain("could not be determined");
      expect(failure.message).not.toContain("not available");
      expect(failure.details["state"]).toBe("undetermined");
      expect(failure.details["path"]).toBe("/opt/uvcpp-probe");
    },
    TIMEOUT,
  );

  it(
    "refuses a request this stack cannot serve, and asks the probe nothing",
    async () => {
      // The four ways a caller can ask for more than this stack has, each refused
      // *before* anything runs. The failure that matters here is the one that is
      // not a refusal: a probe that quietly dropped the caller's headers would
      // return a confident frame log for a request nobody made.
      const { probe, requests } = nativeProbeFrom(RECORDED_IDLE);
      const cases: readonly {
        readonly why: string;
        readonly names: RegExp;
        readonly input: unknown;
      }[] = [
        {
          why: "wss://, because the C ABI's client has no TLS",
          names: /wss:\/\//u,
          input: { url: "wss://127.0.0.1:34335/ws", stack: "libuvcpp" },
        },
        {
          why: "request headers",
          names: /request headers/u,
          input: { url: RECORDED_URL, stack: "libuvcpp", headers: { "X-Trace": "1" } },
        },
        {
          why: "subprotocols",
          names: /subprotocols/u,
          input: { url: RECORDED_URL, stack: "libuvcpp", subprotocols: ["chat"] },
        },
        {
          why: "a send paced after the previous one",
          names: /paced|wait_ms/u,
          input: {
            url: RECORDED_URL,
            stack: "libuvcpp",
            send: [
              { payload: "one", wait_ms: 0 },
              { payload: "two", wait_ms: 50 },
            ],
          },
        },
      ];

      for (const scenario of cases) {
        const failure = await refusalFrom(probe, scenario.input);
        expect(failure.code, scenario.why).toBe("invalid_request");
        expect(failure.message, scenario.why).toMatch(scenario.names);
      }

      // Nothing was spawned, for any of them. That is the property worth
      // asserting: a probe that ran and dropped the caller's headers would return
      // a confident frame log for a request nobody made, and the caller would have
      // no way to tell — so a refusal that is *decided* and not acted on is
      // indistinguishable, in the output, from no refusal at all.
      expect(requests).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "turns the probe's own refusal into the failure the caller acts on",
    async () => {
      // The probe refuses what it cannot honour, and uvp refuses the same requests
      // before spawning it. This is the layer underneath: a request that reaches
      // the probe and is turned down there arrives as `invalid_request` carrying
      // the probe's own words, rather than as a failed run or an empty report.
      // Recorded from the real binary — exit 2 with this report on stdout — and
      // replayed through the real parser.
      const RECORDED_PACING_REFUSAL =
        '{"error":{"what":"wait_ms between sends is not something the libuvcpp C ABI can do: ' +
        'the WebSocket client exposes no timer or post on its loop"},"probe":"uvcpp-capi"}';
      const { probe } = nativeProbeFrom({ stdout: RECORDED_PACING_REFUSAL, exitCode: 2 });

      const failure = await refusalFrom(probe, {
        url: RECORDED_URL,
        stack: "libuvcpp",
        idle_timeout_ms: 1_200,
      });
      expect(failure.code).toBe("invalid_request");
      expect(failure.message).toContain("exposes no timer or post on its loop");
    },
    TIMEOUT,
  );
});

describe("the websocket probe on the native stack: what the report says", () => {
  it(
    "maps a recorded run into the tool's output, absences and all",
    async () => {
      const { probe } = nativeProbeFrom(RECORDED_IDLE);
      const output = await callNative(probe, "uvp_websocket_probe", {
        url: RECORDED_URL,
        stack: "libuvcpp",
        send: [{ payload: "hello" }],
        idle_timeout_ms: 1_200,
      });
      expectConforms("uvp_websocket_probe", output);

      expect(output["stack"]).toBe("libuvcpp");
      expect(output["upgraded"]).toBe(true);
      // The stack cannot see the response that carried the upgrade, so there is no
      // handshake object at all. An empty one, or one with a 101 in it, would be a
      // status nobody observed.
      expect("handshake" in output).toBe(false);

      // The frame log, in order and with both directions: the recording's own
      // bytes, mapped.
      expect((output["frames"] as { text?: string }[]).map((frame) => frame.text)).toEqual([
        "hello",
        "fixture: greeting",
        "fixture: hello",
      ]);

      // The blind spots travel with the result. They came from the probe, in the
      // probe's words, which is what makes them a report about this stack rather
      // than a list this file invented.
      expect(output["not_observable"]).toContain("the upgrade response's status line and headers");

      // No Close frame arrived, so the connection did not end cleanly and there is
      // no code to report. `closed_cleanly: true` here would be a peer that said
      // goodbye in a run where nobody did.
      expect(output["closed_cleanly"]).toBe(false);
      expect("close" in output).toBe(false);

      // The run ended without its client loop returning. That is a gap in what was
      // read — the frame log stops where the evidence stops — so it is an unknown
      // with a question a caller could go and answer, not a silent ending.
      expect(output["abandoned"]).toBe(true);
      const unknowns = output["unknowns"] as { question: string; blocked_by?: string }[];
      expect(unknowns).toHaveLength(1);
      expect(unknowns[0]?.question).toMatch(/after the probe's last recorded frame/u);
      expect(unknowns[0]?.blocked_by).toMatch(/client loop never returned/u);
    },
    TIMEOUT,
  );

  it(
    "reads a closing handshake the peer sent, and the frame behind the code",
    async () => {
      const { probe } = nativeProbeFrom(RECORDED_PEER_CLOSE);
      const output = await callNative(probe, "uvp_websocket_probe", {
        url: RECORDED_URL,
        stack: "libuvcpp",
        idle_timeout_ms: 1_200,
      });
      expectConforms("uvp_websocket_probe", output);

      // 1001 is a code a Close frame carries. The frame itself is not observable
      // through the C ABI, so "a Close frame arrived" is *inferred* from the code
      // — the one direction that inference is sound in, since RFC 6455 §7.1.5
      // reserves 1006 for a close that had none.
      expect(output["close"]).toEqual({ code: 1001, reason: "going away" });
      expect(output["closed_cleanly"]).toBe(true);
      // The loop returned for this run, so nothing was left unread and there is no
      // gap to report.
      expect("abandoned" in output).toBe(false);
      expect(output["unknowns"]).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "does not read a peer that vanished as a peer that said goodbye",
    async () => {
      const { probe } = nativeProbeFrom(RECORDED_HANGUP);
      const output = await callNative(probe, "uvp_websocket_probe", {
        url: RECORDED_URL,
        stack: "libuvcpp",
        idle_timeout_ms: 1_200,
      });
      expectConforms("uvp_websocket_probe", output);

      // 1006 is the code for a connection that ended without a Close frame, and it
      // is the value that must not be read as one. The close is reported — it is
      // what the stack saw — and it is reported as not clean.
      expect(output["close"]).toEqual({ code: 1006, reason: "" });
      expect(output["closed_cleanly"]).toBe(false);
      expect(output["upgraded"]).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "answers an expectation from received frames only, on this stack too",
    async () => {
      // The trap, on the native path. The text expected is the text uvp *sent*,
      // and in this recording the peer answered nothing at all — so a matcher that
      // read the whole frame log, or one that lived in the probe and counted the
      // frames it queued, would satisfy this expectation against a service that
      // never spoke.
      const { probe } = nativeProbeFrom(RECORDED_HANGUP);
      const output = await callNative(probe, "uvp_websocket_probe", {
        url: RECORDED_URL,
        stack: "libuvcpp",
        send: [{ payload: "never-echoed" }],
        idle_timeout_ms: 1_200,
        expect: ["never-echoed"],
      });
      expectConforms("uvp_websocket_probe", output);

      expect((output["frames"] as { direction: string }[]).map((frame) => frame.direction)).toEqual(
        ["sent"],
      );
      expect(output["expectations"]).toEqual([{ text: "never-echoed", matched: false }]);
      expect(output["expectations_met"]).toBe(false);
    },
    TIMEOUT,
  );
});

describe("the load test", () => {
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

      // The timings the distribution was computed from come back with it. Without
      // them a p99 is a number the caller has to take on trust, and a mutation
      // that computed the quantiles from something else would be invisible.
      const samples = output["samples"] as number[];
      expect(output["samples_retained"]).toBe(samples.length);
      expect(output["samples_dropped"]).toBe(0);
      expect(samples.length).toBe(output["requests_completed"]);
      expect(latency["min"], "latency_ms.min is not the minimum of the samples").toBe(
        Math.min(...samples),
      );
      expect(latency["max"], "latency_ms.max is not the maximum of the samples").toBe(
        Math.max(...samples),
      );
      for (const key of percentiles) {
        expect(samples, `latency_ms.${key} is not one of the samples it came from`).toContain(
          latency[key],
        );
      }
    },
    TIMEOUT,
  );

  it(
    "keeps a bounded sample of a long run and says how much it did not keep",
    async () => {
      // A million-request run must not become a million-element response, and the
      // numbers must still describe what was measured rather than silently
      // describing the part that survived. Retained on a uniform stride, so this
      // is the same run as above with nine of every twelve samples dropped.
      const output = await call("uvp_load_test", {
        url: `${fixture.origin}/hello`,
        requests: 12,
        concurrency: 3,
        timeout_ms: 5_000,
        max_samples: 4,
      });
      expectConforms("uvp_load_test", output);

      const samples = output["samples"] as number[];
      expect(samples.length).toBeLessThanOrEqual(4);
      expect(output["samples_retained"]).toBe(samples.length);
      expect(output["samples_dropped"]).toBe(
        (output["requests_completed"] as number) - samples.length,
      );
      expect(output["samples_dropped"]).toBeGreaterThan(0);

      const latency = output["latency_ms"] as Record<string, number>;
      expect(latency["min"]).toBe(Math.min(...samples));
      expect(latency["max"]).toBe(Math.max(...samples));

      // A run whose distribution came from a subset of what it measured is a
      // partial scope, not a complete one. Reporting `complete` here would be the
      // "approximation presented as a measurement" this field exists to prevent.
      const coverage = (
        output["evidence"] as { coverage: { scope: string; status: string; note?: string } }[]
      ).find((entry) => entry.coverage.scope === "load test")?.coverage;
      expect(coverage?.status).toBe("partial");
      expect(coverage?.note).toContain(String(output["samples_dropped"]));
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
      expect(asserted["satisfied"]).toBe(2);
      expect(asserted["unmet"]).toBe(0);
      expect(asserted["undetermined"]).toBe(0);
      for (const result of asserted["results"] as { status: string; observed: unknown }[]) {
        expect(result.status).toBe("satisfied");
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
      expect(asserted["unmet"]).toBe(1);
      expect(asserted["satisfied"]).toBe(0);
      expect(asserted["undetermined"]).toBe(0);
      const results = asserted["results"] as {
        status: string;
        observed: unknown;
        message: string;
      }[];
      expect(results[0]?.status).toBe("unmet");
      expect(results[0]?.observed).toBe(418);
      expect(results[0]?.message).toContain("418");
    },
    TIMEOUT,
  );

  it(
    "reports an assertion it could not evaluate as undetermined, in a row of its own",
    async () => {
      // The check asks about a path the engine cannot walk, which is a limit of
      // the check rather than a value that differed. Counted as unmet it reports
      // the service as having answered something else, and counted as satisfied
      // it reports a check nobody performed — so it is its own row, in its own
      // state, and the count says how many of them there were.
      const output = await call("uvp_http_request", {
        url: `${fixture.origin}/hello`,
        method: "GET",
      });
      const exchangeId = String(output["exchange_id"]);

      const asserted = await call("uvp_assert_exchange", {
        exchange_id: exchangeId,
        assertions: [
          { kind: "status_equals", expected: 200 },
          { kind: "body_json_path_equals", target: "message", expected: "Hello, AI" },
        ],
      });
      expectConforms("uvp_assert_exchange", asserted);
      expect(asserted["satisfied"]).toBe(1);
      expect(asserted["unmet"]).toBe(0);
      expect(asserted["undetermined"]).toBe(1);
      // Both assertions are rows. The one that ran is not the only thing the
      // caller asked about, and a row count below the number of assertions asked
      // is what used to make a partial check read as a whole one.
      const rows = asserted["results"] as { kind: string; status: string; message: string }[];
      expect(rows).toHaveLength(2);
      expect(rows[1]?.status).toBe("undetermined");
      expect(rows[1]?.message).toContain("unsupported JSONPath");

      const unknowns = asserted["unknowns"] as { question: string; blocked_by?: string }[];
      expect(unknowns).toHaveLength(1);
      expect(unknowns[0]?.question).toContain("body_json_path_equals");
      expect(unknowns[0]?.blocked_by).toContain("unsupported JSONPath");

      // The evidence says how much of what was asked for was examined, which is
      // the field that stops a partial check reading as a whole one.
      const coverage = (asserted["evidence"] as { coverage: Record<string, unknown> }[])[0]
        ?.coverage;
      expect(coverage?.["status"]).toBe("partial");
      expect(coverage?.["examined"]).toBe(1);
      expect(coverage?.["total"]).toBe(2);
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

describe("the recording limit", () => {
  /**
   * The recording limit is not a transfer limit, and the difference matters.
   *
   * A capture that quietly cut what it forwarded would corrupt the very traffic
   * it exists to observe; a capture that quietly cut what it recorded, without
   * saying so, hands back a short body that reads as the body. These tests hold
   * both halves at once, because a change that fixed one by breaking the other
   * would pass either test alone.
   */
  it(
    "caps what it records, forwards whole, and says which records it cut",
    async () => {
      const limit = 1024;
      const payload = "a".repeat(4096);
      const start = await call("uvp_capture_start", {
        listen_port: await freePort(),
        upstream: fixture.origin,
        max_body_bytes: limit,
      });
      expectConforms("uvp_capture_start", start);
      expect(start["max_body_bytes"]).toBe(limit);

      const posted = await call("uvp_http_request", {
        url: `${String(start["proxy_url"])}/echo`,
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: payload,
      });
      expectConforms("uvp_http_request", posted);
      // The origin answered with the upload it received. If the proxy had
      // forwarded a body cut to the recording limit, this would be short — which
      // is exactly the failure that used to be silent.
      const echoed = JSON.parse(String((posted["body"] as { text: string }).text)) as {
        body: string;
      };
      expect(echoed.body, "the proxy forwarded a truncated request body").toHaveLength(4096);

      const fetched = await call("uvp_http_request", {
        url: `${String(start["proxy_url"])}/bulk?bytes=4096`,
        method: "GET",
      });
      expectConforms("uvp_http_request", fetched);

      const read = await call("uvp_capture_read", {
        capture_id: start["capture_id"],
        include_payloads: true,
        stop: true,
      });
      expectConforms("uvp_capture_read", read);
      expect(read["body_limit_bytes"], "the read did not name the limit it applied").toBe(limit);

      const exchanges = read["exchanges"] as {
        method: string;
        request_bytes: number;
        response_bytes: number;
        request_body?: string;
        response_body?: string;
        request_body_truncated: boolean;
        response_body_truncated: boolean;
      }[];
      expect(exchanges).toHaveLength(2);
      const [post, get] = exchanges;
      expect(post?.request_body_truncated).toBe(true);
      expect(post?.request_body, "a request body past the limit was returned whole").toHaveLength(
        limit,
      );
      expect(post?.request_bytes).toBe(limit);
      expect(get?.response_body_truncated).toBe(true);
      expect(get?.response_body, "a response body past the limit was returned whole").toHaveLength(
        limit,
      );
      expect(read["bodies_truncated"]).toBe(2);

      // The limit is reported as a partial scope, not as a complete read: what
      // came back is a prefix of the traffic, and a caller who reads a body
      // length off it would otherwise be reading a number about the limit.
      const evidence = read["evidence"] as {
        coverage: { scope: string; status: string; note?: string };
      }[];
      const coverage = evidence.find((entry) => entry.coverage.scope === "capture read")?.coverage;
      expect(coverage?.status).toBe("partial");
      expect(coverage?.note).toContain(String(limit));
      expect((read["limitations"] as string[]).join(" ")).toContain(String(limit));
    },
    TIMEOUT,
  );

  it(
    "returns a recorded body whole when it is inside the limit",
    async () => {
      // Above the 64 KiB the read used to cut at, below the session's own limit:
      // this is the range where a second, undocumented cap was invisible, and a
      // capture that reported `response_bytes: 100000` beside 64 KiB of text was
      // reporting two different bodies.
      const bytes = 100_000;
      const start = await call("uvp_capture_start", {
        listen_port: await freePort(),
        upstream: fixture.origin,
        max_body_bytes: 256 * 1024,
      });
      await call("uvp_http_request", {
        url: `${String(start["proxy_url"])}/bulk?bytes=${String(bytes)}`,
        method: "GET",
        timeout_ms: 20_000,
      });

      const read = await call("uvp_capture_read", {
        capture_id: start["capture_id"],
        include_payloads: true,
        stop: true,
      });
      expectConforms("uvp_capture_read", read);
      const [exchange] = read["exchanges"] as {
        response_bytes: number;
        response_body?: string;
        response_body_truncated: boolean;
      }[];
      expect(exchange?.response_body_truncated).toBe(false);
      expect(exchange?.response_body).toHaveLength(bytes);
      expect(exchange?.response_bytes, "the returned body and the recorded size disagree").toBe(
        bytes,
      );
      expect(read["bodies_truncated"]).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "refuses a request too long to forward whole, and records that it did",
    async () => {
      // Past the buffer the proxy needs in order to relay a body intact. The old
      // behaviour dropped the remainder and sent it upstream, so the origin
      // answered a truncated upload and the capture recorded the result as what
      // crossed the wire. A refusal is the only honest answer left, and it has to
      // be visible in the capture as well as to the client.
      const start = await call("uvp_capture_start", {
        listen_port: await freePort(),
        upstream: fixture.origin,
        max_body_bytes: 1024,
      });
      const oversized = Buffer.alloc(8 * 1024 * 1024 + 1, 0x62);
      const response = await fetch(`${String(start["proxy_url"])}/echo`, {
        method: "POST",
        body: oversized,
      });
      const text = await response.text();
      expect(response.status, "an unforwardable upload was not refused").toBe(413);
      expect(text).toContain("exceeded");

      const read = await call("uvp_capture_read", {
        capture_id: start["capture_id"],
        include_payloads: false,
        stop: true,
      });
      expectConforms("uvp_capture_read", read);
      const [exchange] = read["exchanges"] as {
        status?: number;
        error?: string;
        request_bytes: number;
        request_body_truncated: boolean;
      }[];
      expect(exchange?.error, "the refusal was not recorded as an exchange").toContain("exceeded");
      expect(exchange?.status, "a refused request was recorded as having a status").toBeUndefined();
      expect(exchange?.request_bytes).toBe(1024);
      expect(exchange?.request_body_truncated).toBe(true);
    },
    TIMEOUT,
  );
});

describe("the retention caps", () => {
  /**
   * A capture session keeps a bounded window, and the bound is the caller's.
   *
   * `max_body_bytes` limits one exchange and says nothing about how many of them
   * accumulate: at the 1 MiB default recording limit, an hour of traffic is a
   * process holding gigabytes it never mentions. These tests drive the session
   * past its budget with small bodies, so what is checked is the bound and the
   * reporting of it rather than the amount of traffic needed to reach a default.
   */

  const perBody = 8 * 1024;
  const budget = 20 * 1024;

  /** A session that holds two of these responses and no more. */
  const startBounded = async (): Promise<Record<string, unknown>> =>
    await call("uvp_capture_start", {
      listen_port: await freePort(),
      upstream: fixture.origin,
      max_body_bytes: perBody,
      max_retained_bytes: budget,
    });

  const bulk = async (proxyUrl: string): Promise<void> => {
    await call("uvp_http_request", {
      url: `${proxyUrl}/bulk?bytes=${String(perBody)}`,
      method: "GET",
      timeout_ms: 20_000,
    });
  };

  it(
    "holds a bounded window and reports every exchange the bound dropped",
    async () => {
      const start = await startBounded();
      expectConforms("uvp_capture_start", start);

      for (let index = 0; index < 5; index += 1) await bulk(String(start["proxy_url"]));

      const read = await call("uvp_capture_read", {
        capture_id: start["capture_id"],
        stop: true,
      });
      expectConforms("uvp_capture_read", read);

      // Five exchanges were recorded; two 8 KiB responses fit in a 20 KiB budget
      // and the third would not, so the oldest three are gone. The byte budget is
      // the bound that binds here — the count ceiling is thousands away.
      expect(read["total_recorded"], "the session did not count what it saw").toBe(5);
      expect(read["exchanges"]).toHaveLength(2);
      expect(read["withheld_by_retention"]).toBe(3);
      expect(read["retained_limit_bytes"]).toBe(budget);
      expect(
        read["retained_bytes"],
        "the session held more than the budget allows",
      ).toBeLessThanOrEqual(budget);

      // The counts a caller would add up to decide whether the page is the whole
      // truth. If they do not reconcile, one of them is describing something else.
      expect(
        (read["exchanges"] as unknown[]).length +
          (read["withheld_by_limit"] as number) +
          (read["withheld_by_retention"] as number),
        "the returned, withheld, and dropped counts do not add up to the total",
      ).toBe(read["total_recorded"]);

      // A page that is short because the session dropped the rest must not read
      // as a complete answer, and the note has to say which of the two it was.
      const coverage = (
        read["evidence"] as { coverage: { scope: string; status: string; note?: string } }[]
      ).find((entry) => entry.coverage.scope === "capture read")?.coverage;
      expect(coverage?.status).toBe("partial");
      expect(coverage?.note).toContain("retention");
      expect((read["limitations"] as string[]).join(" ")).toContain(
        `${String(budget)} bytes of recorded bodies`,
      );
    },
    TIMEOUT,
  );

  it(
    "reports a cursor the retention window has dropped instead of restarting silently",
    async () => {
      const start = await startBounded();
      await bulk(String(start["proxy_url"]));

      // The first exchange, read back while it is still held, so the test has an
      // id the session is about to lose.
      const first = await call("uvp_capture_read", { capture_id: start["capture_id"] });
      expectConforms("uvp_capture_read", first);
      const dropped = (first["exchanges"] as { exchange_id: string }[])[0]?.exchange_id;
      expect(dropped).toBeDefined();

      for (let index = 0; index < 4; index += 1) await bulk(String(start["proxy_url"]));

      const read = await call("uvp_capture_read", {
        capture_id: start["capture_id"],
        since_id: dropped,
        stop: true,
      });
      expectConforms("uvp_capture_read", read);

      // Answering this with "here is everything from the beginning" would read as
      // continuity from a position that no longer exists — and the exchanges in
      // that page are ones the caller has already seen.
      expect(read["since_id_unknown"]).toBe(true);
      expect((read["exchanges"] as unknown[]).length).toBe(2);
      expect((read["limitations"] as string[]).join(" ")).toContain("since_id");
      const coverage = (
        read["evidence"] as { coverage: { scope: string; status: string; note?: string } }[]
      ).find((entry) => entry.coverage.scope === "capture read")?.coverage;
      expect(coverage?.status).toBe("partial");

      // The positive control: a cursor the session still holds is not reported as
      // unknown, and the page starts after it. Without this the flag could be a
      // constant and every assertion above would still pass.
      const held = (read["exchanges"] as { exchange_id: string }[])[0]?.exchange_id;
      const after = await call("uvp_capture_read", {
        capture_id: start["capture_id"],
        since_id: held,
        stop: true,
      });
      expectConforms("uvp_capture_read", after);
      expect(after["since_id_unknown"]).toBe(false);
      expect((after["exchanges"] as unknown[]).length).toBe(1);
    },
    TIMEOUT,
  );
});

/**
 * The two requests the verification pass below makes.
 *
 * One that the fixture answers as declared and one that it answers with the other
 * status, so a handler that reported every exchange as verified — or none of them
 * — fails here rather than only in the counts.
 */
const FIXTURE_REQUESTS = [
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
];

describe("the verification workflow", () => {
  it(
    "verifies a real service end to end and reports what it established",
    async () => {
      const port = await freePort();
      const svc = await writeFakeService(harness.workspace, "svc", port);

      const output = await call("uvp_verify", {
        path: harness.workspace,
        run: { args: svc.args, port, ready_path: "/healthz", timeout_ms: 15_000 },
        requests: FIXTURE_REQUESTS,
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
      const svc = await writeFakeService(harness.workspace, "svc", port);

      const output = await call("uvp_verify", {
        path: harness.workspace,
        run: { args: svc.args, port, ready_path: "/healthz", timeout_ms: 15_000 },
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

      // The port reaches the fake as its program's first argument, so a pass
      // installs it for the port it is about to probe. Two different ports on
      // purpose: the digest is over what a pass found, not over the harness it
      // found it in, so two runs reaching the same verdict on two ports must
      // agree.
      const pass = async (
        port: number,
        requests: readonly Record<string, unknown>[],
      ): Promise<Record<string, unknown>> => {
        const svc = await writeFakeService(harness.workspace, "svc", port);
        return call("uvp_verify", {
          ...base,
          run: { ...base.run, port, args: svc.args },
          requests,
        });
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
 * Assertions the pass could not evaluate, kept out of the workflow's own
 * describe because the subject is not what a verdict means but which checks are
 * allowed to produce one.
 *
 * `failed` is a claim about the service and `verified` is a claim about the
 * goal. A check that never ran can support neither, so it has to reach the
 * caller as a third state — and these are the two ends of that slope: part of
 * the goal unexamined, and all of it.
 */
describe("a verification pass whose assertions could not all be evaluated", () => {
  it(
    "does not count an assertion it could not evaluate as a failure, and says so",
    async () => {
      // `target: "message"` is not a JSONPath, so the engine cannot walk it and
      // compares nothing. Before this was modelled, the pass reported
      // `assertions_failed: 1` and status `failed` — a finding about the
      // service derived from a limit of the check, which is the direction of
      // error this framework exists to prevent.
      const port = await freePort();
      const svc = await writeFakeService(harness.workspace, "svc", port);

      const output = await call("uvp_verify", {
        path: harness.workspace,
        run: { args: svc.args, port, ready_path: "/healthz", timeout_ms: 15_000 },
        requests: [
          {
            name: "hello",
            method: "GET",
            path: "/hello",
            assertions: [
              { kind: "status_equals", expected: 200 },
              { kind: "body_json_path_equals", target: "message", expected: "Hello, AI" },
            ],
          },
        ],
      });
      expectConforms("uvp_verify", output);
      // Not `failed`, which is the defect; and not `verified`, which would be
      // the same defect wearing the other face. The pass examined part of what
      // it was asked to examine, and `partial` is that fact.
      expect(output["status"]).toBe("partial");

      const exchanges = output["exchanges"] as {
        assertions_passed: number;
        assertions_failed: number;
        failures: string[];
      }[];
      expect(exchanges[0]?.assertions_passed).toBe(1);
      expect(exchanges[0]?.assertions_failed).toBe(0);
      // The reason belongs to the check, so it is not a failure of the service
      // and has no place in the list of things the service did wrong.
      expect(exchanges[0]?.failures).toEqual([]);

      // It is still stated. A pass that quietly dropped the question would be
      // reporting less than it was asked about without saying which part.
      const unverified = output["unverified"] as { question: string; reason: string }[];
      expect(unverified).toHaveLength(1);
      expect(unverified[0]?.question).toContain("body_json_path_equals");
      expect(unverified[0]?.question).toContain("hello");
      expect(unverified[0]?.reason).toContain("could not be evaluated");
    },
    TIMEOUT,
  );

  it(
    "reports a pass whose every assertion was unevaluable as unknown, not as verified",
    async () => {
      // The end of the same slope. Nothing was compared, so nothing was
      // established, and the pass says so rather than reporting the absence of
      // failures as success.
      const port = await freePort();
      const svc = await writeFakeService(harness.workspace, "svc", port);

      const output = await call("uvp_verify", {
        path: harness.workspace,
        run: { args: svc.args, port, ready_path: "/healthz", timeout_ms: 15_000 },
        requests: [
          {
            name: "hello",
            method: "GET",
            path: "/hello",
            assertions: [{ kind: "body_json_path_exists", target: "message" }],
          },
        ],
      });
      expectConforms("uvp_verify", output);
      expect(output["status"]).toBe("unknown");
      const exchanges = output["exchanges"] as { assertions_passed: number }[];
      expect(exchanges[0]?.assertions_passed).toBe(0);
      expect((output["unverified"] as unknown[]).length).toBe(1);
    },
    TIMEOUT,
  );
});

/**
 * A pass that was stopped, kept out of the workflow's own describe because the
 * subject here is not what a verdict means but who owns the wait.
 *
 * `uvp_verify` reaches the readiness wait through `workspace.run`, the same
 * method the `uvp_run` handler calls, and a signal that survives one path and not
 * the other is a signal that was never really threaded.
 */
describe("a verification pass the caller stopped", () => {
  it(
    "treats an interrupt during the readiness wait as a cancellation, not as a service that never came up",
    async () => {
      // The service listens on one port and the pass is told to probe another, so
      // the readiness wait really does run to its deadline — 20 s of it, which is
      // what makes the abort at 600 ms the thing that ended this call rather than
      // a deadline that happened to arrive.
      const listening = await freePort();
      const probed = await freePort();
      const svc = await writeFakeService(harness.workspace, "svc", listening);

      const failure = await callAbortingAfter(600, "uvp_verify", {
        path: harness.workspace,
        run: { args: svc.args, port: probed, ready_path: "/healthz", timeout_ms: 20_000 },
        // The contract requires one, and it is never reached: the pass throws on
        // the readiness wait before any request is issued.
        requests: [{ name: "never", path: "/hello" }],
      }).then(
        () => undefined,
        (cause: unknown) => toUvpError(cause),
      );

      expect(failure, "uvp_verify answered after its call had been cancelled").toBeDefined();
      expect(failure?.code).toBe("cancelled");
      expect(failure?.message).not.toMatch(/did not answer within/u);
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
      const svc = await writeFakeService(harness.workspace, "svc", port);

      // The three kinds outside the eight `uvp_verify` used to declare. They are
      // the ones the CLI's short forms lower onto — `body_bytes<1024`,
      // `header:<name>`, `json:<path>` — so before this contract was widened
      // they parsed and then failed validation, and the caller saw a zod enum
      // instead of the check they asked for.
      const output = await call("uvp_verify", {
        path: harness.workspace,
        run: { args: svc.args, port, ready_path: "/healthz", timeout_ms: 15_000 },
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

/**
 * Where a build happens, asked at the boundary that decides it.
 *
 * `src/application/toolchainSelection.test.ts` covers the rule itself. This
 * block covers the wiring: that the handler reads the manifest, asks the service
 * graph for the provider the rule named, reports *that* provider's identity, and
 * carries the limitations that come with it. A rule that is correct while
 * nothing calls it is the shape of bug this lane exists to catch — the selection
 * would be right and the build would still run on this host.
 *
 * The container provider here is a scripted fixture, not a container. It
 * establishes the boundary — which image was asked for, and whether one was
 * asked for at all — and nothing about what a real image's compilers do.
 * `ContainerToolchainProvider.test.ts` and the `toolchain` lane cover the real
 * one.
 */

/** A provider that answers as a container image would, without starting one. */
const containerFixture = (
  image: string,
  options: FakeToolchainOptions = {},
): ToolchainProvider => ({
  ...createFakeToolchain({ ...options, id: "container", version: image }),
  identity: () => ({ id: "container", platform: "container", version: image }),
});

/**
 * An image this host cannot examine at all: there is no runtime to start it.
 *
 * The refusal is the provider's own, as the real one's is, because the caller
 * that has to handle it is the one that must not paraphrase it.
 */
const unexaminableImage = (image: string): ToolchainProvider =>
  containerFixture(image, {
    available: false,
    missing: [{ id: "container_runtime", requiredFor: "running a build inside a container" }],
    libuvcppUnavailable:
      `The libuvcpp install inside ${image} could not be examined: the image is not present, ` +
      "or no container runtime is available.",
  });

/**
 * Call a tool against a graph whose container toolchain is a fixture.
 *
 * `images` is the point of returning it: the wiring question is not only "which
 * provider answered" but "was a container started at all". A selection that
 * quietly fell back to this host would still answer with a build result, and the
 * result alone would not say which of the two happened.
 */
const callWithContainers = async (
  name: string,
  input: unknown,
  images: string[],
  fixture: (image: string) => ToolchainProvider = containerFixture,
): Promise<Record<string, unknown>> => {
  const services = createUvpServices({
    providers: [createFakeToolchain()],
    now: FROZEN_CLOCK,
    containerToolchain: (image) => {
      images.push(image);
      return fixture(image);
    },
  });
  return await handlerFor(createToolHandlers(services), name)(input, { signal: harness.signal });
};

/** The refusal a call projects to at the adapter boundary. */
const refusalOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (cause) {
    return toUvpError(cause).code;
  }
  throw new Error("the call was expected to refuse and it answered");
};

/**
 * A workspace created by the tool, then given a `toolchain` field.
 *
 * Written over the manifest the generator produced rather than assembled from
 * nothing, so the build below reads a file uvp itself wrote plus the one field
 * under test.
 */
const declaringWorkspace = async (toolchain: unknown): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "uvp-toolchain-"));
  temporaryRoots.push(root);
  const path = join(root, "svc");
  expectConforms(
    "uvp_workspace_create",
    await call("uvp_workspace_create", {
      path,
      name: "svc",
      template: "hello-http",
      features: [],
      port: 8080,
    }),
  );
  const manifest = JSON.parse(await readFile(join(path, "uvp.json"), "utf8")) as Record<
    string,
    unknown
  >;
  await writeFile(join(path, "uvp.json"), JSON.stringify({ ...manifest, toolchain }));
  return path;
};

describe("where a build happens", () => {
  it(
    "builds inside the image the workspace declared, and reports that provider",
    async () => {
      const images: string[] = [];
      const path = await declaringWorkspace({
        kind: "container",
        image: "localhost/uvp-base:12",
      });

      const output = await callWithContainers("uvp_build", { path }, images);
      expectConforms("uvp_build", output);

      expect(images).toEqual(["localhost/uvp-base:12"]);
      // The envelope's `provider` is the selected one. Reporting this host's
      // compiler on a result the image produced would attribute the build to a
      // toolchain that did not run it, which is the one thing that field exists
      // to prevent.
      expect(output["provider"]).toMatchObject({
        id: "container",
        version: "localhost/uvp-base:12",
      });

      const limitations = output["limitations"] as string[];
      expect(limitations.some((line) => line.includes("localhost/uvp-base:12"))).toBe(true);
      // The limitation a caller acts on: the artifacts are real and are linked
      // against a library path that exists only inside the image.
      expect(limitations.some((line) => line.includes("fail to start on this host"))).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "builds on this host when the call refuses the image its workspace asked for",
    async () => {
      const images: string[] = [];
      const path = await declaringWorkspace({
        kind: "container",
        image: "localhost/uvp-base:12",
      });

      const output = await callWithContainers("uvp_build", { path, toolchain: "local" }, images);
      expectConforms("uvp_build", output);

      expect(images).toEqual([]);
      expect(output["provider"]).toMatchObject({ id: "fake" });
      const limitations = output["limitations"] as string[];
      expect(limitations.some((line) => line.includes("uvp-base:12"))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "refuses a call that demands a container no workspace named an image for",
    async () => {
      // A flag cannot designate an image: if it could, the image a build ran in
      // would be chosen by the caller of the moment rather than by the file the
      // workspace ships.
      const images: string[] = [];
      expect(
        await refusalOf(() =>
          callWithContainers(
            "uvp_build",
            { path: harness.workspace, toolchain: "container" },
            images,
          ),
        ),
      ).toBe("missing_requirement");
      expect(images).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "refuses a declaration it could not read rather than building on this host",
    async () => {
      // The three-way distinction this repository keeps: the file asked for
      // something and the something is unreadable, so the answer is a refusal
      // rather than the default. Building here would be the opposite of what the
      // workspace asked for, presented as a successful build.
      const images: string[] = [];
      const path = await declaringWorkspace({ kind: "container" });
      expect(await refusalOf(() => callWithContainers("uvp_build", { path }, images))).toBe(
        "invalid_request",
      );
      expect(images).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "refuses to verify a workspace it would build inside a container",
    async () => {
      // A pass builds and then runs what it built, and the second half cannot be
      // honoured from here. Refused before the build, because "the service never
      // came up" would be a verdict about a service and this is not one.
      const path = await declaringWorkspace({
        kind: "container",
        image: "localhost/uvp-base:12",
      });
      const images: string[] = [];
      const port = await freePort();
      try {
        await callWithContainers(
          "uvp_verify",
          {
            path,
            run: { port, timeout_ms: 15_000 },
            requests: [{ name: "hello", method: "GET", path: "/hello", assertions: [] }],
            goal: "the declared service answers",
          },
          images,
        );
        expect.unreachable("uvp_verify answered for a workspace it would build in a container");
      } catch (cause) {
        const failure = toUvpError(cause);
        expect(failure.code).toBe("unsupported_toolchain");
        // The escape has to be in the remedy, because a refusal whose way out is
        // not stated is a refusal a caller works around by guessing.
        expect(failure.remediation.action).toContain("local");
      }
      expect(images).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "verifies on this host when the call takes the escape it was offered",
    async () => {
      const path = await declaringWorkspace({
        kind: "container",
        image: "localhost/uvp-base:12",
      });
      const port = await freePort();
      const svc = await writeFakeService(path, "svc", port);

      const images: string[] = [];
      const output = await callWithContainers(
        "uvp_verify",
        {
          path,
          toolchain: "local",
          run: { args: svc.args, port, ready_path: "/healthz", timeout_ms: 15_000 },
          requests: [
            {
              name: "hello",
              method: "GET",
              path: "/hello",
              assertions: [{ kind: "status_equals", expected: 200 }],
            },
          ],
        },
        images,
      );
      expectConforms("uvp_verify", output);
      expect(images).toEqual([]);
      // The pass says which toolchain it used, so nothing about it claims to be
      // what the manifest asked for.
      expect(output["provider"]).toMatchObject({ id: "fake" });
    },
    TIMEOUT,
  );
});

/**
 * The doctor, on a workspace whose manifest names a toolchain.
 *
 * `uvp_doctor` is the command a caller runs *before* building, so a workspace
 * that names a container has to be answerable here — otherwise the first thing
 * that mentions the missing runtime is a build that was never going to start.
 *
 * The container provider is again a scripted fixture: it establishes which
 * image was asked for and what the doctor did with an answer it did not get,
 * and nothing about podman.
 */
describe("what the doctor says about a workspace that names a toolchain", () => {
  it(
    "reports the container it could not examine, in the provider's own words",
    async () => {
      const images: string[] = [];
      const path = await declaringWorkspace({ kind: "container", image: "localhost/uvp-base:12" });

      const output = await callWithContainers(
        "uvp_doctor",
        { workspace: path, features: ["tls", "db"] },
        images,
        unexaminableImage,
      );
      expectConforms("uvp_doctor", output);
      expect(images).toEqual(["localhost/uvp-base:12"]);

      // A host with no runtime says so in a report, which is the whole point of
      // asking the doctor rather than starting a build.
      const toolchains = output["toolchains"] as {
        id: string;
        available: boolean;
        missing: { id: string; required_for: string }[];
      }[];
      const container = toolchains.find((entry) => entry.id === "container");
      expect(container?.available).toBe(false);
      expect(container?.missing.map((missing) => missing.id)).toEqual(["container_runtime"]);
      // Reported beside it, not instead of it: "can I build here at all" needs
      // both halves.
      expect(toolchains.some((entry) => entry.id === "fake")).toBe(true);

      // Nothing about the build was established, so nothing is claimed about it
      // — including that the image lacks these features.
      const features = output["features"] as { status: string; note?: string }[];
      expect(features).toHaveLength(2);
      for (const entry of features) {
        expect(entry.status).toBe("undetermined");
        expect(entry.note).toContain("localhost/uvp-base:12");
      }

      // `libuvcpp` has no way to say "not looked": `found` is a boolean every
      // reader takes as a claim about the toolchain. So this host's install is
      // what is reported, and the report says in as many words that it is not
      // the one this workspace builds against.
      expect((output["libuvcpp"] as Record<string, unknown>)["found"]).toBe(true);
      expect(
        (output["limitations"] as string[]).some((line) =>
          line.includes("Nothing here describes localhost/uvp-base:12"),
        ),
      ).toBe(true);

      // The envelope is stamped with the toolchain the workspace named, so a
      // report about an image is not labelled as a result from this host.
      expect(output["provider"]).toMatchObject({
        id: "container",
        version: "localhost/uvp-base:12",
      });
    },
    TIMEOUT,
  );

  it(
    "asks the image, not this host, for the libuvcpp a container workspace builds against",
    async () => {
      const images: string[] = [];
      const path = await declaringWorkspace({ kind: "container", image: "localhost/uvp-base:12" });

      const output = await callWithContainers(
        "uvp_doctor",
        { workspace: path, features: ["db"] },
        images,
        (image) =>
          containerFixture(image, {
            libuvcpp: {
              found: true,
              version: "1.6.0",
              versionSource: "version_file",
              installPrefix: "/opt/libuvcpp",
              modules: [],
              note: `Read from the image ${image}: paths are in-container.`,
            },
          }),
      );
      expectConforms("uvp_doctor", output);
      expect(images).toEqual(["localhost/uvp-base:12"]);

      const libuvcpp = output["libuvcpp"] as Record<string, unknown>;
      expect(libuvcpp).toMatchObject({
        found: true,
        version: "1.6.0",
        install_prefix: "/opt/libuvcpp",
      });

      // The host fixture this lane hands the graph reports every module, so a
      // feature decided from the image's empty module list is the difference
      // between asking the image and asking the host.
      const features = output["features"] as { status: string; note?: string }[];
      expect(features[0]?.status).toBe("unmet");
      expect(features[0]?.note).toContain("UVCPP_ENABLE_DB");
    },
    TIMEOUT,
  );

  it(
    "does not root a header probe at a path that exists only inside the image",
    async () => {
      const path = await declaringWorkspace({ kind: "container", image: "localhost/uvp-base:12" });
      // A host directory that a probe would accept as proof of grpc: the
      // install root's `include/<header>` is the second layout `headerProbeAt`
      // tries, so rooting one at `path` would answer `satisfied`.
      await mkdir(join(path, "include", "grpc"), { recursive: true });

      const images: string[] = [];
      const output = await callWithContainers(
        "uvp_doctor",
        { workspace: path, features: ["grpc"] },
        images,
        (image) =>
          containerFixture(image, {
            libuvcpp: { found: true, version: "1.7.0", installPrefix: path, modules: [] },
          }),
      );
      expectConforms("uvp_doctor", output);

      // libuvcpp has no configuration switch for grpc, so only the headers
      // decide it — and the install root is inside the image. Probing this host
      // instead would find the directory above and report a capability nothing
      // checked.
      const features = output["features"] as { feature: string; status: string }[];
      expect(features[0]).toMatchObject({ feature: "grpc", status: "undetermined" });
    },
    TIMEOUT,
  );

  it(
    "refuses a declaration it could not read, even when the call passed its own features",
    async () => {
      const images: string[] = [];
      const path = await declaringWorkspace({ kind: "container" });
      // `--features` overrides which features are assessed, and it does not
      // override the file: a workspace that asks to be built somewhere uvp
      // cannot identify is not a workspace to answer questions about.
      expect(
        await refusalOf(() =>
          callWithContainers("uvp_doctor", { workspace: path, features: ["tls"] }, images),
        ),
      ).toBe("invalid_request");
      expect(images).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "discloses that a report restricted to this host is not the one the workspace builds with",
    async () => {
      const images: string[] = [];
      const path = await declaringWorkspace({ kind: "container", image: "localhost/uvp-base:12" });

      const output = await callWithContainers(
        "uvp_doctor",
        { workspace: path, providers: ["fake"] },
        images,
        (image) =>
          containerFixture(image, {
            libuvcpp: {
              found: true,
              version: "1.6.0",
              installPrefix: "/opt/libuvcpp",
              modules: [],
            },
          }),
      );
      expectConforms("uvp_doctor", output);

      // The restriction is honoured as a restriction on what is listed...
      expect((output["toolchains"] as { id: string }[]).map((entry) => entry.id)).toEqual(["fake"]);
      // ...and it does not move the subject of the rest of the report: the
      // libuvcpp is still the image's, and the limitation says the container is
      // missing from the list rather than letting one row speak for both.
      expect((output["libuvcpp"] as Record<string, unknown>)["install_prefix"]).toBe(
        "/opt/libuvcpp",
      );
      expect(
        (output["limitations"] as string[]).some(
          (line) => line.includes("restricted to fake") && line.includes("container"),
        ),
      ).toBe(true);
    },
    TIMEOUT,
  );
});
