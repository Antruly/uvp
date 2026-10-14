import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import { afterAll, describe, expect, it } from "vitest";

import { EXIT_OK } from "../../src/cli/exitCodes.js";
import {
  buildWorkspace,
  cleanup,
  createWorkspace,
  isAlive,
  portIsFree,
  realLibuvcpp,
  resultOf,
  resultOrThrow,
  runCli,
  skipReason,
  uvpEntryPoint,
} from "../support/realLibuvcpp.js";
import type { CliOutcome, Workspace } from "../support/realLibuvcpp.js";

/**
 * The manual path: start a service, drive it, and end it by hand.
 *
 * `verifyClosure` and `assertionVocabulary` are one call each — uvp launches the
 * service, drives it, asserts, and stops it, and the caller reads a bundle. This
 * file is the other way uvp is used, and the way it is used *first*: a person (or
 * an agent) starts a service in the foreground, pokes at it with `uvp http`
 * between other work, and ends it with Ctrl-C.
 *
 * The subject here is not "the service answers" — the other two files establish
 * that. It is **who owns the process**. `uvp run --no-detach` holds its service
 * in the foreground, and the reason the CLI is still alive after printing its
 * result is that the service's pipes are open handles. An interrupt then has to
 * end the service, and the two facts below are the ones a caller is relying on
 * when they press Ctrl-C:
 *
 * - the service is stopped, so the port is free when the call returns;
 * - the cleanup is *reported*, with the run id, rather than inferred from this
 *   process ending.
 *
 * Both are worth this file because the failure they guard against is invisible:
 * the service is in its own process group, so a terminal's Ctrl-C reaches the CLI
 * and never the service, and the registry `uvp stop` reads dies with the CLI. A
 * CLI that simply exited would leave a listener on the port that nothing could
 * reach — while the result it printed said to stop the run with `uvp_run_stop`.
 *
 * The registry's session scope is pinned here too, in the same test: a *later*
 * invocation cannot reach this run, which is exactly why the CLI has to do the
 * stopping on its way out rather than deferring it to the next command.
 */

/** This file's port. Disjoint from `verifyClosure`'s 8301 and `assertionVocabulary`'s 8311. */
const PORT = 8321;

/** The path readiness is asked about, so "ready" means the handler answered. */
const READY_PATH = "/healthz";

/**
 * How long the CLI is given to print its handle.
 *
 * Its own readiness timeout is the real bound (20 s, below); this is the budget
 * for the whole spawn, and it has to outlast that plus the launch.
 */
const HANDLE_BUDGET_MS = 30_000;

/**
 * The workspace the test below runs against, generated once.
 *
 * Memoised as a promise rather than a value so a second test asking for it cannot
 * start a second `uvp init` — the first would still be running, and the two would
 * race for the same directory.
 *
 * The port is the template's: `uvp init` bakes it into the generated `main.cpp`,
 * so a service started with a different `--port` binds the port it was built for
 * while the readiness probe asks about another one, and the run reports
 * `ready: false` after waiting out the whole timeout.
 */
let made: Promise<Workspace> | undefined;
const workspace = (): Promise<Workspace> => (made ??= createWorkspace("rest-api", PORT));

const sleep = async (ms: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, ms));

/** End a foreground run and anything it started, without waiting for it to be polite. */
const killGroup = (child: ChildProcess): void => {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // Already gone. That is the outcome this file is usually asserting.
  }
};

interface Foreground {
  readonly child: ChildProcess;
  /** The handle the CLI printed, read while the CLI is still holding the service. */
  readonly result: Record<string, unknown>;
  /** Everything the CLI has written to stderr so far. */
  readonly stderr: () => string;
  /** How the CLI ended, whichever way it ended. */
  readonly exited: Promise<{ readonly code: number | null; readonly signal: string | null }>;
}

/**
 * Start `uvp run --no-detach` and return once it has printed its handle.
 *
 * Spawned **detached**, so the CLI becomes the leader of a new process group. A
 * signal sent to that group is then precisely what a terminal sends to a
 * foreground job: it reaches the CLI and nothing else. The service is unaffected
 * for the same reason in reverse — uvp starts it detached too, so it is in a
 * group of its own and never sees the interrupt. That asymmetry is the fact the
 * file exists to pin.
 */
