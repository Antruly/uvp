import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { runProcess, startSupervised } from "../../../src/toolchains/local/processRunner.js";
import type { ProcessOutcome } from "../../../src/toolchains/local/processRunner.js";

/**
 * Supervision: start, stop, and the process that outlives the supervisor.
 *
 * `startSupervised` is what `uvp run` uses, and everything it reports is a claim
 * about a process that uvp does not own in the way a function call is owned: it
 * can be slow, it can ignore the polite signal, it can die before anyone looks,
 * and it can outlive the process that started it. Three rules follow from that,
 * and each is checked here against a real process rather than a stub:
 *
 * - **Ownership is not inferred from absence.** A process that was told to stop
 *   and did not is still running, and it is still uvp's to report — so `stop`
 *   answers `unresponsive` and says nothing was killed, rather than reporting a
 *   success nobody observed.
 * - **A process that never started is not running.** This is the regression this
 *   file was written for. `spawn` reports failure asynchronously, so a binary that
 *   is missing produced a handle whose `isRunning()` was true: `uvp run` against a
 *   workspace that had never been built answered `still_running: true`,
 *   `detached: true`, and told the caller to stop it with `uvp_run_stop`. Every
 *   field of that result was a claim about a process that did not exist.
 * - **Detaching is not forgetting.** `release()` exists so that `uvp run` can
 *   print its result and exit while the service keeps serving; the child's pipes
 *   are open handles, and an open handle holds the parent's event loop alive.
 *
 * Where a claim is about the machine — is this pid alive? did it really die? — it
 * is checked with `process.kill(pid, 0)`, which asks the kernel rather than reading
 * back the object that made the claim. A supervisor that agreed with itself would
 * satisfy every assertion that only asked it.
 *
 * One finding from this lane is recorded here rather than fixed, because the fix
 * is a product decision rather than a defect in supervision. See the `EPIPE`
 * comment on the last test.
 */

/** The fixture that starts a service through `dist/` and then lets go of it. */
const DETACH_PARENT = join(import.meta.dirname, "fixtures", "detachParent.mjs");

const SCRATCH = join(realpathSync(tmpdir()), `uvp-process-boundary-${String(process.pid)}`);

mkdirSync(SCRATCH, { recursive: true });

/** Every pid this file started and did not reap, so `afterAll` can end it. */
const started = new Set<number>();

/** A service that never ends on its own. */
const SERVICE = "process.stdout.write('up\\n'); setInterval(() => {}, 1000);";

/** Whether the operating system still knows this pid. No signal is delivered. */
const aliveInTheOs = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** End a process this lane started, when it is still there to end. */
const reap = (pid: number): void => {
  if (aliveInTheOs(pid)) process.kill(pid, "SIGKILL");
};

/** The size of a file the service appends to, or 0 before it exists. */
const sizeOf = (path: string): number => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

const launch = (code: string, options: { readonly maxTailBytes?: number } = {}) => {
  const process_ = startSupervised({
    command: process.execPath,
    args: ["-e", code],
    ...(options.maxTailBytes === undefined ? {} : { maxTailBytes: options.maxTailBytes }),
  });
  if (process_.pid !== undefined) started.add(process_.pid);
  return process_;
};

