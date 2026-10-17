import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createToolHandlers, handlerFor } from "../../src/composition/toolHandlers.js";
import { createUvpServices } from "../../src/composition/uvpServices.js";
import { runContract } from "../../src/contracts/projectToolContracts.js";
import { toUvpError, type UvpError } from "../../src/domain/errors.js";
import { isWindows } from "../../src/toolchains/host.js";
import { installFakeExecutable } from "../support/fakeExecutable.js";
import { removeTree } from "../support/temporaryTree.js";

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
 * The service here is a program this file installs rather than a built C++ one,
 * and that is the point: what is under test is who owns the process this call
 * started and what is said when the caller withdraws, neither of which needs
 * libuvcpp. It writes a file when it starts and one when it is asked to stop, so
 * "nothing was started" and "it was stopped" are read from the filesystem rather
 * than inferred from a pid that may already be reused.
 *
 * The second of those two files is the one thing here that is not portable, and
 * the test that reads it says so in its own name: a stop on Windows is
 * `TerminateProcess`, so a service that was stopped there writes nothing.
 */

/**
 * A service that announces its pid and, when stopped, says so.
 *
 * Installed rather than written here because what the *host* will start is a
 * question with one owner, `tests/support/fakeExecutable.ts`, and the answer
 * differs by host: a shell script that `exec`s this Node on Unix, a copy of Node
 * itself on Windows. Both receive the two paths below as the program's first
 * arguments.
 */
const STOPS_WHEN_ASKED = fileURLToPath(
  new URL("../support/fixtures/stopsWhenAsked.mjs", import.meta.url),
);

/**
 * `title`, on the host that cannot check it.
 *
 * `child.kill("SIGTERM")` in `processRunner.ts` is libuv's `uv_process_kill`,
 * which on Windows is `TerminateProcess` whichever signal is named. A terminated
 * process runs no handler, so the service's own account of the stop cannot exist
 * there — and uvp's account of it is exactly what the test below declines to
 * substitute for it.
 */
const named = (title: string): string =>
  isWindows
    ? `${title} — skipped: a stop on Windows is TerminateProcess, and a terminated process writes nothing`
    : title;

const services = createUvpServices();
const handlers = createToolHandlers(services);
/** The handler, looked up by the contract's own name rather than by a string. */
const run = handlerFor(handlers, runContract.name);

let workspace = "";
let pidFile = "";
let stopFile = "";
/** What the launcher has to pass for the installed service to run at all. */
let serviceArgs: readonly string[] = [];

beforeAll(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), "uvp-run-cancel-")));
  pidFile = join(workspace, "started.pid");
  stopFile = join(workspace, "stopped.marker");
  await writeFile(join(workspace, "uvp.json"), JSON.stringify({ name: "fake-svc" }));
  const service = await installFakeExecutable(join(workspace, "build"), "fake-svc", {
    module: STOPS_WHEN_ASKED,
    args: [pidFile, stopFile],
  });
  serviceArgs = service.args;
});

afterAll(async () => {
  // Whatever the tests left: a run that was cancelled mid-wait is stopped by the
  // call itself, and this is the belt for the one that got as far as a result.
  await services.workspace.stop({ all: true, graceMs: 3_000, force: true });
  await removeTree(workspace);
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

/**
 * How long the installed service is given to write its pid file before the caller
 * withdraws.
 *
 * This was 400 ms until one Windows run failed on `existsSync(pidFile)` — the
 * withdrawal answered `cancelled` correctly, but the fake service there is a copy
 * of Node rather than a two-line shell script, and under the runner's load it had
 * not started inside that window. The readiness wait is ten seconds against a port
 * nothing listens on, so waiting up to this bound still withdraws inside the wait;
 * what changes is that the test establishes the service started instead of racing
 * it. See docs/roadmap.md#the-cancellation-flake.
 */
const START_BOUND_MS = 5_000;

/** Polls for a file, answering whether it appeared inside the bound. */
const waitForFile = async (path: string, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  return true;
};

describe("a run whose caller withdrew", () => {
  it("starts nothing at all when the signal was already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const failure = await failureOf(
      run(
        { path: workspace, args: serviceArgs, env: {}, detach: true },
        { signal: controller.signal },
      ),
    );

    expect(failure?.code).toBe("cancelled");
    expect(failure?.category).toBe("cancelled");
    // The claim the code makes: nothing was launched. A startup marker here would
    // mean this call spawned a service on behalf of a caller who had already
    // decided not to wait for one.
    expect(existsSync(pidFile)).toBe(false);
  });

  /**
   * A run of the installed service, withdrawn while it waits for readiness.
   *
   * Both files are this test's own evidence, so both are cleared first: neither a
   * leftover from another test nor a run of this test on its own can be mistaken
   * for what this one observed. The two tests below share it because each reads a
   * different one of the two — that the service started, and how it left.
   *
   * The withdrawal is a decision made after the service's own pid file says it
   * started, not a fixed delay, so the claim in both titles — "over the service it
   * started" — is a premise the test establishes rather than a race it reads after
   * the fact. If the file never appears the caller still withdraws, so the failure
   * is the named one below rather than a hang.
   */
  const withdrawnRun = async (): Promise<UvpError | undefined> => {
    await rm(pidFile, { force: true });
    await rm(stopFile, { force: true });

    const controller = new AbortController();
    const answer = failureOf(
      run(
        {
          path: workspace,
          args: serviceArgs,
          env: {},
          ready: { port: silentPort, path: "/", timeout_ms: 10_000 },
          detach: true,
        },
        { signal: controller.signal },
      ),
    );
    const started = await waitForFile(pidFile, START_BOUND_MS);
    controller.abort();
    const failure = await answer;

    expect(
      started,
      `the installed service wrote no pid file within ${String(START_BOUND_MS)} ms`,
    ).toBe(true);
    return failure;
  };

  it("reports the withdrawal rather than the deadline, over the service it started", async () => {
    const failure = await withdrawnRun();

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
    // The service really did run, so the call had something to be responsible for
    // when it answered. What became of it is the next test's subject.
    expect(existsSync(pidFile)).toBe(true);
  });

  it.skipIf(isWindows)(
    named("stops it, and the service's own account of the stop is on disk"),
    async () => {
      await withdrawnRun();
      // The service's account, not uvp's inference from a process's absence: the
      // trap ran, which is the only thing that could have written this.
      expect(existsSync(stopFile), "the started service was left running").toBe(true);
    },
  );

  it("reports a readiness timeout as itself when the caller is still waiting", async () => {
    // The control for the tests above: the same request without a withdrawal. If
    // the cancellation check were simply "the wait ended without an answer", this
    // is the case that would notice, because a deadline is not a decision.
    const result = (await run(
      {
        path: workspace,
        args: serviceArgs,
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
