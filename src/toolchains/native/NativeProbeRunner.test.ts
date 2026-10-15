import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { NativeProbeRunner } from "./NativeProbeRunner.js";
import type {
  NativeProbeOutcome,
  NativeProbeReport,
} from "../../application/NativeWebSocketProbe.js";
import type { ProcessOutcome, RunProcessOptions } from "../local/processRunner.js";

/**
 * The runner, with the child scripted.
 *
 * What is under test here is the *conversation* — the JSON that goes to the
 * probe, and what each of the probe's endings becomes on the way back. The probe
 * itself is a C++ program built against a libuvcpp install, and a test that
 * needed both to ask "is exit 3 reported as an unavailable stack" would skip on
 * every host that has neither.
 *
 * So `runProcess` is injected. The one thing that is *not* faked is the
 * executable check: the runner asks the filesystem whether its candidate can be
 * run before it spawns anything, so the scripted answers below sit behind a real
 * `accessSync` on a real executable — this Node binary. That keeps the first
 * branch of `availability()` honest, which is the branch a fake would otherwise
 * silently paper over.
 */

/** An executable that is definitely present: the Node running this test. */
const EXECUTABLE = process.execPath;

const SIGNAL = new AbortController().signal;

const VERSION = JSON.stringify({
  probe: "uvcpp-capi",
  abi_version: 1,
  header_abi_version: 1,
  library_version: "1.7.0",
});

/** The fields `runProcess` always fills in, so a test states only the ones it changed. */
const BASE: ProcessOutcome = {
  command: "uvcpp-probe",
  exitCode: 0,
  signal: null,
  timedOut: false,
  aborted: false,
  durationMs: 1,
  stdout: "",
  stderr: "",
  stdoutBytes: 0,
  stderrBytes: 0,
  stdoutTruncated: false,
  stderrTruncated: false,
};

/**
 * A runner whose child answers from a script.
 *
 * Answers are handed out in call order. `probe()` asks `--version` first and only
 * then runs the probe, so the first answer is the availability check unless a
 * test deliberately breaks it — which is itself worth pinning, because it is the
 * order the real runner uses.
 */
const runnerWith = (...answers: readonly (Partial<ProcessOutcome> | Error)[]) => {
  const calls: RunProcessOptions[] = [];
  const remaining = [...answers];
  const runner = new NativeProbeRunner({
    env: { UVP_NATIVE_PROBE: EXECUTABLE },
    availabilityTimeoutMs: 1_000,
    killGraceMs: 10,
    runProcess: async (options) => {
      calls.push(options);
      const answer = remaining.shift() ?? {};
      if (answer instanceof Error) throw answer;
      return { ...BASE, command: options.command, ...answer };
    },
  });
  return { runner, calls };
};

/** An available runner: `--version` answers, and then whatever the test scripts. */
const available = (...answers: readonly (Partial<ProcessOutcome> | Error)[]) =>
  runnerWith({ stdout: VERSION }, ...answers);

const reportOf = (outcome: NativeProbeOutcome): NativeProbeReport => {
  if (outcome.kind !== "report") {
    throw new Error(`expected a report, got ${outcome.kind}: ${JSON.stringify(outcome)}`);
  }
  return outcome.report;
};

/** The JSON the runner wrote to a child's stdin. */
const requestOf = (call: RunProcessOptions | undefined): Record<string, unknown> => {
  if (call?.stdin === undefined) throw new Error("no request was written to the child's stdin");
  return JSON.parse(call.stdin) as Record<string, unknown>;
};

/** A minimal report, so a test can change one field and leave the rest valid. */
const report = (overrides: Record<string, unknown> = {}): Partial<ProcessOutcome> => ({
  stdout: JSON.stringify({
    probe: "uvcpp-capi",
    url: "ws://127.0.0.1:9000/echo",
    opened: true,
    handshake_completed: true,
    frames: [],
    frames_received: 0,
    frames_withheld: 0,
    close_sent_by_probe: false,
    peer_closed: false,
    error: null,
    stop_reason: "idle",
    total_ms: 40,
    not_observable: ["the upgrade response's status line and headers"],
    ...overrides,
  }),
});

