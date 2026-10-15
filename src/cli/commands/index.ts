import { TOOL_CONTRACTS } from "../../contracts/toolContracts.js";
import type { CommandSpec } from "../commandSpec.js";
import { buildCommand, runCommand, stopCommand, verifyCommand } from "./project.js";
import { doctorCommand } from "./toolchain.js";
import { initCommand } from "./workspace.js";
import {
  assertCommand,
  captureReadCommand,
  captureReplayCommand,
  captureStartCommand,
  httpCommand,
  loadCommand,
  soapCommand,
  websocketCommand,
} from "./web.js";
import { mcpCommand, setupCommand } from "./mcp.js";

/**
 * Every command, in the order help lists them.
 *
 * The list is hand-ordered rather than derived from `TOOL_CONTRACTS`, because
 * the order help prints is a judgement about reading order — doctor first, then
 * the project lifecycle, then the web tools — and a registry keyed by insertion
 * happens to agree with it today. What must not be hand-maintained is
 * *coverage*: `commandCoverage()` below cross-checks this list against the
 * contracts, and the test suite asserts it, so a new contract fails the build
 * until a command is written for it.
 */
export const COMMANDS: readonly CommandSpec[] = [
  doctorCommand,
  initCommand,
  buildCommand,
  runCommand,
  stopCommand,
  verifyCommand,
  httpCommand,
  websocketCommand,
  soapCommand,
  loadCommand,
  assertCommand,
  captureStartCommand,
  captureReadCommand,
  captureReplayCommand,
  mcpCommand,
  setupCommand,
];

export interface CommandCoverage {
  /** Contracts with no command. */
  readonly missing: readonly string[];
  /** Commands naming a contract that does not exist. */
  readonly unknown: readonly string[];
  /** More than one command driving the same contract. */
  readonly duplicated: readonly string[];
}

export const commandCoverage = (commands: readonly CommandSpec[] = COMMANDS): CommandCoverage => {
  const known = new Set(TOOL_CONTRACTS.map((contract) => contract.name));
  const driven = commands.flatMap((command) => (command.tool === undefined ? [] : [command.tool]));
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const name of driven) {
    if (seen.has(name)) duplicated.add(name);
    seen.add(name);
  }
  return {
    missing: [...known].filter((name) => !seen.has(name)).sort(),
    unknown: driven.filter((name) => !known.has(name)).sort(),
    duplicated: [...duplicated].sort(),
  };
};

/**
 * Turn a coverage report into a startup failure.
 *
 * Lives beside the check rather than in the entry point, because it *is* the
 * check's contract: `commandCoverage` describes the disagreement and this decides
 * that any disagreement is fatal. Splitting them across layers put the assertion
 * behind an entry-point import, which no test below the CLI boundary is allowed
 * to reach — so the rule that a contract cannot ship without a command was the
 * one rule in this file with no test.
 */
export const assertCommandCoverage = (commands: readonly CommandSpec[] = COMMANDS): void => {
  const { missing, unknown, duplicated } = commandCoverage(commands);
  const problems = [
    ...missing.map((name) => `${name} has no CLI command`),
    ...unknown.map((name) => `a CLI command names the unknown tool ${name}`),
    ...duplicated.map((name) => `${name} is driven by more than one CLI command`),
  ];
  if (problems.length > 0) {
    throw new Error(`The CLI and the tool contracts disagree: ${problems.join("; ")}.`);
  }
};
