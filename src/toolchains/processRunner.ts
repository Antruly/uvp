import { spawn } from "node:child_process";

import type {
  ProcessSupervisor,
  StartSupervisedOptions,
  StopOutcome,
  SupervisedProcess,
} from "../application/ProcessSupervisor.js";

/**
 * Subprocess supervision, in one place.
 *
 * REA keeps its process handling in a single module for a reason that applies
 * here too: every caller otherwise reinvents timeout handling, and the
 * reinvented versions disagree about whether a timeout is an exit code, a
 * signal, or a throw. uvp needs one answer, because a build that timed out must
 * be distinguishable from a build that failed.
 *
 * ## Why this is at the `toolchains/` root rather than under `local/`
 *
 * It was under `local/` until a second provider needed it. `native/` already
 * imported `runProcess` from `../local/processRunner`, so the "local" in that
 * path was already a lie: the file is how this host starts a process at all, and
 * every provider that runs a compiler, a probe, or a service needs exactly it.
 * Left where it was, each new provider would import the local provider to get a
 * generic capability, and the third one would be tempted to copy it instead.
 *
 * Nothing here is `local`-specific, which is the test for the location: no paths
 * of its own, no command lookup of its own (it hands a command to `spawn` and
 * lets that resolve it), and no assumption about what the child is.
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
 *
 * One consequence is worth stating because it looks like an inconsistency: on
 * Windows the executable is quoted in every recorded line, since `C:\…\node.exe`
 * holds backslashes and a backslash is an escape in the notation the line is
 * written in. That is the rule working, not a special case for Windows.
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
 *
 * Every word goes through `shellQuote`, the command and its arguments as well as
 * the values. Quoting only the environment was half the rule: `cmake -S /tmp/uvp
 * probe/ws` is four arguments to a reader and two to uvp, so the line was not
 * re-runnable for a workspace whose path has a space — the case the quoting was
 * there for. An argument that is empty is written `''` for the same reason: the
 * line has to name the invocation the caller asked for, and a word that vanished
 * into a separator does not.
 *
 * **What this line is.** It is `env NAME=value …` — POSIX notation — on every
 * host, including Windows, where no shell a person has would run it. That is
 * stated rather than fixed: there is no single Windows notation (`cmd.exe` and
 * PowerShell disagree about `set`, and neither is necessarily the shell that
 * reads the record), and what the field owes a caller is the command, its
 * arguments and the environment uvp set, which is what it holds. A caller on a
 * host this line is not written for reads it as the description it is. #20
 * records the alternative — the record as data — and why it was not taken.
 */
