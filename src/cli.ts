import { UNIVERSAL_FLAGS, parseArgv } from "./cli/args.js";
import type { ParsedArgv } from "./cli/args.js";
import { isToolCommand, resolveCommand } from "./cli/commandSpec.js";
import type { CommandSpec, ToolCommand } from "./cli/commandSpec.js";
import { COMMANDS } from "./cli/commands/index.js";
import { EXIT_NO, EXIT_OK, EXIT_WRONG, exitCodeForError } from "./cli/exitCodes.js";
import { commandHelp, globalHelp } from "./cli/help.js";
import { emitFailure, emitResult, processStreams } from "./cli/output.js";
import type { OutputStreams } from "./cli/output.js";
import { createToolHandlers, handlerFor } from "./composition/toolHandlers.js";
import { createUvpServices } from "./composition/uvpServices.js";
import type { UvpServices } from "./composition/uvpServices.js";
import { UvpFailure, toUvpError } from "./domain/errors.js";
import type { StopResult } from "./application/WorkspaceService.js";
import { describeStop } from "./toolchains/local/processRunner.js";

/**
 * The CLI entry point.
 *
 * `runCli` takes words and returns an exit code. It never calls `process.exit`,
 * reads `process.argv`, or writes to a stream it was not handed — which is what
 * lets the whole CLI be tested by calling it, and is why `scripts/uvp.mjs` can be
 * nine lines.
 *
 * Both adapters go through the same dispatch table. `uvp build` and the
 * `uvp_build` MCP tool reach the identical handler with the identical parsed
 * input, so a difference between them is a bug in one of the two front ends and
 * never a difference in behaviour.
 *
 * Reading the words is inside the `try` along with everything else. A flag error
 * is the caller's mistake, and the error contract exists to report exactly that;
 * raised outside this block it would escape to the process-level trap and reach
 * the caller as a stack trace, which says "uvp is broken" about a misspelled
 * flag.
 */

/**
 * Whether the caller asked for JSON, read from the raw words.
 *
 * Read before parsing, because every failure has to be rendered in the form the
 * caller asked for and a failure raised *by* the parse cannot report the values
 * it did not finish reading. The spellings come from `UNIVERSAL_FLAGS`, so this
 * cannot drift from the flag table it stands in for.
 *
 * `--` is where it stops: after that every word is a positional, so a `--json`
 * there is an argument and not the flag.
 */
const JSON_SPELLINGS: ReadonlySet<string> = new Set(
  UNIVERSAL_FLAGS.filter((flag) => flag.name === "json").flatMap((flag) => [
    `--${flag.name}`,
    ...(flag.alias ?? []).map((alias) => `--${alias}`),
  ]),
);

const jsonRequested = (argv: readonly string[]): boolean => {
  for (const token of argv) {
    if (token === "--") return false;
    if (JSON_SPELLINGS.has(token)) return true;
  }
  return false;
};

const unknownCommand = (words: readonly string[]): UvpFailure =>
  new UvpFailure({
    code: "invalid_request",
    message: `No command named "${words.join(" ")}".`,
    remediation: { action: "Run `uvp --help` for the list of commands." },
    details: { command: words.join(" ") },
  });

const missingCommand = (): UvpFailure =>
  new UvpFailure({
    code: "invalid_request",
    message: "No command was given.",
    remediation: { action: "Run `uvp --help` for the list of commands." },
    details: { usage: "uvp COMMAND [ARGS] [--json]" },
  });

export interface CliOptions {
  /** Services to reuse instead of building a fresh graph. */
  readonly services?: UvpServices | undefined;
  /** Streams to write to instead of this process's. */
  readonly streams?: OutputStreams | undefined;
  /** Commands to consider instead of the built-in set. */
  readonly commands?: readonly CommandSpec[] | undefined;
  /** Working directory reported in errors; the CLI itself does not change it. */
  readonly cwd?: string | undefined;
}

