/**
 * The supervision port: what `application` needs from whoever starts processes.
 *
 * `application` used to import these from `toolchains/local/processRunner`, which
 * is the one place in the tree where the dependency direction was inverted — a
 * workflow reaching down into a provider. It went unnoticed because nothing
 * enforced the rule above `contracts`, and it would have kept going unnoticed
 * while `local/` was the only provider. With a second one it stops being a
 * stylistic point: `WorkspaceService` starting a service by calling the local
 * provider's spawner is a workflow that cannot run a service anywhere else, no
 * matter what the toolchain port promises.
 *
 * So the *shape* lives here, in the layer that needs it, and the implementation
 * stays below it in `toolchains/`. What moves is small — a type, an options bag,
 * the three stop outcomes, and the one function that puts an outcome into words.
 * `runProcess` and `startSupervised` stay out of `application`: they are Node's
 * `spawn`, which is a host detail rather than a workflow one. They have since
 * moved within `toolchains/` — see `toolchains/processRunner.ts` for why they are
 * no longer filed under `local/`.
 *
 * ## Why `describeStop` is here rather than in a caller
 *
 * The three outcomes are one judgement already made in one place: `stop` decided
 * which of them happened. Every caller that puts it into words — the CLI's
 * interrupt line, a cancellation that ends a run early — must say the same thing
 * about the same outcome, and `unresponsive` in particular is not `exited`: "it
 * did not exit and may still be listening" is the difference between a cleanup
 * that worked and a port still held. Nothing else in a result carries that, so a
 * second wording would be a second answer to whether cleanup finished.
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

/**
 * One clause for how a stopped process ended, from `stop`'s three outcomes.
 */
export const describeStop = (outcome: {
  readonly outcome: StopOutcome["outcome"];
  readonly code?: number | undefined;
  readonly signal?: string | undefined;
}): string => {
  if (outcome.outcome === "already_gone") return "had already exited";
  if (outcome.outcome === "unresponsive") return "did not exit and may still be listening";
  return outcome.signal === undefined
    ? `exit code ${String(outcome.code)}`
    : `killed by ${outcome.signal}`;
};

/**
 * Start a long-lived process, under whatever supervision the host provides.
 *
 * A function rather than an object with one method, matching `HeaderProbe` in
 * `ToolchainProvider.ts`: a port that a caller only ever calls does not need a
 * name to be called through, and an interface with a single method that always
 * has one implementation is a class pretending to be a seam.
 *
 * A supervised process outlives the call that started it, so it reports its own
 * liveness and exit rather than being awaited. Buffered output is bounded for the
 * same reason a build's is: a chatty server must not grow without limit.
 */
export type ProcessSupervisor = (options: StartSupervisedOptions) => SupervisedProcess;
