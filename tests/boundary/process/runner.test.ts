import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { runProcess } from "../../../src/toolchains/local/processRunner.js";

/**
 * What the kernel reports back.
 *
 * `runProcess` is the one place a compiler, a CMake configure, and a doctor probe
 * are turned into an outcome, and its purpose is that a caller gets the same
 * answer whichever of those ran. That answer is a claim about the operating
 * system — an exit code, a signal, a deadline, a byte count — so it cannot be
 * established by a fake: the values it exists to distinguish are the ones the
 * kernel produces and nothing else does.
 *
 * Six distinctions are load-bearing enough to check against real processes:
 *
 * - **a non-zero exit is an outcome, not a throw.** The caller asked what
 *   happened, and "it failed" is an answer. Only a process that could not be
 *   started at all is a different kind of fact.
 * - **dying from a signal is not dying with a code.** A compiler killed by the OOM
 *   killer and a compiler that returned 1 are different problems.
 * - **a timeout is reported as a timeout**, and the process is actually gone.
 * - **an abort is distinguished from a timeout**, because one was the caller's
 *   decision and the other was the machine's.
 * - **truncated output says so.** A 4 MiB build log that silently keeps the first
 *   4 MiB is a report about a prefix presented as the whole thing.
 * - **the working directory and the environment are the child's**, because a build
 *   that ran somewhere else is a build whose output paths mean something else.
 *
 * The module is imported from `src/`, the way the other lanes reach the code under
 * test; what makes this a *built* lane is the rest of the project, which drives the
 * compiled artifact as a process (`runner` here, `supervision`, and the fixture the
 * orphan test runs against `dist/`). The distinction matters for reading these
 * results: they are observations of this host's kernel, not of the shipped bundle.
 *
 * Children are `node -e` rather than fixture files: the behaviour under observation
 * is the kernel's, so the shortest program that exhibits it has the least to go
 * wrong between the test and the fact.
 */

const SCRATCH = join(realpathSync(tmpdir()), `uvp-process-boundary-${String(process.pid)}`);
const CWD = join(SCRATCH, "cwd");

mkdirSync(CWD, { recursive: true });

type RunnerOptions = Omit<Parameters<typeof runProcess>[0], "command" | "args">;

/** Run a program through `node -e`. No shell is involved, so nothing is re-parsed. */
const nodeProgram = (code: string, options: RunnerOptions = {}) =>
  runProcess({ ...options, command: process.execPath, args: ["-e", code] });

/** A child that never ends on its own. */
const forever = "setInterval(() => {}, 1000);";

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe("an exit code is an outcome, not a throw", () => {
  it("reports the code a failing process exited with, and does not reject", async () => {
    // The distinction the whole build path rests on: `uvp build` reports a compile
    // failure as diagnostics in a result, which is only possible if a compiler's
    // non-zero status arrives as a value.
    const outcome = await nodeProgram("process.exit(3)");
    expect(outcome.exitCode).toBe(3);
    expect(outcome.signal).toBeNull();
    expect(outcome.timedOut).toBe(false);
    expect(outcome.aborted).toBe(false);
    expect(outcome.command).toContain(process.execPath);
  });

  it("keeps both streams and counts their bytes", async () => {
    // Byte counts are what make truncation decidable: a caller can compare what it
    // received against what was produced without re-parsing the text.
    const outcome = await nodeProgram(`
      process.stdout.write("to stdout");
      process.stderr.write("to stderr");
    `);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe("to stdout");
    expect(outcome.stderr).toBe("to stderr");
    expect(outcome.stdoutBytes).toBe(9);
    expect(outcome.stderrBytes).toBe(9);
    expect(outcome.stdoutTruncated).toBe(false);
    expect(outcome.stderrTruncated).toBe(false);
  });

  it("rejects a program that could not be started, which is a different fact", async () => {
    // Not an exit code: nothing ran, so there is no exit code to report. Folding
    // this into `exitCode: -1` would make a missing compiler look like a compiler
    // that said no.
    await expect(
      runProcess({ command: join(SCRATCH, "no-such-program"), args: [] }),
    ).rejects.toThrow();
  });
});

describe("how the process ended", () => {
  it("reports death by signal as a signal, with no exit code", async () => {
    const outcome = await nodeProgram(`process.kill(process.pid, "SIGKILL"); ${forever}`);
    expect(outcome.exitCode).toBeNull();
    expect(outcome.signal).toBe("SIGKILL");
  });

  it("kills a process that outlives its timeout, and says it timed out", async () => {
    const started = Date.now();
    const outcome = await nodeProgram(forever, { timeoutMs: 400 });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.signal).toBe("SIGKILL");
    // The deadline is a bound rather than a suggestion: a timeout that waits for
    // the process to finish on its own is not a timeout. The margin is wide because
    // the claim is about the order of magnitude, not about the scheduler.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("distinguishes an abort the caller asked for from a timeout the machine imposed", async () => {
    // The MCP server cancels work when its client goes away. A cancelled build
    // reported as a timed-out build sends the caller looking at their compiler
    // instead of at their own request.
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const outcome = await nodeProgram(forever, { signal: controller.signal });
    expect(outcome.aborted).toBe(true);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.signal).toBe("SIGKILL");
  });
});

describe("output that was too large says so", () => {
  it("caps the text, keeps counting the bytes, and flags the truncation", async () => {
    const outcome = await nodeProgram(
      `process.stdout.write("x".repeat(200000)); process.stderr.write("y".repeat(5000));`,
      { maxOutputBytes: 1_000 },
    );
    expect(outcome.stdout.length).toBe(1_000);
    expect(outcome.stdoutBytes).toBe(200_000);
    expect(outcome.stdoutTruncated).toBe(true);
    expect(outcome.stderr.length).toBe(1_000);
    expect(outcome.stderrBytes).toBe(5_000);
    expect(outcome.stderrTruncated).toBe(true);
  });

  it("does not flag output that fit", async () => {
    // The positive control: a flag that is always true would make every build log
    // look like a prefix, and a reader would learn to ignore it.
    const outcome = await nodeProgram(`process.stdout.write("short");`);
    expect(outcome.stdoutTruncated).toBe(false);
    expect(outcome.stdoutBytes).toBe(5);
  });
});

describe("the child's own environment", () => {
  it("runs where it was told to run", async () => {
    const outcome = await nodeProgram("process.stdout.write(process.cwd());", { cwd: CWD });
    // Canonicalised on the way in, because `/tmp` is a symlink on macOS and the
    // child reports what the kernel resolved rather than what the caller typed.
    expect(outcome.stdout).toBe(realpathSync(CWD));
  });

  it("extends the environment by default and replaces it on request", async () => {
    const extended = await nodeProgram("process.stdout.write(String(process.env.UVP_PROBE));", {
      env: { UVP_PROBE: "value" },
    });
    expect(extended.stdout).toBe("value");
    // Replacing is the option that matters to a build: inheriting a parent's
    // CMAKE_PREFIX_PATH while claiming to build against one prefix is how a build
    // ends up linking a library nobody asked for.
    const replaced = await nodeProgram("process.stdout.write(String(process.env.PATH));", {
      env: { UVP_PROBE: "value" },
      replaceEnv: true,
    });
    expect(replaced.stdout).toBe("undefined");
  });
});
