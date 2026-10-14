import { spawn } from "node:child_process";

/**
 * Subprocess supervision, in one place.
 *
 * REA keeps its process handling in a single module for a reason that applies
 * here too: every caller otherwise reinvents timeout handling, and the
 * reinvented versions disagree about whether a timeout is an exit code, a
 * signal, or a throw. uvp needs one answer, because a build that timed out must
 * be distinguishable from a build that failed.
 */
export interface ProcessOutcome {
  readonly command: string;
  readonly exitCode: number | null;
  /** Set when the process died from a signal rather than exiting. */
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  /** True when captured output stopped growing because the cap was reached. */
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface RunProcessOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly maxOutputBytes?: number;
  /** Replace the child's environment entirely rather than extending it. */
  readonly replaceEnv?: boolean;
}

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

interface Captured {
  text: string;
  bytes: number;
  truncated: boolean;
}

/** Accumulate chunks up to a byte cap, then stop growing but keep counting. */
const createCapture = (maxBytes: number) => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let retained = 0;
  let truncated = false;
  return {
    push(chunk: Buffer): void {
      bytes += chunk.byteLength;
      if (retained >= maxBytes) {
        truncated = true;
        return;
      }
      const room = maxBytes - retained;
      if (chunk.byteLength <= room) {
        chunks.push(chunk);
        retained += chunk.byteLength;
        return;
      }
      chunks.push(chunk.subarray(0, room));
      retained += room;
      truncated = true;
    },
    finish(): Captured {
      return { text: Buffer.concat(chunks).toString("utf8"), bytes, truncated };
    },
  };
};

/**
 * Run a command to completion.
 *
 * Never rejects for a non-zero exit: the caller asked for the outcome, and an
 * exit code is an outcome. It rejects only when the process could not be
 * started at all, which is a different kind of fact.
 */
export const runProcess = async (options: RunProcessOptions): Promise<ProcessOutcome> => {
  const started = Date.now();
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const outCapture = createCapture(maxOutputBytes);
  const errCapture = createCapture(maxOutputBytes);

  const child = spawn(options.command, [...options.args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined
      ? {}
      : {
          env:
            options.replaceEnv === true ? { ...options.env } : { ...process.env, ...options.env },
        }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let timedOut = false;
  let aborted = false;

  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs);

  const onAbort = (): void => {
    aborted = true;
    child.kill("SIGKILL");
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  child.stdout?.on("data", (chunk: Buffer) => outCapture.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => errCapture.push(chunk));

  const { exitCode, signal } = await new Promise<{
    exitCode: number | null;
    signal: string | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, closeSignal) => resolve({ exitCode: code, signal: closeSignal }));
  }).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  });

  const out = outCapture.finish();
  const err = errCapture.finish();

  return {
    command: [options.command, ...options.args].join(" "),
    exitCode,
    signal,
    timedOut,
    aborted,
    durationMs: Date.now() - started,
    stdout: out.text,
    stderr: err.text,
    stdoutBytes: out.bytes,
    stderrBytes: err.bytes,
    stdoutTruncated: out.truncated,
    stderrTruncated: err.truncated,
  };
};

/**
 * Supervise a long-lived process.
 *
 * A supervised process outlives the call that started it, so it reports its own
 * liveness and exit rather than being awaited. Buffered output is bounded for
 * the same reason a build's is: a chatty server must not grow without limit.
 */
export interface SupervisedProcess {
  readonly pid: number | undefined;
  readonly command: string;
  isRunning(): boolean;
  exitInfo(): { code: number | null; signal: string | null } | undefined;
  stdoutTail(): string;
  stderrTail(): string;
  stop(graceMs: number, force: boolean): Promise<StopOutcome>;
  /**
   * Let the host process exit while the service keeps running.
   *
   * A detached child is started in its own process group so it survives, but its
   * stdout and stderr pipes are still open handles in the parent, and an open
   * pipe holds the parent's event loop alive. Without this, `uvp run` prints its
   * result and then hangs — the process never exits, and the reason is invisible
   * from the output.
   *
   * After `release()` the process is no longer observed: its output tail stops
   * growing and `isRunning()` stops being updated, because nothing is left to
   * receive the exit event. That is the honest meaning of "detached", and the
   * caller is responsible for saying so in the result.
   */
  release(): void;
}

export interface StopOutcome {
  readonly outcome: "exited" | "already_gone" | "unresponsive";
  readonly code?: number;
  readonly signal?: string;
  readonly killed: boolean;
}

export interface StartSupervisedOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly maxTailBytes?: number;
}

const DEFAULT_TAIL_BYTES = 64 * 1024;

export const startSupervised = (options: StartSupervisedOptions): SupervisedProcess => {
  const maxTail = options.maxTailBytes ?? DEFAULT_TAIL_BYTES;
  const child = spawn(options.command, [...options.args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });

  const tails = { stdout: "", stderr: "" };
  const append = (which: "stdout" | "stderr", chunk: Buffer): void => {
    const combined = tails[which] + chunk.toString("utf8");
    tails[which] = combined.length > maxTail ? combined.slice(combined.length - maxTail) : combined;
  };
  child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
  // A supervised service that dies must not take the host process with it.
  child.on("error", () => undefined);

  // Held in a mutable record rather than a bare `let`: the exit handler runs in
  // a nested closure, and a bare `let` would be flow-narrowed to `undefined` at
  // every read inside `stop()`.
  const lifecycle: { exited: { code: number | null; signal: string | null } | undefined } = {
    exited: undefined,
  };
  child.once("exit", (code, signal) => {
    lifecycle.exited = { code, signal };
  });

  /** Poll until the process is gone or the deadline passes. */
  const waitForExit = async (deadline: number): Promise<void> => {
    while (Date.now() < deadline && lifecycle.exited === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  /** Present however the process left, if it has. */
  const outcomeOf = (killed: boolean): StopOutcome => {
    const exited = lifecycle.exited;
    if (exited === undefined) return { outcome: "unresponsive", killed };
    return {
      outcome: killed ? "exited" : "already_gone",
      ...(exited.code === null ? {} : { code: exited.code }),
      ...(exited.signal === null ? {} : { signal: exited.signal }),
      killed,
    };
  };

  return {
    pid: child.pid,
    command: [options.command, ...options.args].join(" "),
    isRunning: () => lifecycle.exited === undefined && child.exitCode === null,
    exitInfo: () => lifecycle.exited,
    stdoutTail: () => tails.stdout,
    stderrTail: () => tails.stderr,
    stop: async (graceMs, force) => {
      if (lifecycle.exited !== undefined) return outcomeOf(false);
      child.kill("SIGTERM");
      await waitForExit(Date.now() + graceMs);
      if (lifecycle.exited !== undefined) return outcomeOf(true);
      if (!force) return { outcome: "unresponsive", killed: false };
      child.kill("SIGKILL");
      await waitForExit(Date.now() + 2_000);
      return outcomeOf(true);
    },
    release: () => {
      // Order matters only in that both must happen: `unref` releases the child
      // handle, and the pipe readers are separate handles that outlive it.
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    },
  };
};
