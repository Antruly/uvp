import { execFile } from "node:child_process";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import { EXIT_NO } from "../../../src/cli/exitCodes.js";
import { parseUvpError } from "../../../src/domain/errors.js";
import { isWindows } from "../../../src/toolchains/host.js";
import { freePort } from "../../support/ports.js";

/**
 * `uvp run` against a workspace that was never built.
 *
 * This is the end-to-end half of the regression the `supervision` lane records in
 * isolation: `startSupervised` used to report a launch it had not observed, so
 * `uvp run` against a workspace with no binary returned exit `0`, a `run_id`, a
 * `still_running: true` with no pid, and a limitation telling the caller to stop
 * it with `uvp_run_stop`. Every one of those fields was a claim about a process
 * that never existed, and a caller that believed them would look for a service
 * that was never started.
 *
 * The unit lane proves the supervisor itself; this one proves what a caller
 * actually receives, which is the only place the whole chain is visible — the
 * kernel's `ENOENT`, the supervisor's `whenStarted()`, the service's throw, the
 * error contract, and the exit code.
 *
 * Two properties are checked, and the second is why the lane runs the CLI as a
 * process rather than calling the handler:
 *
 * - **The refusal is an error, not a result.** A launch that did not happen has
 *   no exit code, no pid, and no readiness answer to report, so nothing may
 *   appear on stdout — a `run` result with `ready: false` would be an answer to a
 *   question nobody could ask.
 * - **It is reported when the launch fails, not when the probe gives up.** With
 *   `--port`, the failure surfaces within milliseconds of the fork. The old
 *   behaviour spent the whole readiness budget (10 s by default) probing a port
 *   nothing was listening on and then reported `ready: false` — a launch that
 *   never happened, described as a service that never answered. The bound below
 *   is half the budget passed on the command line, which distinguishes the two
 *   outcomes on any machine and does not depend on the scheduler.
 *
 * Nothing here needs a compiler or libuvcpp: the workspace is a CMake project by
 * its shape alone, and the point is precisely that uvp never gets as far as
 * building it.
 */

const promisified = promisify(execFile);

const REPOSITORY = resolve(import.meta.dirname, "..", "..", "..");
const UVP = join(REPOSITORY, "scripts", "uvp.mjs");

/** Longer than the readiness budget passed below, so a hang fails as a hang. */
const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** How long the readiness probe is told it may wait before giving up. */
const READINESS_BUDGET_MS = 10_000;
/** The claim: the refusal arrives long before that budget could expire. */
const REFUSAL_BOUND_MS = READINESS_BUDGET_MS / 2;

const SCRATCH = join(realpathSync(tmpdir()), `uvp-launch-refusal-${String(process.pid)}`);
/** A workspace that has never been built: its binary is simply not there. */
const UNBUILT = join(SCRATCH, "unbuilt");
/** A workspace whose binary exists but cannot be executed. */
const NOT_EXECUTABLE = join(SCRATCH, "not-executable");
/** A workspace whose binary is there and runnable — the positive control. */
const LAUNCHABLE = join(SCRATCH, "launchable");
/** A workspace whose binary is runnable, and held open for writing. */
const HELD_OPEN = join(SCRATCH, "held-open");

/**
 * A workspace as uvp recognises one, minus the build.
 *
 * The manifest is what makes the binary name decidable, so the missing file is
 * `<workspace>/build/<binary>` and the error can name it — which is the whole
 * point of writing the manifest rather than relying on the `app` fallback.
 */
const writeWorkspace = (root: string, binary: string | undefined): void => {
  mkdirSync(join(root, "build"), { recursive: true });
  writeFileSync(
    join(root, "CMakeLists.txt"),
    "cmake_minimum_required(VERSION 3.16)\nproject(svc LANGUAGES CXX)\n",
  );
  writeFileSync(
    join(root, "uvp.json"),
    `${JSON.stringify(binary === undefined ? { name: "svc" } : { name: "svc", binary }, null, 2)}\n`,
  );
};

writeWorkspace(UNBUILT, "svc");
writeWorkspace(NOT_EXECUTABLE, "svc");
// Present, and not a program: the kernel's answer is `EACCES`, which reaches the
// same contract by a different route than a missing file.
writeFileSync(join(NOT_EXECUTABLE, "build", "svc"), "not an executable\n");
chmodSync(join(NOT_EXECUTABLE, "build", "svc"), 0o644);

writeWorkspace(LAUNCHABLE, "svc");
// A runnable service, in the only sense this lane needs: something the kernel
// will start and that stays alive until it is signalled. `exec` so the pid uvp
// reports is the process that is actually running, and nothing outlives it.
writeFileSync(join(LAUNCHABLE, "build", "svc"), "#!/bin/sh\nexec sleep 60\n");
chmodSync(join(LAUNCHABLE, "build", "svc"), 0o755);