describe("deciding whether the native stack can be used here", () => {
  it("is available when the probe reports the ABI it was built against", async () => {
    const { runner, calls } = runnerWith({ stdout: VERSION });
    const availability = await runner.availability(SIGNAL);

    expect(availability).toEqual({
      state: "available",
      path: EXECUTABLE,
      libraryVersion: "1.7.0",
    });
    // `--version` and nothing else: the check that establishes the stack works
    // must not connect to anything, or "is this host able to probe" would be
    // answered by a probe.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["--version"]);
    expect(calls[0]?.stdin).toBeUndefined();
    expect(calls[0]?.timeoutMs).toBe(1_000);
  });

  it("is unavailable when the file it was told about is not there, and runs nothing", async () => {
    const absent = join(tmpdir(), "uvp-no-such-probe-2f4c1b");
    const calls: RunProcessOptions[] = [];
    const runner = new NativeProbeRunner({
      env: { UVP_NATIVE_PROBE: absent },
      runProcess: async (options) => {
        calls.push(options);
        return { ...BASE, command: options.command };
      },
    });

    const availability = await runner.availability(SIGNAL);
    expect(availability.state).toBe("unavailable");
    if (availability.state === "unavailable") {
      // The reason says which candidate was examined and how it was chosen. A
      // caller who set UVP_NATIVE_PROBE to a typo needs to see the path they set,
      // not a generic "no probe".
      expect(availability.reason).toContain("UVP_NATIVE_PROBE");
      expect(availability.reason).toContain(absent);
      expect(availability.path).toBe(absent);
    }
    expect(calls).toHaveLength(0);
  });

  it("is undetermined when the probe is there but did not answer", async () => {
    // The third state, and the reason it exists. A probe that was found and then
    // hung has not been shown to be broken — a loaded machine answers this the
    // same way a broken binary does — so saying "unavailable" would report a
    // finding the check did not produce.
    const { runner } = runnerWith({ timedOut: true, exitCode: null, signal: "SIGKILL" });
    const availability = await runner.availability(SIGNAL);

    expect(availability.state).toBe("undetermined");
    if (availability.state === "undetermined") {
      expect(availability.reason).toContain("1000 ms");
      expect(availability.path).toBe(EXECUTABLE);
    }
  });

  it("is undetermined when the check was cancelled before it answered", async () => {
    const { runner } = runnerWith({ aborted: true, exitCode: null, signal: "SIGKILL" });
    expect((await runner.availability(SIGNAL)).state).toBe("undetermined");
  });

  it("is unavailable when the binary printed something that is not one of its reports", async () => {
    // A file that is executable and is not this probe: a stray `uvcpp-probe` from
    // somewhere else, or a script. Reported with what it actually printed.
    const { runner } = runnerWith({ stdout: "hello\n", stderr: "" });
    const availability = await runner.availability(SIGNAL);

    expect(availability.state).toBe("unavailable");
    if (availability.state === "unavailable") {
      expect(availability.reason).toContain("printed no probe report");
    }
  });

  it("names an ABI mismatch instead of calling the probe broken", async () => {
    // The failure mode with no useful symptom: the probe runs, connects, and
    // reports a handshake that the library never performed. It is caught here, and
    // the two numbers are what a reader needs to act on it.
    const { runner } = runnerWith({
      exitCode: 3,
      stdout: JSON.stringify({
        probe: "uvcpp-capi",
        abi_version: 2,
        header_abi_version: 1,
        library_version: "1.7.0",
      }),
    });
    const availability = await runner.availability(SIGNAL);

    expect(availability.state).toBe("unavailable");
    if (availability.state === "unavailable") {
      expect(availability.reason).toContain("built against C ABI 1");
      expect(availability.reason).toContain("reports 2");
    }
  });
});