/** Poll until `ready`, or fail with the deadline the caller asked for. */
const eventually = async (ready: () => boolean, what: string, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${what} did not happen within ${String(timeoutMs)}ms`);
};

afterAll(() => {
  for (const pid of started) reap(pid);
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe("starting a real process", () => {
  it("waits for the kernel to accept it, then reports it running and stops it for real", async () => {
    const service = launch(SERVICE);
    // The positive control for the refusal below: once the spawn has settled, the
    // process is running and the OS agrees it exists.
    await service.whenStarted();
    expect(service.pid).toBeDefined();
    expect(service.isRunning()).toBe(true);
    expect(aliveInTheOs(service.pid ?? 0)).toBe(true);

    await eventually(() => service.stdoutTail().includes("up"), "the service's first line");

    const outcome = await service.stop(3_000, false);
    expect(outcome.outcome).toBe("exited");
    expect(outcome.signal).toBe("SIGTERM");
    // Proof of ownership is separate from validity: the process is gone because the
    // kernel says so, not because the supervisor's own state field says so.
    expect(aliveInTheOs(service.pid ?? 0)).toBe(false);
    expect(service.isRunning()).toBe(false);
  });

  it("refuses to report a process it never started as running", async () => {
    // The regression. A missing binary is reported by the kernel on a later turn
    // of the loop, and the window before it arrives is exactly the window in which
    // the old code answered `running: true` — with no pid, no evidence, and a
    // limitation telling the caller to stop it.
    const missing = startSupervised({ command: join(SCRATCH, "no-such-binary"), args: [] });
    await expect(missing.whenStarted()).rejects.toThrow(/ENOENT/u);
    expect(missing.pid).toBeUndefined();
    expect(missing.isRunning()).toBe(false);
    expect(missing.exitInfo()).toBeUndefined();
    // And nothing is claimed to have been killed: there was nothing to kill.
    await expect(missing.stop(500, true)).resolves.toEqual({
      outcome: "already_gone",
      killed: false,
    });
  });

  it("reports a process that exited on its own as gone, not as stopped", async () => {
    const service = launch("process.exit(7)");
    await service.whenStarted();
    await eventually(() => service.exitInfo() !== undefined, "the service to exit");
    expect(service.exitInfo()?.code).toBe(7);
    expect(service.isRunning()).toBe(false);
    const outcome = await service.stop(500, false);
    expect(outcome.outcome).toBe("already_gone");
    expect(outcome.killed).toBe(false);
    expect(outcome.code).toBe(7);
  });

  it("keeps ownership of a process that ignored the signal, and only ends it when forced", async () => {
    // The rule from the repository's own guidance: a resource whose cleanup failed
    // stays owned, and the failure is reported rather than inferred away. A service
    // that swallows SIGTERM must not be reported as stopped — the registry would
    // forget it and the process would still hold its port.
    //
    // The service announces that its handler is installed, and the signal is sent
    // only afterwards. `whenStarted()` is the kernel accepting the fork, which
    // happens before the program has run a line of its own: signalling then would
    // test the default disposition, not the handler.
    const service = launch(
      `process.on("SIGTERM", () => {}); process.stdout.write("armed\\n"); setInterval(() => {}, 1000);`,
    );
    await service.whenStarted();
    await eventually(
      () => service.stdoutTail().includes("armed"),
      "the service to install its handler",
    );

    const patient = await service.stop(300, false);
    expect(patient.outcome).toBe("unresponsive");
    expect(patient.killed).toBe(false);
    expect(aliveInTheOs(service.pid ?? 0)).toBe(true);
    expect(service.isRunning()).toBe(true);

    const forced = await service.stop(3_000, true);
    expect(forced.outcome).toBe("exited");
    expect(forced.killed).toBe(true);
    expect(forced.signal).toBe("SIGKILL");
    expect(aliveInTheOs(service.pid ?? 0)).toBe(false);
  });
});

describe("the output tail", () => {
  it("is bounded, so a chatty service cannot grow the supervisor's memory", async () => {
    const service = launch(
      `process.stdout.write("z".repeat(50000)); setInterval(() => {}, 1000);`,
      { maxTailBytes: 1_000 },
    );
    await service.whenStarted();
    await eventually(() => service.stdoutTail().length >= 1_000, "the tail to fill");
    // The claim is boundedness, not a byte count: the tail keeps the newest output
    // and drops the oldest, which is what a startup error printed last needs.
    expect(service.stdoutTail().length).toBeLessThanOrEqual(1_000);
    await service.stop(3_000, true);
  });
});

/**
 * Run the fixture and read back what it reported.
 *
 * The fixture prints the pid before anything that can hang, so a caller that
 * times out still learns what to clean up — which is why the pid is parsed out
 * before any assertion on the rest.
 */
const startDetached = async (
  serviceCode: string,
  marker: string,
): Promise<{ parent: ProcessOutcome; pid: number; before: string; after: string }> => {
  const parent = await runProcess({
    command: process.execPath,
    args: [DETACH_PARENT, serviceCode, marker],
    cwd: SCRATCH,
    timeoutMs: 20_000,
  });

  const lines = parent.stdout.split("\n").filter((line) => line.trim() !== "");
  const identity: unknown = JSON.parse(lines[0] ?? "{}");
  if (typeof identity !== "object" || identity === null || !("pid" in identity)) {
    throw new Error(`the parent did not report a pid:\n${parent.stdout}\n${parent.stderr}`);
  }
  const pid = Number((identity as { readonly pid: unknown }).pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`the parent reported pid ${String(pid)}`);

  const tails: unknown = JSON.parse(lines[1] ?? "{}");
  return {
    parent,
    pid,
    before: String((tails as { readonly before?: unknown }).before ?? ""),
    after: String((tails as { readonly after?: unknown }).after ?? ""),
  };
};

describe("a service that outlives its supervisor", () => {
  it("survives the parent that released it, which stops observing it", async () => {
    // The fixture starts a service through `dist/`, waits for its first line,
    // releases it, waits, and reports — the parent is gone by the time the lane
    // looks. The service keeps working afterwards, which it demonstrates by
    // appending to a file: "still alive" as a pid alone would also be true of a
    // process that has stopped doing anything at all.
    const ticks = join(SCRATCH, "orphan-ticks.txt");
    const service = [
      `const fs = require("node:fs");`,
      `process.stdout.write("up\\n");`,
      `setInterval(() => fs.appendFileSync(${JSON.stringify(ticks)}, "tick\\n"), 25);`,
    ].join(" ");

    const { parent, pid, before, after } = await startDetached(service, "up");
    try {
      // A released child whose pipes were left open would have held the parent's
      // event loop: this is also the assertion that `release()` undoes the thing
      // that made `uvp run` hang.
      expect(
        parent.timedOut,
        `the parent was still running after the release:\n${parent.stderr}`,
      ).toBe(false);
      expect(parent.exitCode).toBe(0);

      // The tail is frozen at the moment of the release, which is what makes
      // "detached" mean "uvp stops knowing" rather than "uvp keeps a buffer it
      // will never show anyone".
      expect(before).toContain("up");
      expect(after).toBe(before);

      const atRelease = sizeOf(ticks);
      await eventually(
        () => sizeOf(ticks) > atRelease,
        "the released service to keep doing its work",
      );
      expect(aliveInTheOs(pid)).toBe(true);
    } finally {
      // uvp is no longer supervising this one, so the lane is. It is left for
      // `reap`, not asserted away: a process reparented to init becomes a zombie
      // until init reaps it, and whether that has happened yet is not a fact
      // about uvp.
      reap(pid);
    }
  }, 30_000);

  it("leaves a released service's later output with no reader, which a Node service does not survive", async () => {
    // **Recorded, not fixed — the mechanism behind `uvp run`'s detach.**
    //
    // `release()` removes the pipe readers and destroys the pipes, because those
    // pipes are what hold the parent's event loop open. The consequence is that
    // the service's stdout has no reader afterwards, and the next write to it
    // fails with EPIPE. Two things follow, and neither is visible from uvp's
    // output:
    //
    // - A **Node** service that logs after the CLI exits dies of an unhandled
    //   `EPIPE` — fatal by default — so a detached service can be killed by its
    //   own next log line.
    // - A **C++** service does not: `SIGPIPE` is inherited ignored across `exec`,
    //   so libuv's write reports an error the service is free to ignore, and
    //   libuvcpp services typically do. The failure mode therefore differs by
    //   language, which is not something a caller could predict from the result.
    //
    // The fix is to give the service somewhere to write — a log file under the
    // workspace, which outlives the CLI — and that is a product decision, not a
    // supervision bug: it adds a filesystem-writing effect to the run contract's
    // `effects` block, with the catalog, the shipped skill and the docs following
    // from it. So this lane records the behaviour instead of deciding it.
    //
    // The service here installs the error handler that a real service would need
    // in order to survive, and records what it ran into. The handler is the point:
    // without it this process would be gone and the lane could not report the
    // EPIPE at all.
    const log = join(SCRATCH, "epipe-log.txt");
    const service = [
      `const fs = require("node:fs");`,
      `process.stdout.on("error", (error) => fs.appendFileSync(${JSON.stringify(log)}, String(error.code) + "\\n"));`,
      `process.stdout.write("first\\n");`,
      `setTimeout(() => process.stdout.write("second\\n"), 400);`,
      `setInterval(() => {}, 1000);`,
    ].join(" ");

    const { parent, pid, before, after } = await startDetached(service, "first");
    try {
      expect(parent.exitCode).toBe(0);
      expect(before).toContain("first");
      // The line the service wrote 400 ms after the release is nowhere in the
      // tail: nothing was reading the pipe, so there was nothing to record.
      expect(after).not.toContain("second");

      await eventually(
        () => existsSync(log) && readFileSync(log, "utf8").includes("EPIPE"),
        "the released service to record the failed write",
      );
    } finally {
      reap(pid);
    }
  }, 30_000);
});
