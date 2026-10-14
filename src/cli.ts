import { parseArgv } from "./cli/args.js";
import type { ParsedArgv } from "./cli/args.js";
import { isToolCommand, resolveCommand } from "./cli/commandSpec.js";
import type { CommandSpec, ToolCommand } from "./cli/commandSpec.js";
import { COMMANDS } from "./cli/commands/index.js";
import { EXIT_NO, EXIT_OK, EXIT_WRONG, exitCodeForError } from "./cli/exitCodes.js";
import { commandHelp, globalHelp, unknownCommandHelp } from "./cli/help.js";
import { emitFailure, emitResult, processStreams } from "./cli/output.js";
import type { OutputStreams } from "./cli/output.js";
import { createToolHandlers, handlerFor } from "./composition/toolHandlers.js";
import { createUvpServices } from "./composition/uvpServices.js";
import type { UvpServices } from "./composition/uvpServices.js";
import { toUvpError } from "./domain/errors.js";

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
 */

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
  const { pre, words, spec, rest } = splitCommand(argv, commands);

  if (spec === undefined) {
    // `uvp --help` asked a question and gets an answer; bare `uvp` asked nothing,
    // so it gets the same text but the "you did not say what you wanted" code.
    // Both go to stdout — the help is the result here, not a diagnostic.
    if (words.length === 0) {
      streams.out(globalHelp());
      return pre.length === 0 ? EXIT_WRONG : EXIT_OK;
    }
    streams.err(unknownCommandHelp(words));
    return EXIT_WRONG;
  }

  const parsed = parseArgv([...pre, ...rest], spec.flags ?? []);
  const json = parsed.values["json"] === true;

  if (parsed.help) {
    streams.out(commandHelp(spec));
    return EXIT_OK;
  }

  try {
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
  return spec.verdict?.(output, parsed) ?? EXIT_OK;
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
 */
const splitCommand = (
  argv: readonly string[],
  commands: readonly CommandSpec[],
): {
  pre: readonly string[];
  words: readonly string[];
  spec: CommandSpec | undefined;
  rest: readonly string[];
} => {
  const pre: string[] = [];
  const words: string[] = [];
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
    if (!isPathPrefix(commands, [...words, token])) break;
    words.push(token);
    index += 1;
  }

  return { pre, words, spec: resolveCommand(commands, words), rest: argv.slice(index) };
};

const isPathPrefix = (commands: readonly CommandSpec[], words: readonly string[]): boolean =>
  commands.some(
    (command) =>
      command.path.length >= words.length &&
      words.every((word, index) => command.path[index] === word),
  );

const looksLikeFlag = (token: string): boolean => token.startsWith("-") && token !== "-";
