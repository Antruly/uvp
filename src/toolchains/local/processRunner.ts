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
  /**
   * Text to write to the child's stdin, which is then closed.
   *
   * A request handed to a child this way is not a command line: it has no length
   * limit, no quoting rules, and nothing of it appears in the process table. The
   * native probe takes its request on stdin for exactly those reasons — it is
   * JSON, and it may carry frame payloads.
   *
   * Without this the child's stdin is `/dev/null`, which is what every other
   * caller in this project wants: a build that reads stdin is waiting for input
   * nobody is going to give it.
   */
  readonly stdin?: string;
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
 * A path or value as a shell would have to be told it.
 *
 * Only when needed: quoting every value would make the common recorded line
 * harder to read than the command it describes, and quoting none of them would
 * break on the first prefix that has a space in it — which is a path someone
 * has. Single quotes are used because nothing inside them is special to a POSIX
 * shell; a value that contains one is closed, escaped, and reopened.
 */
const shellQuote = (value: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/u.test(value) ? value : `'${value.replaceAll("'", String.raw`'\''`)}'`;

/**
 * The command as a line a caller can re-run, environment included.
 *
 * The environment is part of the command when one was set, and it is not
 * decoration. A build points CMake at the libuvcpp install uvp discovered, and
 * that travels in `CMAKE_PREFIX_PATH` and `PKG_CONFIG_PATH` — so a recorded line
 * without them re-runs against whatever the caller's shell happens to hold and
 * reports a missing library for a build that failed on something else entirely.
 * The variables recorded are the ones this call set, which is the difference
 * between what the caller had and what the child got; the rest of the
 * environment was inherited and is not restated here.
 */
const renderCommand = (options: RunProcessOptions): string => {
  const line = [options.command, ...options.args].join(" ");
  const environment = Object.entries(options.env ?? {}).sort(([left], [right]) =>
    left < right ? -1 : 1,
  );
  if (environment.length === 0) return line;
  const assignments = environment.map(([name, value]) => `${name}=${shellQuote(value)}`).join(" ");
  return `env ${assignments} ${line}`;
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
    stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  if (options.stdin !== undefined) {
    // A child that exits before reading its request closes the pipe under us, and
    // a write error with no listener is an unhandled event that takes this
    // process down. The child's exit is still reported: what it refused is on its
    // stderr, which is the answer, and the writing side is not.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.stdin);
  }

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
    command: renderCommand(options),
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
  /**
   * Resolves once the kernel has accepted the spawn; rejects when it has not.
   *
   * `spawn` is asynchronous about failure: a binary that does not exist, or is
   * not executable, produces an `error` event on a later turn of the loop rather
   * than a throw. Until one of the two events has arrived the honest answer to
   * "did this start?" is *not known yet*, and every other answer is a claim about
   * a process that may never have existed. So a caller that reports anything
   * about the launch waits for this first.
   */
  whenStarted(): Promise<void>;
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

  // Held in a mutable record rather than a bare `let`: the handlers run in nested
  // closures, and a bare `let` would be flow-narrowed to `undefined` at every read
  // inside `stop()`.
  const lifecycle: {
    exited: { code: number | null; signal: string | null } | undefined;
    startError: Error | undefined;
  } = { exited: undefined, startError: undefined };

  const started = new Promise<void>((resolve, reject) => {
    // `spawn` means the kernel accepted the child; `error` means it did not.
    // Exactly one of them arrives, which is what makes this settle.
    child.once("spawn", () => resolve());
    child.once("error", (cause: Error) => {
      lifecycle.startError = cause;
      reject(cause);
    });
  });
  // Not every caller waits — one that only polls `isRunning()` never does — and an
  // unobserved rejection would take the host process with it. The derived promise
  // marks the rejection handled without swallowing it for a caller that awaits.
  started.catch(() => undefined);

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
    command: renderCommand(options),
    whenStarted: () => started,
    // A process that never started is not running, whatever the child handle's
    // `exitCode` still says.
    isRunning: () =>
      lifecycle.startError === undefined &&
      lifecycle.exited === undefined &&
      child.exitCode === null,
    exitInfo: () => lifecycle.exited,
    stdoutTail: () => tails.stdout,
    stderrTail: () => tails.stderr,
    stop: async (graceMs, force) => {
      // A process that never started has nothing to signal, and `killed: true` for
      // it would be the same false claim as reporting it as running.
      if (lifecycle.startError !== undefined) return { outcome: "already_gone", killed: false };
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
