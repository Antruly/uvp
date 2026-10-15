import { PACKAGE_DESCRIPTION, PACKAGE_VERSION } from "../generatedPackageMetadata.js";
import { UNIVERSAL_FLAGS, VERSION_FLAG } from "./args.js";
import type { CommandSpec } from "./commandSpec.js";
import { commandName } from "./commandSpec.js";
import { COMMANDS } from "./commands/index.js";
import { commandList } from "./format.js";

/**
 * `--help`.
 *
 * Help is written by the same rules as a result: what the command does, what it
 * accepts, and the conventions a reader would otherwise have to discover by
 * running it. The notes are the part that earns its space — an exit-code table on
 * `uvp verify` and a warning about the response body on `uvp http` are worth more
 * than another flag description.
 */
export const globalHelp = (): string => {
  const lines = [
    `uvp ${PACKAGE_VERSION} — ${PACKAGE_DESCRIPTION}`,
    "",
    "Usage: uvp COMMAND [ARGS] [--json]",
    "",
    "Commands:",
    ...commandList(COMMANDS.map((command) => [commandName(command), command.summary])),
    "",
    "Flags:",
    // `--version` is listed here and nowhere else: it is answered before a
    // command word, so a command's own help would be claiming a spelling it does
    // not own. `uvp soap --help` is where that one is described.
    ...flagLines([...UNIVERSAL_FLAGS, VERSION_FLAG]),
    "",
    "Exit codes: 0 success; 1 the operation ran and the answer is no; 2 the input",
    "or the environment was wrong. Run `uvp COMMAND --help` for one command.",
  ];
  return lines.join("\n");
};

export const commandHelp = (spec: CommandSpec): string => {
  const lines = [spec.summary, "", "Usage:", `  ${spec.usage}`];

  if (spec.positionals !== undefined && spec.positionals.length > 0) {
    lines.push("", "Arguments:");
    for (const positional of spec.positionals) {
      lines.push(`  ${positional.name.padEnd(12)}${positional.description}`);
    }
  }

  const flags = [...(spec.flags ?? []), ...UNIVERSAL_FLAGS];
  if (flags.length > 0) {
    lines.push("", "Flags:", ...flagLines(flags));
  }

  if (spec.notes !== undefined && spec.notes.length > 0) {
    lines.push("", ...spec.notes);
  }

  if (spec.tool !== undefined) {
    lines.push("", `MCP tool: ${spec.tool}`);
  }
  return lines.join("\n");
};

const flagLines = (flags: readonly (typeof UNIVERSAL_FLAGS)[number][]): string[] =>
  flags.map((flag) => {
    const spelling = flag.alias?.[0];
    const names = `--${flag.name}${spelling === undefined ? "" : `, -${spelling}`}`;
    const value = flag.value === undefined ? "" : ` ${flag.value}`;
    return `  ${`${names}${value}`.padEnd(28)}${flag.description}`;
  });
