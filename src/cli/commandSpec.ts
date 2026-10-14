import type { UvpServices } from "../composition/uvpServices.js";
import type { FlagSpec, ParsedArgv } from "./args.js";

/**
 * One CLI command.
 *
 * A command is a *lowering*: words to a structured input, and a result to an exit
 * code. It does no work of its own. Every command names the tool contract it
 * drives, and the input object it produces is parsed by that contract — so the
 * CLI can accept a friendlier spelling (`--port 8080` for `run.ready.port`)
 * without ever being a second opinion about what a valid request is.
 *
 * `verdict` is the other half of that. The conventions differ per tool: a failing
 * build is exit 1, a doctor report with a missing prerequisite is exit 1, a
 * successful HTTP call returning 404 is exit 0 — 404 is the answer, not a
 * failure. That judgement cannot be derived from the output schema, so each
 * command states it, in one place, next to the flags that produced it.
 */

export interface PositionalSpec {
  readonly name: string;
  readonly description: string;
}

interface CommandShape {
  /** The words that select this command, e.g. `["capture", "start"]`. */
  readonly path: readonly string[];
  readonly summary: string;
  /** The usage line, shown by `--help`. */
  readonly usage: string;
  readonly positionals?: readonly PositionalSpec[] | undefined;
  readonly flags?: readonly FlagSpec[] | undefined;
  /** Extra prose for `--help`: conventions a reader would otherwise have to guess. */
  readonly notes?: readonly string[] | undefined;
}

/** A command that drives a tool contract. */
export interface ToolCommand extends CommandShape {
  /** The tool contract this command drives. */
  readonly tool: string;
  /** Build the contract input. Only flags that were supplied are present. */
  readonly input: (parsed: ParsedArgv) => Record<string, unknown>;
  /**
   * The exit code this result earns, when it is not 0.
   *
   * Returning `undefined` means success. Read the output, not the input: a
   * `uvp_build` call whose input was fine still exits 1 when the compiler said no.
   * The parsed arguments are passed too, because some verdicts depend on what was
   * asked for — `uvp run --port 8080` that never became ready is a "no", while a
   * `uvp run` with no probe was never asked the question.
   */
  readonly verdict?:
    | ((output: Record<string, unknown>, parsed: ParsedArgv) => number | undefined)
    | undefined;
  /**
   * A check the CLI performs on the result, after the tool has returned.
   *
   * This exists for `uvp ws --expect-frame`, which is an assertion about the
   * frames that came back rather than an input to the probe. It returns a message
   * when the check failed; the result is printed either way, because hiding the
   * observed frames behind a failed expectation would leave the caller with a
   * verdict and no evidence.
   */
  readonly inspect?:
    | ((output: Record<string, unknown>, parsed: ParsedArgv) => string | undefined)
    | undefined;
}

/**
 * A command that is not a tool call.
 *
 * `uvp mcp` and `uvp setup` are the only two, and they are here rather than in a
 * special case in the runner because their *shape* is the same as every other
 * command's: words in, an exit code out, and a help text that has to be reachable
 * before anything runs. What differs is that there is no contract to lower onto —
 * one is a transport, the other writes a file a client reads.
 *
 * They are deliberately not given tool contracts of their own. A contract exists
 * so a model can call it; a model cannot usefully call "start the server it is
 * already talking to".
 */
export interface LocalCommand extends CommandShape {
  readonly tool?: undefined;
  readonly run: (context: LocalRunContext) => Promise<number>;
}

export interface LocalRunContext {
  readonly parsed: ParsedArgv;
  /** Writes a line to stdout. For these commands, stdout is the deliverable. */
  readonly out: (text: string) => void;
  readonly services: UvpServices;
}

export type CommandSpec = ToolCommand | LocalCommand;

/** Narrows to the tool-driven commands, so `spec.tool` is readable. */
export const isToolCommand = (spec: CommandSpec): spec is ToolCommand => spec.tool !== undefined;

/** `uvp capture start` → `capture start`, for error messages and help. */
export const commandName = (spec: CommandSpec): string => `uvp ${spec.path.join(" ")}`;

/** Resolve the command a set of words selects, longest path first. */
export const resolveCommand = (
  specs: readonly CommandSpec[],
  words: readonly string[],
): CommandSpec | undefined => {
  const ordered = [...specs].sort((a, b) => b.path.length - a.path.length);
  return ordered.find((spec) => spec.path.every((word, index) => words[index] === word));
};