describe("writing the request the probe reads", () => {
  it("writes the request the probe reads, and asks it nothing about expectations", async () => {
    const { runner, calls } = available(report());
    await runner.probe(
      {
        url: "ws://127.0.0.1:9000/echo",
        send: [
          { payload: "hello", encoding: "utf8", waitMs: 0 },
          { payload: "AAEC", encoding: "base64", waitMs: 0 },
        ],
        maxFrames: 7,
        maxFrameBytes: 4_096,
        idleTimeoutMs: 1_500,
        totalTimeoutMs: 6_500,
      },
      SIGNAL,
    );

    expect(requestOf(calls[1])).toEqual({
      url: "ws://127.0.0.1:9000/echo",
      idle_ms: 1_500,
      total_timeout_ms: 6_500,
      max_frames: 7,
      max_frame_bytes: 4_096,
      send: [
        { text: "hello", wait_ms: 0 },
        { binary_base64: "AAEC", wait_ms: 0 },
      ],
    });
    // No `expect` key at all, rather than an empty one. The question "did a
    // received frame contain this text" is answered once, by the service, for
    // both stacks; a probe that was also asked it would be a second matcher with
    // its own idea of which frames count.
    expect(requestOf(calls[1])["expect"]).toBeUndefined();
  });

  it("bounds the report by the request rather than by a fixed cap", async () => {
    const small = available(report());
    await small.runner.probe(
      {
        url: "ws://127.0.0.1:9000/echo",
        send: [],
        maxFrames: 2,
        maxFrameBytes: 1_024,
        idleTimeoutMs: 10,
        totalTimeoutMs: 20,
      },
      SIGNAL,
    );

    const large = available(report());
    const many = 200;
    await large.runner.probe(
      {
        url: "ws://127.0.0.1:9000/echo",
        send: [],
        maxFrames: many,
        maxFrameBytes: 4_096,
        idleTimeoutMs: 10,
        totalTimeoutMs: 20,
      },
      SIGNAL,
    );

    const smallBudget = small.calls[1]?.maxOutputBytes ?? 0;
    const largeBudget = large.calls[1]?.maxOutputBytes ?? 0;
    // A frame arrives base64-encoded when it is binary, with a third again as
    // many bytes as it had, so the report a caller's own caps can produce has to
    // fit — and a budget that did not would truncate a report the probe was
    // asked to write, which reads as a probe that failed.
    expect(smallBudget).toBeGreaterThan(2 * Math.ceil((1_024 * 4) / 3));
    expect(largeBudget).toBeGreaterThan(many * Math.ceil((4_096 * 4) / 3));
    expect(largeBudget).toBeGreaterThan(smallBudget);
    // And bounded above: `max_frames` is the caller's number, not a licence to
    // hold as many bytes as it implies.
    expect(largeBudget).toBeLessThanOrEqual(32 * 1024 * 1024);
  });
});