export const runCli = async (
  argv: readonly string[],
  options: CliOptions = {},
): Promise<number> => {
  const streams = options.streams ?? processStreams();
  const commands = options.commands ?? COMMANDS;
  const json = jsonRequested(argv);
  const { pre, words, spec, rest, unmatched } = splitCommand(argv, commands);

  try {
    if (spec === undefined) {
      // Nothing to dispatch to. `--help` asked a question and gets an answer, with
      // or without a command after it. Anything else gets the failure contract:
      // "no command" and "no such command" are the caller's mistake, not results.
      const global = parseArgv(pre, []);
      if (global.help) {
        streams.out(globalHelp());
        return EXIT_OK;
      }
      const typed = unmatched === undefined ? words : [...words, unmatched];
      if (typed.length > 0) throw unknownCommand(typed);
      // Under `--json` there is no result to print, and stdout is reserved for
      // results: a caller piping into a parser must never receive prose. A person
      // who typed `uvp` alone does want the command list, so it goes to stdout —
      // it is the answer to what they asked — with the code that says they did
      // not finish asking.
      if (json) throw missingCommand();
      streams.out(globalHelp());
      return EXIT_WRONG;
    }

    const parsed = parseArgv([...pre, ...rest], spec.flags ?? []);

    if (parsed.help) {
      streams.out(commandHelp(spec));
      return EXIT_OK;
    }

    if (!isToolCommand(spec)) {
      return await spec.run({
        parsed,
        out: streams.out,
        services: options.services ?? createUvpServices(),
      });
    }
    return await runToolCommand(spec, parsed, options, streams, json);
  } catch (error) {
    // Project first, render second. Rendering the raw throw would put a
    // `ZodError` on stderr with its own `name` and a JSON dump for a message,
    // which reads to a caller as "uvp is broken" rather than "your call was
    // malformed".
    const failure = toUvpError(error);
    emitFailure(streams, failure, json);
    return exitCodeForError(failure);
  }
};

const runToolCommand = async (
  spec: ToolCommand,
  parsed: ParsedArgv,
  options: CliOptions,
  streams: OutputStreams,
  json: boolean,
): Promise<number> => {
  const services = options.services ?? createUvpServices();
  const handlers = createToolHandlers(services);
  const input = spec.input(parsed);

  // A Ctrl-C during a build or a load test should abort the tool call rather than
  // leave it running while the process unwinds. The signal is per invocation and
  // is never aborted on the normal path, so a handler cannot observe a spurious
  // cancellation from an earlier command.
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);

  let output: Record<string, unknown>;
  try {
    output = await handlerFor(handlers, spec.tool)(input, { signal: controller.signal });
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }

  emitResult(streams, output, json);

  const failed = spec.inspect?.(output, parsed);
  if (failed !== undefined) {
    streams.err(`check failed: ${failed}`);
    return EXIT_NO;
  }

  // A command that leaves a service in the foreground is the one case where this
  // process is still alive *because* of something it started, so an interrupt has
  // to end that thing and not only this process.
  const held = spec.heldRun?.(output);
  if (held !== undefined) stopHeldRunOnInterrupt(held, services, streams);

  return spec.verdict?.(output, parsed) ?? EXIT_OK;
};

/**
 * How long a service is given to exit when the wait on it is interrupted.
 *
 * The three seconds `uvp stop` defaults to, and then force: an interrupt has to
 * give the caller their shell back, so a service that declines a SIGTERM is
 * killed rather than left holding the port.
 */
const INTERRUPT_GRACE_MS = 3_000;

/** The conventional code for "this process died of that signal". */
const INTERRUPT_CODES: readonly (readonly [NodeJS.Signals, number])[] = [
  ["SIGINT", 130],
  ["SIGTERM", 143],
];

/** One line saying what became of the run an interrupt went looking for. */
const stoppedLine = (runId: string, stopped: StopResult["stopped"]): string => {
  const entry = stopped.find((candidate) => candidate.runId === runId);
  if (entry === undefined) return `${runId} is not in this session's run registry`;
  // The wording of the three outcomes comes from `describeStop`, so an interrupt
  // that ended a run early and a `uvp stop` that reported the same outcome cannot
  // disagree about it.
  const how = describeStop({
    outcome: entry.outcome,
    code: entry.exitCode,
    signal: entry.signal,
  });
  return entry.outcome === "exited" ? `stopped ${runId} (${how})` : `${runId} ${how}`;
};

