import { describe, expect, it } from "vitest";

import { DoctorService } from "../../src/application/DoctorService.js";
import type { DoctorInput, DoctorReport } from "../../src/application/DoctorService.js";
import type { EvidenceRecorder } from "../../src/application/evidenceHelpers.js";
import { runCli } from "../../src/cli.js";
import { EXIT_OK, EXIT_WRONG } from "../../src/cli/exitCodes.js";
import type { OutputStreams } from "../../src/cli/output.js";
import { createUvpServices } from "../../src/composition/uvpServices.js";
import type { UvpServices } from "../../src/composition/uvpServices.js";

/**
 * What a CLI call leaves behind in the process it ran in.
 *
 * `runCli` is a function: it takes words and returns an exit code. The process
 * around it — its exit code, its working directory, its signal handlers — belongs
 * to whoever called it. This lane is where that boundary is checked, and an
 * in-process call is the only way to see it: a subprocess's handler table and
 * `process.exitCode` die with the subprocess, so a leak into the caller is
 * invisible from outside. That is why the other lanes cannot cover this one.
 *
 * Three facts, each with a way to go wrong that nothing else would report:
 *
 * - **`process.exitCode`.** Set here, it becomes the *host's* verdict — an MCP
 *   server or a test runner would exit with the code of a command it merely ran.
 *   The command's code is `runCli`'s return value and nothing else.
 * - **`process.cwd()`.** The paths a tool reports are resolved by the service that
 *   owns them; a command that changed directory would make the next call's
 *   relative paths mean something else, in a process that never asked for it.
 * - **the signal handlers.** A tool call installs SIGINT and SIGTERM for the
 *   length of the call and removes them in a `finally`. Both halves are load
 *   bearing. Installed, so a Ctrl-C through a build aborts the tool call instead
 *   of the process. Removed, because a handler left behind fires on the *next*
 *   call's signal with a controller that already aborted — a cancellation
 *   arriving from nowhere — and eleven leaked pairs is where Node starts printing
 *   `MaxListenersExceededWarning` into someone's terminal.
 *
 * The commands below are chosen so that the answer does not depend on this host.
 * `doctor` is deliberately *not* asserted on its exit code: a missing prerequisite
 * is a legitimate exit 1, and a test that read that as a failure would be
 * measuring the machine instead of the CLI.
 *
 * The modules are imported from `src/`, the way the other lanes reach the code
 * under test; what makes this a *built* lane is the rest of the project.
 */

/** The process-level state a call must not change. */
interface Trace {
  /** As Node types it: whatever is set here is inherited by the host process. */
  readonly exitCode: number | string | null | undefined;
  readonly cwd: string;
  /** Signal and trap counts, in `EVENTS` order. */
  readonly listeners: readonly (readonly [string, number])[];
}

/** Signals first: those are the ones a command installs. The two traps are here
 * because the CLI's failure path must not fall back to the default traps. */
const EVENTS = ["SIGINT", "SIGTERM", "unhandledRejection", "uncaughtException"] as const;

const trace = (): Trace => ({
  exitCode: process.exitCode,
  cwd: process.cwd(),
  listeners: EVENTS.map((event) => [event, process.listenerCount(event)] as const),
});

const counts = (): readonly [number, number] => [
  process.listenerCount("SIGINT"),
  process.listenerCount("SIGTERM"),
];

/** Nothing below is about the text; the invocations themselves are the subject. */
const quiet: OutputStreams = { out: () => {}, err: () => {} };

/**
 * A doctor that records the handler table as the tool call sees it.
 *
 * The install is the half of the pair that cannot be observed from outside the
 * call: by the time `runCli` returns, a handler that was installed and removed is
 * indistinguishable from one that was never installed. Subclassing the service
 * the handler calls puts the reading inside the call, where it is deterministic
 * rather than a race against how long a doctor probe happens to take.
 */
class WatchedDoctor extends DoctorService {
  /** Handler counts at the start and at the end of each `doctor` call. */
  readonly during: (readonly [number, number])[] = [];

  override async doctor(
    input: DoctorInput,
    recorder: EvidenceRecorder,
    signal: AbortSignal,
  ): Promise<DoctorReport> {
    this.during.push(counts());
    const report = await super.doctor(input, recorder, signal);
    this.during.push(counts());
    return report;
  }
}

describe("an in-process CLI call", () => {
  it("returns its verdict and leaves the process it ran in untouched", async () => {
    const before = trace();
    const spoken: string[] = [];
    const streams: OutputStreams = {
      out: (text) => spoken.push(text),
      err: (text) => spoken.push(text),
    };

    const codes = [
      await runCli(["--help"], { streams }),
      // No command, asked in JSON. Both arms of the missing-command branch: a
      // person gets the command list on stdout, a parser gets an error.
      await runCli(["--json"], { streams }),
      await runCli(["no-such-command", "--json"], { streams }),
      // A tool call that reaches a service and succeeds.
      await runCli(["stop", "--all", "--json"], { streams }),
      // A tool call that throws inside the handler, which is the path whose
      // `finally` is the only thing removing the handlers it installed.
      await runCli(["stop", "--run-id", "not-a-run-id", "--json"], { streams }),
      // A failure raised by a provider rather than by a schema.
      await runCli(["build", "/nonexistent-uvp-workspace", "--json"], { streams }),
    ];

    expect(codes).toEqual([EXIT_OK, EXIT_WRONG, EXIT_WRONG, EXIT_OK, EXIT_WRONG, EXIT_WRONG]);
    expect(trace()).toEqual(before);
    // The failures went to the stream they were handed, not to the process's own.
    // That is what makes the rest of this file checkable at all: nothing here
    // writes a transcript, so the test's output is only ever the test's.
    expect(spoken.length).toBeGreaterThan(0);
  });

  it("holds a signal handler for the length of a call, and no longer", async () => {
    const before = trace();
    const [sigint, sigterm] = counts();

    const base = createUvpServices();
    const watched = new WatchedDoctor({ providers: base.providers, now: base.now });
    const services: UvpServices = { ...base, doctor: watched };

    await runCli(["doctor", "--json"], { streams: quiet, services });

    // The reading is inside the call on both sides of it, so this says the pair
    // is installed *before* the handler runs and still installed after it
    // returned — not merely that something was installed once.
    const held: readonly [number, number] = [sigint + 1, sigterm + 1];
    expect(watched.during).toEqual([held, held]);
    expect(trace()).toEqual(before);
  });

  it("does not accumulate handlers across many calls, including the ones that throw", async () => {
    const before = trace();

    // Twelve of each: past the point where a leaked pair would be a warning, and
    // far enough that the throw path's cleanup is exercised rather than merely
    // reached once.
    for (let index = 0; index < 12; index += 1) {
      await runCli(["stop", "--all", "--json"], { streams: quiet });
      await runCli(["stop", "--run-id", "not-a-run-id", "--json"], { streams: quiet });
    }

    expect(trace()).toEqual(before);
  });
});