const startForegroundRun = async (target: Workspace): Promise<Foreground> => {
  const child = spawn(
    process.execPath,
    [
      uvpEntryPoint,
      "run",
      target.root,
      "--port",
      String(PORT),
      "--ready-path",
      READY_PATH,
      "--timeout",
      "20000",
      "--json",
      "--no-detach",
    ],
    { cwd: target.root, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const exited = new Promise<{ readonly code: number | null; readonly signal: string | null }>(
    (resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );

  const deadline = Date.now() + HANDLE_BUDGET_MS;
  for (;;) {
    const handle = resultOf(stdout);
    if (handle !== undefined) {
      return { child, result: handle, stderr: () => stderr, exited };
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `uvp run --no-detach exited (${String(child.exitCode ?? child.signalCode)}) without printing a handle:\n${stderr.slice(-2_000)}`,
      );
    }
    if (Date.now() >= deadline) {
      killGroup(child);
      throw new Error(
        `uvp run --no-detach printed no handle within ${String(HANDLE_BUDGET_MS)} ms:\n${stderr.slice(-2_000)}`,
      );
    }
    await sleep(50);
  }
};

/** Ctrl-C, as a terminal delivers it: to the foreground process group. */
const interrupt = (child: ChildProcess): void => {
  if (child.pid === undefined) throw new Error("the foreground run has no pid to signal");
  process.kill(-child.pid, "SIGINT");
};

afterAll(() => {
  cleanup();
});

describe.skipIf(realLibuvcpp === undefined)(
  realLibuvcpp === undefined
    ? `the manual path — skipped: ${skipReason}`
    : `the manual path, on real CMake and libuvcpp ${realLibuvcpp.version}`,
  () => {
    it(
      "stops the service it is holding when the foreground run is interrupted",
      async () => {
        const target = await workspace();

        // Built first, because `uvp run` launches and does not compile: a run
        // that fails here would report a launch failure, and a launch failure is
        // a different fact from a workspace that does not compile.
        const build: CliOutcome = await buildWorkspace(target);
        expect(build.exit, build.stderr.slice(-2_000) || build.stdout.slice(0, 2_000)).toBe(
          EXIT_OK,
        );

        const run = await startForegroundRun(target);
        try {
          // The handle, printed before the wait begins. `detached: false` and
          // `still_running: true` together are what say this CLI is holding the
          // service rather than having let go of it.
          expect(run.result["ready"], run.stderr().slice(-2_000)).toBe(true);
          expect(run.result["detached"]).toBe(false);
          expect(run.result["still_running"]).toBe(true);
          expect(run.result["endpoint"]).toBe(`http://127.0.0.1:${String(PORT)}${READY_PATH}`);

          const pid = Number(run.result["pid"]);
          const runId = String(run.result["run_id"]);
          expect(pid).toBeGreaterThan(0);

          // The manual loop, and the reason the flag exists: while the CLI waits,
          // the service is up and another uvp process can drive it. A separate
          // process on purpose — this is what an agent with a terminal does, and
          // it also proves the service, not the CLI, is answering.
          const poke = resultOrThrow(
            await runCli(["http", `http://127.0.0.1:${String(PORT)}/items/1`, "--json"]),
          );
          expect(poke["status"]).toBe(200);
          expect(isAlive(pid), "the service was not running before the interrupt").toBe(true);
          expect(await portIsFree(PORT), "the port was not held by the service").toBe(false);

          interrupt(run.child);
          const ended = await run.exited;

          // 130 is the conventional code for "died of SIGINT", and it is a code
          // rather than a signal: the CLI handled the interrupt, and a caller
          // reading it learns that the CLI decided how this ended.
          expect(ended.signal).toBeNull();
          expect(ended.code).toBe(130);

          // Reported, not inferred. The line names the run and what became of it,
          // which is the only thing that separates "the stop worked" from "the
          // process went away while nobody was looking".
          expect(run.stderr()).toContain(`interrupted: stopped ${runId}`);

          // And the facts themselves. A note claiming a cleanup is not a cleanup:
          // the pid is gone from the operating system, and the port — the thing a
          // caller actually needs back — accepts connections again.
          expect(isAlive(pid), "the service outlived the run that was holding it").toBe(false);
          expect(await portIsFree(PORT), "the interrupt left the service listening").toBe(true);

          // The other half of ownership, and the reason the CLI cannot leave this
          // to the next command: the registry is per process, so a fresh
          // invocation has never heard of this run. It says so honestly — nothing
          // was stopped — which is the documented limit of `uvp stop` and not a
          // cleanup this file can ask it for.
          const late = resultOrThrow(await runCli(["stop", "--run-id", runId, "--json"]));
          expect(late["stopped"]).toEqual([]);
        } finally {
          killGroup(run.child);
        }
      },
      // The build is inside this test — a cold CMake configure and a compile of
      // the template, which is not what the fixture lanes' default budget is for.
      120_000,
    );
  },
);