// The same program, in a workspace whose binary the lane itself holds open for
// writing during the invocation. `r+` rather than `w`: the file has to stay the
// program it is, and a read-write handle is what the kernel counts.
writeWorkspace(HELD_OPEN, "svc");
writeFileSync(join(HELD_OPEN, "build", "svc"), "#!/bin/sh\nexec sleep 60\n");
chmodSync(join(HELD_OPEN, "build", "svc"), 0o755);

/**
 * `title`, on the host that cannot check it.
 *
 * `ETXTBSY` is a POSIX refusal — `execve` declining a file another process holds
 * open for writing — and Windows' `CreateProcess` has no such rule, so the same
 * workspace launches there and the assertion has nothing to be true of. The test
 * says so in its own title rather than being quietly absent from the list.
 */
const named = (title: string): string =>
  isWindows
    ? `${title} — skipped: Windows has no ETXTBSY, and a write handle does not stop CreateProcess`
    : title;

/** Whether the operating system still knows this pid. No signal is delivered. */
const aliveInTheOs = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

interface Invocation {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly elapsedMs: number;
}

const invoke = async (args: readonly string[]): Promise<Invocation> => {
  const started = Date.now();
  const command = `uvp ${args.join(" ")}`;
  try {
    const { stdout, stderr } = await promisified(process.execPath, [UVP, ...args], {
      cwd: REPOSITORY,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    return { exit: 0, stdout, stderr, elapsedMs: Date.now() - started };
  } catch (cause) {
    const failure = cause as { code?: unknown; stdout?: string; stderr?: string; message: string };
    // A timeout or a signal is a different failure from a non-zero exit, and
    // folding it into "exited with a code" would make a hang look like an answer.
    if (typeof failure.code !== "number") {
      throw new Error(`${command} did not exit: ${failure.message}`);
    }
    return {
      exit: failure.code,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      elapsedMs: Date.now() - started,
    };
  }
};

/** The error contract on stderr, or a failure saying what was there instead. */
const failureOf = (invocation: Invocation, where: string): ReturnType<typeof parseUvpError> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(invocation.stderr);
  } catch {
    throw new Error(
      `${where} did not print one JSON object on stderr: ${invocation.stderr.slice(0, 200)}`,
    );
  }
  return parseUvpError(parsed);
};

