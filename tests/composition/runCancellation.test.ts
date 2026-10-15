import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createToolHandlers, handlerFor } from "../../src/composition/toolHandlers.js";
import { createUvpServices } from "../../src/composition/uvpServices.js";
import { runContract } from "../../src/contracts/projectToolContracts.js";
import { toUvpError, type UvpError } from "../../src/domain/errors.js";

/**
 * What an interrupted `uvp_run` is allowed to say.
 *
 * Observed before this was fixed, on a real workspace with a real service: a
 * SIGINT 1.2 s into a readiness wait on a port nothing listened on did nothing at
 * all — the call ran the full 8000 ms, reported `ready: no` with the unknown
 * "the probe did not answer within 8000 ms", exited 1, and left the service it
 * had started listening with its supervision released. Two things were wrong at
 * once. The interrupt was dropped (`uvp_run`'s handler never passed the signal
 * on, so the CLI aborted a controller nothing below read, and because a SIGINT
 * listener was installed the process did not die either), and what finally came
 * back described a machine's deadline as though the caller had waited for it.
 *
 * The service here is a shell script rather than a built C++ one, and that is the
 * point: what is under test is who owns the process this call started and what is
 * said when the caller withdraws, neither of which needs libuvcpp. The script
 * writes a file when it starts and one when it is asked to stop, so "nothing was
 * started" and "it was stopped" are read from the filesystem rather than inferred
 * from a pid that may already be reused.
 */

const services = createUvpServices();
const handlers = createToolHandlers(services);
/** The handler, looked up by the contract's own name rather than by a string. */
const run = handlerFor(handlers, runContract.name);

let workspace = "";
let pidFile = "";
let stopFile = "";

beforeAll(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), "uvp-run-cancel-")));
  pidFile = join(workspace, "started.pid");
  stopFile = join(workspace, "stopped.marker");
  await mkdir(join(workspace, "build"), { recursive: true });
  await writeFile(join(workspace, "uvp.json"), JSON.stringify({ name: "fake-svc" }));
  const binary = join(workspace, "build", "fake-svc");
  await writeFile(
    binary,
    [
      "#!/bin/sh",
      // The pid is written by the script, so it is the process uvp spawned and not
      // the shell that launched it.
      `echo "$$" > "${pidFile}"`,
      `trap 'echo stopped > "${stopFile}"; exit 0' TERM`,
      "while true; do sleep 0.2; done",
      "",
    ].join("\n"),
  );
  await chmod(binary, 0o755);
});

afterAll(async () => {
  // Whatever the tests left: a run that was cancelled mid-wait is stopped by the
  // call itself, and this is the belt for the one that got as far as a result.
  await services.workspace.stop({ all: true, graceMs: 3_000, force: true });
  await rm(workspace, { recursive: true, force: true });
});

/** The failure a call reported, or `undefined` if it answered instead. */
const failureOf = async (call: Promise<unknown>): Promise<UvpError | undefined> =>
  await call.then(
    () => undefined,
    (cause: unknown) => toUvpError(cause),
  );

/**
 * A port nothing is listening on.
 *
 * Chosen from the process's own pid so two lanes running at once do not collide,
 * and checked by the tests below rather than assumed: if something did answer
 * here, the call would come back ready and the assertions would say so.
 */
const silentPort = 30_000 + (process.pid % 2_000);

const abortAfter = (ms: number): { signal: AbortSignal; clear: () => void } => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, ms);
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
    },
  };
};

describe("a run whose caller withdrew", () => {
  it("starts nothing at all when the signal was already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const failure = await failureOf(
      run({ path: workspace, args: [], env: {}, detach: true }, { signal: controller.signal }),
    );

    expect(failure?.code).toBe("cancelled");
    expect(failure?.category).toBe("cancelled");
    // The claim the code makes: nothing was launched. A startup marker here would
    // mean this call spawned a service on behalf of a caller who had already
    // decided not to wait for one.
    expect(existsSync(pidFile)).toBe(false);
  });

  it("stops the service it started, and reports the withdrawal rather than the deadline", async () => {
    // Both files are this test's own evidence, so neither a leftover from the test
    // above nor a run of this test on its own can be mistaken for it.
    await rm(pidFile, { force: true });
    await rm(stopFile, { force: true });

    const { signal, clear } = abortAfter(400);
    let failure: UvpError | undefined;
    try {
      failure = await failureOf(
        run(
          {
            path: workspace,
            args: [],
            env: {},
            ready: { port: silentPort, path: "/", timeout_ms: 10_000 },
            detach: true,
          },
          { signal },
        ),
      );
    } finally {
      clear();
    }

    // The failure's own words travel with the code, because of a CI run that has
    // never been explained: `expected 'execution_failure' to be 'cancelled'` in run
    // 38805381480, 21.5 ms into the request — far too early to be the cancellation
    // grace. The two mechanisms that could produce that code differ in exactly this
    // text (a real failure from a second copy of the errors module keeps its
    // message; an unrecognised error carries its own), so a repetition should print
    // the one fact that tells them apart rather than send the next reader through
    // the same search. See docs/roadmap.md#the-cancellation-flake.
    expect(
      failure?.code,
      `${String(failure?.message)} | details: ${JSON.stringify(failure?.details)}`,
    ).toBe("cancelled");
    // The old wording was "the probe did not answer within 10000 ms", filed as an
    // unknown about the service with the bound as its reason. That the caller
    // stopped waiting is not a fact about the service.
    expect(failure?.message).not.toMatch(/did not answer within/u);
    expect(failure?.message).toMatch(/cancelled/u);
    // The script really did run — otherwise "it was stopped" would be a claim
    // about nothing — and the stop is the script's own account of it, not uvp's
    // inference from a process's absence.
    expect(existsSync(pidFile)).toBe(true);
    expect(existsSync(stopFile), "the started service was left running").toBe(true);
  });

  it("reports a readiness timeout as itself when the caller is still waiting", async () => {
    // The control for the test above: the same request without a withdrawal. If
    // the cancellation check were simply "the wait ended without an answer", this
    // is the case that would notice, because a deadline is not a decision.
    const result = (await run(
      {
        path: workspace,
        args: [],
        env: {},
        ready: { port: silentPort, path: "/", timeout_ms: 700 },
        detach: true,
      },
      { signal: new AbortController().signal },
    )) as { ready: boolean; unknowns: readonly { reason: string }[] };

    expect(result.ready).toBe(false);
    expect(result.unknowns.map((unknown) => unknown.reason)).toContain("resource_limit");
    await services.workspace.stop({ all: true, graceMs: 3_000, force: true });
  });
});