const renderCommand = (options: RunProcessOptions): string => {
  const line = [options.command, ...options.args].map(shellQuote).join(" ");
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

  // A signal that was already aborted is honoured *before* the spawn, because
  // the listener below cannot fire for an abort that has already happened. Left
  // to the listener alone, a caller who withdrew before the call would still
  // get a process started on their behalf and awaited to completion, and the
  // outcome would say a build happened — the one thing the caller had just
  // decided not to wait for.
  if (options.signal?.aborted === true) {
    return {
      command: renderCommand(options),
      exitCode: null,
      signal: null,
      timedOut: false,
      aborted: true,
      durationMs: Date.now() - started,
      stdout: "",
      stderr: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  }

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

const DEFAULT_TAIL_BYTES = 64 * 1024;

/**
 * A launch this host refused before there was a process to supervise.
 *
 * `spawn` reports most exec failures on a later turn of the loop — which is the
 * shape the port's `whenStarted()` is written for — but not all of them. Node
 * forwards `EACCES`, `EAGAIN`, `EMFILE`, `ENFILE` and `ENOENT` to the `error`
 * event and **throws** `new ErrnoException(err, "spawn")` for every other errno.
 * `ETXTBSY` is on the throw side: the kernel refuses to `execve` a file some
 * process holds open for writing, and the message is `spawn ETXTBSY` with no path
 * in it. Measured on this host with Node v24.21.0 rather than read from the
 * documentation — a handle held open on the target (`open(path, "w")` from
 * another process, `openSync(path, "r+")` in this one) makes `spawn` throw and
 * `child.on("error")` never fire, and closing the handle makes the next spawn
 * succeed.
 *
 * Left unhandled, that throw happens where `startSupervised` has not returned a
 * handle yet, so it bypasses the port entirely: it reached CI as a bare `Error`
 * out of `WorkspaceService.run` — no code, no category, no remedy, and no path,
 * because the message names the errno and not the file. The port promises the
 * launch outcome through `whenStarted()`, so a throw becomes the same rejection
 * the `error` event feeds, and the caller's refusal is typed like any other.
 */
const refusedLaunch = (options: StartSupervisedOptions, cause: unknown): SupervisedProcess => {
  const failure = cause instanceof Error ? cause : new Error(String(cause));
  // The same reason `started` below marks its rejection handled: a caller that
  // only polls `isRunning()` never observes this one, and an unobserved rejection
  // would take the host process with it.
  const refused = Promise.reject(failure);
  refused.catch(() => undefined);
  return {
    pid: undefined,
    command: renderCommand(options),
    whenStarted: () => refused,
    // Nothing was started, so there is nothing running to report, nothing to
    // signal, and no output that a process could have written.
    isRunning: () => false,
    exitInfo: () => undefined,
    stdoutTail: () => "",
    stderrTail: () => "",
    stop: async () => ({ outcome: "already_gone", killed: false }),
    release: () => undefined,
  };
};

/**
 * The local host's implementation of the supervision port.
 *
 * Annotated with the port type rather than with its own signature so that the
 * conformance is checked by the compiler at the definition: if the port grows a
 * clause, this is where the build says so, instead of at whichever caller
 * happened to be compiled first. `supervise` in `composition` is the one place
 * that decides this is the implementation in use.
 */
export const startSupervised: ProcessSupervisor = (options) => {
  const maxTail = Math.max(0, Math.floor(options.maxTailBytes ?? DEFAULT_TAIL_BYTES));
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(options.command, [...options.args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
  } catch (cause) {
    // The errnos Node throws for rather than emitting — see `refusedLaunch`.
    return refusedLaunch(options, cause);
  }

  /**
   * The newest output, held as bytes until someone asks for text.
   *
   * A pipe chunk boundary is a byte offset, not a character boundary, and the cap
   * is named in bytes. Keeping a decoded string would get both wrong: decoding
   * each chunk on its own turns a character that straddles a chunk into
   * replacement characters, and `string.length` counts UTF-16 code units, so a
   * 65,536-byte cap retained three times that for three-byte text. The tail is
   * therefore a list of buffers trimmed by byte count and decoded once on read.
   */
  const tails: Record<"stdout" | "stderr", { chunks: Buffer[]; bytes: number }> = {
    stdout: { chunks: [], bytes: 0 },
    stderr: { chunks: [], bytes: 0 },
  };
  const append = (which: "stdout" | "stderr", chunk: Buffer): void => {
    const tail = tails[which];
    tail.chunks.push(chunk);
    tail.bytes += chunk.byteLength;
    while (tail.bytes > maxTail) {
      const oldest = tail.chunks[0];
      if (oldest === undefined) break;
      const excess = tail.bytes - maxTail;
      if (oldest.byteLength <= excess) {
        tail.chunks.shift();
        tail.bytes -= oldest.byteLength;
      } else {
        // Keep the rest of this chunk: the cap can land inside a character, and
        // the decoder skips the partial one on read rather than dropping the
        // whole chunk and losing output that belongs in the tail.
        tail.chunks[0] = oldest.subarray(excess);
        tail.bytes -= excess;
      }
    }
  };
  /**
   * The tail as text, starting at a character boundary.
   *
   * A leading byte with the `10` prefix is a UTF-8 continuation, which means the
   * byte cap landed inside a character; skip those bytes to the next start byte.
   * Only the start can be partial: the end of the tail is the newest data, so
   * every character the child wrote is complete there.
   */
  const tailTextOf = (which: "stdout" | "stderr"): string => {
    const tail = tails[which];
    if (tail.bytes === 0) return "";
    const buffer = Buffer.concat(tail.chunks, tail.bytes);
    let start = 0;
    while (start < buffer.length) {
      const byte = buffer[start];
      if (byte === undefined || (byte & 0xc0) !== 0x80) break;
      start += 1;
    }
    return buffer.subarray(start).toString("utf8");
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
    stdoutTail: () => tailTextOf("stdout"),
    stderrTail: () => tailTextOf("stderr"),
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