describe("a launch that never happened", () => {
  it("is refused as an error, with nothing on stdout to mistake for a result", async () => {
    const refusal = await invoke(["run", UNBUILT, "--json"]);

    // Exit 1: the question was asked and the answer is no. Not `2`, which would
    // tell a caller to fix the invocation — the invocation was fine, the
    // workspace is unbuilt.
    expect(refusal.exit).toBe(EXIT_NO);
    // The regression in one line: the old result object arrived here, carrying a
    // run id and `still_running: true` for a process that never existed.
    expect(refusal.stdout.trim()).toBe("");

    const error = failureOf(refusal, "uvp run <unbuilt>");
    expect(error.code).toBe("launch_failed");
    expect(error.category).toBe("execution_failure");
    // The binary, by path, is what the caller has to act on.
    expect(error.message).toContain(join(UNBUILT, "build", "svc"));
    expect(error.remediation.action).toContain("uvp build");
    // Not retryable: asking again changes nothing until the workspace is built.
    expect(error.retryable).toBe(false);
  });

  it("says the same thing without --json", async () => {
    // The human rendering is generated from the same error, so a divergence here
    // would mean two renderers. `remedy:` is the line both promise.
    const refusal = await invoke(["run", UNBUILT]);
    expect(refusal.exit).toBe(EXIT_NO);
    expect(refusal.stdout.trim()).toBe("");
    expect(refusal.stderr).toMatch(/^launch_failed: /u);
    expect(refusal.stderr).toContain("remedy:");
    expect(refusal.stderr).not.toContain("UvpFailure");
    expect(refusal.stderr).not.toMatch(/\n\s+at .*\.js:\d+/u);
  });

  it("reports a binary that exists and cannot be executed, by the same route", async () => {
    // A different errno and the same contract, because from the caller's side it
    // is the same fact: there is a file where the service should be, and the
    // kernel will not start it.
    const refusal = await invoke(["run", NOT_EXECUTABLE, "--json"]);
    expect(refusal.exit).toBe(EXIT_NO);
    expect(refusal.stdout.trim()).toBe("");
    const error = failureOf(refusal, "uvp run <not-executable>");
    expect(error.code).toBe("launch_failed");
    expect(error.message).toContain(join(NOT_EXECUTABLE, "build", "svc"));
  });

  it.skipIf(isWindows)(
    named("reports a binary the kernel refuses because it is open for writing"),
    async () => {
      // The third way a launch is refused, and the one that arrived in CI as a
      // bare `Error`: a file some process holds open for writing cannot be
      // `execve`d, and Node reports *that* errno by throwing from `spawn` rather
      // than by emitting `error` — so the throw happened before the supervisor had
      // a handle to reject through, and it escaped `WorkspaceService.run` with no
      // code, no remedy, and no path (the message is `spawn ETXTBSY`; the errno is
      // the whole of it). See #33.
      //
      // No race is needed to reach it, which is why this refusal is asserted
      // rather than waited for: holding the handle open *is* the precondition. The
      // control is in the same test — the same workspace, the same binary, the
      // handle closed — so the refusal is demonstrably about the write handle and
      // not about the workspace.
      const binary = join(HELD_OPEN, "build", "svc");
      const held = openSync(binary, "r+");
      try {
        const refusal = await invoke(["run", HELD_OPEN, "--json"]);
        expect(refusal.exit).toBe(EXIT_NO);
        expect(refusal.stdout.trim()).toBe("");
        const error = failureOf(refusal, "uvp run <held-open>");
        expect(error.code).toBe("launch_failed");
        // The path, which is the fact the host's own message could not carry.
        expect(error.message).toContain(binary);
      } finally {
        closeSync(held);
      }

      const launched = await invoke(["run", HELD_OPEN, "--json"]);
      expect(launched.exit).toBe(0);
      expect(launched.stderr.trim()).toBe("");
      const pid = Number((JSON.parse(launched.stdout) as { pid?: unknown }).pid);
      expect(Number.isInteger(pid) && pid > 0, `no pid in ${launched.stdout}`).toBe(true);
      process.kill(pid, "SIGKILL");
    },
  );

  it("refuses immediately with --port, rather than spending the readiness budget", async () => {
    // The distinction this lane exists for. When the fork fails there is nothing
    // to probe, and a result that waited out the full budget would be reporting a
    // timeout it never had — `ready: false` about a service that was never
    // started, with a `startup_ms` that measures the probe, not a startup.
    const port = await freePort();
    const refusal = await invoke([
      "run",
      UNBUILT,
      "--port",
      String(port),
      "--timeout",
      String(READINESS_BUDGET_MS),
      "--json",
    ]);

    expect(refusal.exit).toBe(EXIT_NO);
    expect(refusal.stdout.trim()).toBe("");
    expect(failureOf(refusal, "uvp run --port <unbuilt>").code).toBe("launch_failed");
    expect(
      refusal.elapsedMs,
      `the refusal took ${String(refusal.elapsedMs)}ms, which is the readiness budget being spent`,
    ).toBeLessThan(REFUSAL_BOUND_MS);
  });

  it("does not create the workspace it was pointed at", async () => {
    // Fail-closed, and the other half of the refusal: an unbuilt workspace stays
    // unbuilt. A run that helpfully created `build/` would be a write the caller
    // never asked for, and the next `uvp build` would configure into a directory
    // holding whatever the failed run left behind.
    const absent = join(SCRATCH, "never-created");
    const refusal = await invoke(["run", absent, "--json"]);
    expect(refusal.exit).toBe(EXIT_NO);
    expect(refusal.stdout.trim()).toBe("");
    expect(failureOf(refusal, "uvp run <absent>").code).toBe("launch_failed");
    expect(() => chmodSync(absent, 0o755)).toThrow(/ENOENT/u);
  });

  it("still reports a launch that did happen, so the refusal is about the fork", async () => {
    // The positive control, and the reason it is not a mock: a handler that
    // refused every `run` would satisfy every assertion above. This workspace's
    // binary exists and is executable — a shell script, so no compiler and no
    // libuvcpp are needed — and the result is a launch with a real pid behind it,
    // which the lane then checks against the kernel and ends.
    //
    // It is also the half of the contract the regression broke in the other
    // direction: `still_running` and `detached` are only meaningful here, where
    // there is a process for them to be true of.
    const launched = await invoke(["run", LAUNCHABLE, "--json"]);
    expect(launched.exit).toBe(0);
    expect(launched.stderr.trim()).toBe("");

    const result = JSON.parse(launched.stdout) as {
      tool: string;
      pid?: unknown;
      still_running?: unknown;
      detached?: unknown;
    };
    expect(result.tool).toBe("uvp_run");
    const pid = Number(result.pid);
    expect(Number.isInteger(pid) && pid > 0, `no pid in ${launched.stdout}`).toBe(true);
    expect(result.still_running).toBe(true);
    expect(result.detached).toBe(true);
    // The pid is a claim about a process, checked where claims about processes
    // are checked. It outlives the CLI because the run detached it.
    expect(aliveInTheOs(pid)).toBe(true);
    process.kill(pid, "SIGKILL");
  });
});