describe("reading the report the probe wrote", () => {
  it("maps a report to the port's facts, including the ones that are absences", async () => {
    const { runner } = available(
      report({
        frames: [
          {
            direction: "sent",
            opcode: "text",
            bytes: 5,
            at_ms: 3,
            truncated: false,
            text: "hello",
          },
          {
            direction: "received",
            opcode: "binary",
            bytes: 4,
            at_ms: 9,
            truncated: false,
            base64: "AAEC",
          },
          {
            direction: "received",
            opcode: "text",
            bytes: 900,
            at_ms: 12,
            truncated: true,
            text_omitted: "truncated",
          },
        ],
        frames_received: 2,
        frames_withheld: 5,
        peer_closed: true,
        close: { code: 1001, reason: "going away" },
        error: null,
        stop_reason: "total",
        total_ms: 6_500,
        not_observable: ["ping and pong frames"],
        loop_return: 7,
      }),
    );

    const mapped = reportOf(
      await runner.probe(
        {
          url: "ws://127.0.0.1:9000/echo",
          send: [],
          maxFrames: 10,
          maxFrameBytes: 64,
          idleTimeoutMs: 1_000,
          totalTimeoutMs: 6_500,
        },
        SIGNAL,
      ),
    );

    expect(mapped.upgraded).toBe(true);
    expect(mapped.frames).toEqual([
      { direction: "sent", opcode: "text", bytes: 5, atMs: 3, truncated: false, text: "hello" },
      {
        direction: "received",
        opcode: "binary",
        bytes: 4,
        atMs: 9,
        truncated: false,
        base64: "AAEC",
      },
      {
        direction: "received",
        opcode: "text",
        bytes: 900,
        atMs: 12,
        truncated: true,
        textOmitted: "truncated",
      },
    ]);
    expect(mapped.framesReceived).toBe(2);
    expect(mapped.framesWithheld).toBe(5);
    expect(mapped.stopReason).toBe("total");
    expect(mapped.totalMs).toBe(6_500);
    expect(mapped.notObservable).toEqual(["ping and pong frames"]);
    // Reported and never interpreted: the C ABI documents no meaning for the
    // loop's return value, so a caller gets the number.
    expect(mapped.loopReturn).toBe(7);
    expect(mapped.libraryVersion).toBe("1.7.0");
    // 1001 is a code a Close frame carries, so the connection was closed rather
    // than dropped. The permission is in the code; the frame itself was never
    // observable on this stack.
    expect(mapped.close).toEqual({
      code: 1001,
      reason: "going away",
      closeFrameReceived: true,
    });
    expect(mapped.error).toBeUndefined();
  });

  it("reads 1006 as a connection that ended without a closing handshake", async () => {
    // The one code that says a Close frame did *not* arrive: RFC 6455 §7.1.5
    // reserves 1006 for exactly this, and it is the only value from which
    // "the peer said goodbye" can be inferred at all on this stack.
    const { runner } = available(report({ peer_closed: true, close: { code: 1006, reason: "" } }));
    const mapped = reportOf(
      await runner.probe(
        {
          url: "ws://127.0.0.1:9000/echo",
          send: [],
          maxFrames: 1,
          maxFrameBytes: 64,
          idleTimeoutMs: 10,
          totalTimeoutMs: 20,
        },
        SIGNAL,
      ),
    );
    expect(mapped.close?.closeFrameReceived).toBe(false);
  });
});

describe("the refusals the probe makes itself", () => {
  it("passes on a refusal in the probe's own words rather than inferring one", async () => {
    const { runner } = available({
      exitCode: 2,
      stdout: JSON.stringify({
        probe: "uvcpp-capi",
        error: { what: "wait_ms between sends is not something the libuvcpp C ABI can do" },
      }),
      stderr: "uvcpp-probe: wait_ms between sends is not something the libuvcpp C ABI can do\n",
    });

    const outcome = await runner.probe(
      {
        url: "ws://127.0.0.1:9000/echo",
        send: [{ payload: "a", encoding: "utf8", waitMs: 50 }],
        maxFrames: 1,
        maxFrameBytes: 64,
        idleTimeoutMs: 10,
        totalTimeoutMs: 20,
      },
      SIGNAL,
    );
    expect(outcome).toEqual({
      kind: "request-refused",
      message: "wait_ms between sends is not something the libuvcpp C ABI can do",
    });
  });

  it("reads exit 3 as a stack that cannot run here, with the probe's reason", async () => {
    const { runner } = available({
      exitCode: 3,
      stdout: JSON.stringify({
        probe: "uvcpp-capi",
        error: { what: "uvcpp_c_ws_client_new failed" },
      }),
    });

    const outcome = await runner.probe(
      {
        url: "ws://127.0.0.1:9000/echo",
        send: [],
        maxFrames: 1,
        maxFrameBytes: 64,
        idleTimeoutMs: 10,
        totalTimeoutMs: 20,
      },
      SIGNAL,
    );
    expect(outcome).toEqual({
      kind: "stack-unavailable",
      state: "unavailable",
      reason: "uvcpp_c_ws_client_new failed",
      path: EXECUTABLE,
    });
  });
});

