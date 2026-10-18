/**
 * The port for running a command to completion.
 *
 * The frontend build is the first workflow in `application/` that runs a tool
 * other than the compiler, and it needs the same three answers every caller
 * needs: did it start, what did it exit with, and what did it say. That is
 * exactly what the toolchain layer's `runProcess` already returns, so this is a
 * port shaped to it rather than a second implementation.
 *
 * The distinction that matters is preserved: a command that exits non-zero is
 * an outcome, and a command that could not be started at all is a rejection.
 * The frontend build turns the first into a reported step and the second into a
 * missing prerequisite, and it could not tell the two apart if this port
 * flattened them.
 */
export interface CommandRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly maxOutputBytes?: number;
  /**
   * Route the invocation through the platform shell.
   *
   * Needed on Windows, where `npm` is `npm.cmd` and a bare spawn of a `.cmd`
   * file cannot be executed. Every caller that sets it passes a fixed command
   * name and fixed arguments, so nothing from a caller's input reaches the
   * command line.
   */
  readonly shell?: boolean;
}

export interface CommandOutcome {
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
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

/**
 * Starts a command and waits for it.
 *
 * A rejection means the process never started (a missing executable, a
 * permission the host refused); it never means a non-zero exit.
 */
export type CommandRunner = (request: CommandRequest) => Promise<CommandOutcome>;