/**
 * Stop a foreground run when this process is interrupted.
 *
 * `uvp run --no-detach` prints its result and then waits, and what it waits on is
 * the service's open pipes. An interrupt therefore has to *end the service*, not
 * merely unwind this process: the service was started in its own process group,
 * so a terminal's Ctrl-C reaches this process and not the service, and the run
 * registry `uvp stop` reads dies with this process. Left alone, the interrupt
 * would leave a listener on the port that nothing could reach — while the result
 * that was just printed tells the caller to stop the run with `uvp_run_stop`.
 *
 * The stop goes through that same registry, so the service has one owner and not
 * two, and its outcome is reported rather than inferred from this process
 * ending: a cleanup that failed is a different fact from one that worked, and
 * only the report can tell them apart. The exit code is set rather than exited
 * on, so the line is written first; the pipes closing with the service then
 * drain the loop. A service that survives even a hard kill keeps this process
 * alive, and the handler is once-only: a second Ctrl-C ends it the default way.
 *
 * The handlers are installed for the life of the process, because a foreground
 * run's end is not an event this layer sees — the wait *is* the open pipes. That
 * is the right lifetime for the CLI, which exits when the service does; an
 * embedder that calls `runCli` repeatedly would keep one pair per foreground run
 * it did not interrupt, which is why the pair is removed the moment either fires.
 */
const stopHeldRunOnInterrupt = (
  runId: string,
  services: UvpServices,
  streams: OutputStreams,
): void => {
  // Both are removed when either fires: the answer to an interrupt is one stop
  // and one line, and a SIGTERM following a SIGINT would otherwise stop a run
  // that is already gone and say so a second time.
  const handlers: [NodeJS.Signals, () => void][] = INTERRUPT_CODES.map(([signal, code]) => [
    signal,
    () => {
      for (const [installed, handler] of handlers) process.off(installed, handler);
      process.exitCode = code;
      void services.workspace
        .stop({ runId, all: false, graceMs: INTERRUPT_GRACE_MS, force: true })
        .then((result) => streams.err(`interrupted: ${stoppedLine(runId, result.stopped)}`))
        .catch((cause: unknown) =>
          streams.err(
            `interrupted: ${runId} could not be stopped (${toUvpError(cause).message}); it may still be listening`,
          ),
        );
    },
  ]);
  for (const [signal, handler] of handlers) process.once(signal, handler);
};

/**
 * Split `argv` into the global flags that preceded the command, the command
 * itself, and that command's own arguments.
 *
 * Words are matched greedily against the command paths, so `uvp capture start`
 * selects the two-word command rather than a hypothetical one-word `capture`.
 * Flags before the command are collected rather than rejected, because
 * `uvp --json build ./svc` is a reasonable thing to type and refusing it would
 * be a rule with no purpose; flags after the command stop the search, because
 * from there on a word is a value.
 *
 * A word that extends no path is reported as `unmatched`. Which words it
 * belongs to is decided by whether a command resolved: in `uvp capture statr`
 * the search matched `capture` and stopped at `statr`, so the mistyped command
 * is the two together, while in `uvp build ./svc` the search matched a whole
 * command and stopped at an argument. Reporting only what matched would answer
 * "no command named capture", which is true of a prefix and useless to a reader.
 */
const splitCommand = (
  argv: readonly string[],
  commands: readonly CommandSpec[],
): {
  pre: readonly string[];
  words: readonly string[];
  spec: CommandSpec | undefined;
  rest: readonly string[];
  unmatched: string | undefined;
} => {
  const pre: string[] = [];
  const words: string[] = [];
  let unmatched: string | undefined;
  let index = 0;

  while (index < argv.length) {
    const token = argv[index] ?? "";
    if (looksLikeFlag(token)) {
      // A flag before any command word is a global one and is kept for the
      // command's own parse. A flag after one means the command is over.
      if (words.length > 0) break;
      pre.push(token);
      index += 1;
      continue;
    }
    if (!isPathPrefix(commands, [...words, token])) {
      if (resolveCommand(commands, words) === undefined) unmatched = token;
      break;
    }
    words.push(token);
    index += 1;
  }

  return { pre, words, spec: resolveCommand(commands, words), rest: argv.slice(index), unmatched };
};

const isPathPrefix = (commands: readonly CommandSpec[], words: readonly string[]): boolean =>
  commands.some(
    (command) =>
      command.path.length >= words.length &&
      words.every((word, index) => command.path[index] === word),
  );

const looksLikeFlag = (token: string): boolean => token.startsWith("-") && token !== "-";