describe("when no report arrives", () => {
  it("reports a probe that had to be killed as a fact about the probe", async () => {
    // The supervisor's deadline is the backstop for a probe that did not end
    // itself, and hitting it says nothing about the target. Reported as a failed
    // run, with the bound it exceeded, rather than as a probe that saw nothing —
    // those are different findings and only one of them is supported.
    const { runner } = available({
      timedOut: true,
      exitCode: null,
      signal: "SIGKILL",
      stderr: "uvcpp-probe: still running\n",
    });

    const outcome = await runner.probe(
      {
        url: "ws://127.0.0.1:9000/echo",
        send: [],
        maxFrames: 1,
        maxFrameBytes: 64,
        idleTimeoutMs: 1_000,
        totalTimeoutMs: 5_000,
      },
      SIGNAL,
    );
    expect(outcome.kind).toBe("probe-failed");
    if (outcome.kind === "probe-failed") {
      expect(outcome.message).toContain("5010 ms");
      expect(outcome.detail).toBe("uvcpp-probe: still running");
    }
  });

  it("calls a report it cannot read version skew, not an observation", async () => {
    // A report that arrived but has no `frames_received` is between uvp and the
    // probe, not between uvp and the target. Reading it as "the far end sent
    // nothing" would be a finding about a server, derived from a missing field.
    const { runner, calls } = available(report({ frames_received: undefined }));
    const outcome = await runner.probe(
      {
        url: "ws://127.0.0.1:9000/echo",
        send: [],
        maxFrames: 1,
        maxFrameBytes: 64,
        idleTimeoutMs: 10,
        totalTimeoutMs: 20,
      },
      SIGNAL,
    );
    expect(outcome.kind).toBe("probe-failed");
    if (outcome.kind === "probe-failed") {
      expect(outcome.message).toContain("missing fields this uvp needs");
    }
    expect(calls).toHaveLength(2);
  });

  it("refuses to map a frame log entry it does not know", async () => {
    // A frame whose opcode is one this uvp has no case for — a ping, later, or a
    // control opcode a future probe adds. Mapped into the nearest field it would
    // become a data frame nobody sent.
    const { runner } = available(
      report({
        frames: [{ direction: "received", opcode: "ping", bytes: 0, at_ms: 1, truncated: false }],
      }),
    );
    const outcome = await runner.probe(
      {
        url: "ws://127.0.0.1:9000/echo",
        send: [],
        maxFrames: 1,
        maxFrameBytes: 64,
        idleTimeoutMs: 10,
        totalTimeoutMs: 20,
      },
      SIGNAL,
    );
    expect(outcome.kind).toBe("probe-failed");
    if (outcome.kind === "probe-failed") {
      expect(outcome.message).toContain("frame log carries an entry this uvp does not know");
      expect(outcome.message).toContain('"ping"');
    }
  });

  it("turns a child that could not be started into a sentence", async () => {
    const { runner } = available(new Error("spawn EACCES"));
    const outcome = await runner.probe(
      {
        url: "ws://127.0.0.1:9000/echo",
        send: [],
        maxFrames: 1,
        maxFrameBytes: 64,
        idleTimeoutMs: 10,
        totalTimeoutMs: 20,
      },
      SIGNAL,
    );
    expect(outcome).toEqual({ kind: "probe-failed", message: "spawn EACCES", detail: "" });
  });

  it("reports a cancelled run as cancelled rather than as a probe that saw nothing", async () => {
    const controller = new AbortController();
    const { runner } = available(report());
    controller.abort();
    const outcome = await runner.probe(
      {
        url: "ws://127.0.0.1:9000/echo",
        send: [],
        maxFrames: 1,
        maxFrameBytes: 64,
        idleTimeoutMs: 10,
        totalTimeoutMs: 20,
      },
      controller.signal,
    );
    expect(outcome).toEqual({ kind: "cancelled" });
  });

  it("does not run a probe at all when the stack is not available", async () => {
    const calls: RunProcessOptions[] = [];
    const runner = new NativeProbeRunner({
      env: { UVP_NATIVE_PROBE: join(tmpdir(), "uvp-no-such-probe-9d1e77") },
      runProcess: async (options) => {
        calls.push(options);
        return { ...BASE, command: options.command };
      },
    });

    const outcome = await runner.probe(
      {
        url: "ws://127.0.0.1:9000/echo",
        send: [],
        maxFrames: 1,
        maxFrameBytes: 64,
        idleTimeoutMs: 10,
        totalTimeoutMs: 20,
      },
      SIGNAL,
    );
    expect(outcome.kind).toBe("stack-unavailable");
    expect(calls).toHaveLength(0);
  });
});
