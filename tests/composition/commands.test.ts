import { describe, expect, it } from "vitest";

import {
  commandName,
  isToolCommand,
  resolveCommand,
  type CommandSpec,
} from "../../src/cli/commandSpec.js";
import { COMMANDS, assertCommandCoverage, commandCoverage } from "../../src/cli/commands/index.js";
import { TOOL_CONTRACTS } from "../../src/contracts/toolContracts.js";

/**
 * The composition lane: the CLI registry against the tool contracts.
 *
 * Two registries describe the same surface — the contracts, which are the single
 * source of truth, and `COMMANDS`, which is hand-ordered because the order help
 * prints is a judgement about reading order rather than something derivable. The
 * list is allowed to be hand-written; its *coverage* is not allowed to drift.
 * Nothing but this lane connects them, so without it a new contract ships with no
 * command and no error anywhere.
 *
 * The registry is checked through `commandCoverage`'s own output rather than by
 * re-deriving the answer here. A second derivation would agree with `COMMANDS`
 * and disagree with the contracts, which is the failure this file exists to
 * catch.
 */

const withTool = (tool: string): CommandSpec => ({
  path: [tool],
  summary: "A synthetic command.",
  usage: `uvp ${tool}`,
  tool,
  input: () => ({}),
});

describe("command coverage", () => {
  it("drives every contract exactly once", () => {
    // The documented invariant: `commandCoverage()` cross-checks the hand-ordered
    // list against the contracts, and a new contract fails the build until a
    // command is written for it. All three empty is the whole claim.
    expect(commandCoverage()).toEqual({ missing: [], unknown: [], duplicated: [] });
  });

  it("does not throw when the process entry point checks coverage at startup", () => {
    // `assertCommandCoverage` runs before anything is served. A throw here would
    // be a build-time bug reaching a user as a crash on every invocation.
    expect(() => assertCommandCoverage()).not.toThrow();
  });

  it("refuses to start when a contract has no command", () => {
    // The vacuity guard for the test above: a function that never throws would
    // satisfy it, and the startup check would be decorative. This is also why the
    // assertion takes a command list — the failure path is otherwise only
    // reachable by editing the real registry, so it was the one rule here that no
    // test could reach.
    const contractsOnly = COMMANDS.filter(isToolCommand).slice(1);
    expect(() => assertCommandCoverage(contractsOnly)).toThrow(/has no CLI command/u);
  });

  it("treats a duplicate as a startup failure, not as a warning", () => {
    const first = COMMANDS.find(isToolCommand);
    if (first === undefined) throw new Error("no tool-driven command to duplicate");
    expect(() => assertCommandCoverage([...COMMANDS, withTool(first.tool)])).toThrow(
      /driven by more than one CLI command/u,
    );
  });

  it("names a contract with no command, rather than passing over it", () => {
    // The vacuity guard for the first test. If `commandCoverage` returned empty
    // lists unconditionally, that test would pass and this gate would be worth
    // nothing — so each of the three problems is provoked here.
    const contractsOnly = COMMANDS.filter(isToolCommand).slice(1);
    const { missing } = commandCoverage(contractsOnly);
    const dropped = COMMANDS.find(isToolCommand);
    if (dropped === undefined) throw new Error("no tool-driven command to drop");
    expect(missing).toContain(dropped.tool);
  });

  it("names a command driving a contract that does not exist", () => {
    // The other direction: a typo in `tool` would make a command print a result
    // no contract describes, and nothing else would notice.
    const { unknown } = commandCoverage([...COMMANDS, withTool("uvp_nowhere")]);
    expect(unknown).toEqual(["uvp_nowhere"]);
  });

  it("names a contract driven by two commands, which would shadow one another", () => {
    const first = COMMANDS.find(isToolCommand);
    if (first === undefined) throw new Error("no tool-driven command to duplicate");
    const { duplicated } = commandCoverage([...COMMANDS, withTool(first.tool)]);
    expect(duplicated).toEqual([first.tool]);
  });

  it("reports problems in a stable order, so a diff of two runs is readable", () => {
    // Sorted output is what makes this usable in a build log; an unordered set
    // would reorder between runs and make an intermittent failure look new.
    const { missing, unknown } = commandCoverage([withTool("uvp_bbb"), withTool("uvp_aaa")]);
    expect(unknown).toEqual(["uvp_aaa", "uvp_bbb"]);
    expect([...missing]).toEqual([...missing].sort());
  });
});

describe("the command registry", () => {
  it("gives every command a distinct path", () => {
    // Two commands sharing a path means one is unreachable — `resolveCommand`
    // takes the first match — and the shadowed one is invisible in help because
    // the list still has an entry for it.
    const paths = COMMANDS.map((command) => command.path.join(" "));
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("resolves each command by its own words, longest path first", () => {
    for (const command of COMMANDS) {
      expect(resolveCommand(COMMANDS, command.path)?.path).toEqual(command.path);
    }
  });

  it("prefers the longer path, so `capture start` is not read as `capture`", () => {
    // The rule that makes multi-word paths work at all. Checked on a synthetic
    // pair, because the real registry's paths are all distinct in length and a
    // coincidental pass would prove nothing.
    const short = withTool("uvp_short");
    const long: CommandSpec = { ...withTool("uvp_long"), path: ["capture", "start"] };
    expect(resolveCommand([short, long], ["capture", "start"])?.path).toEqual(["capture", "start"]);
  });

  it("returns nothing for words no command claims", () => {
    expect(resolveCommand(COMMANDS, ["nonesuch"])).toBeUndefined();
  });

  it("gives every command a summary, a usage line, and a name that reads as one", () => {
    for (const command of COMMANDS) {
      const name = commandName(command);
      expect(name.startsWith("uvp "), `${name} is not named as a command`).toBe(true);
      // Both are printed by `--help`, and an empty one renders as a blank line
      // that reads like a formatting bug rather than a missing description.
      expect(command.summary.length, `${name} summary`).toBeGreaterThan(10);
      expect(command.usage.startsWith("uvp "), `${name} usage`).toBe(true);
      expect(command.usage, `${name} usage does not name the command`).toContain(
        command.path.join(" "),
      );
    }
  });

  it("leaves mcp and setup without a contract, and everything else with one", () => {
    // These two are the documented exceptions: a contract exists so a model can
    // call it, and a model cannot usefully call "start the server it is already
    // talking to". Pinning the exact set keeps a third exception from appearing
    // unnoticed — that is the sort of thing coverage would not catch, since a
    // contract-less command is not `missing` or `unknown`, just unreachable by
    // tool name.
    const local = COMMANDS.filter((command) => !isToolCommand(command)).map(commandName);
    expect(local.sort()).toEqual(["uvp mcp", "uvp setup"]);
  });

  it("declares no flag that collides with a universal one", () => {
    // `--json` and `--help` are added to every command's table by `parseArgv`.
    // A command redeclaring one would give `bySpelling` two entries for the same
    // spelling, and which wins would depend on map insertion order.
    const universal = new Set(["json", "help", "h"]);
    for (const command of COMMANDS) {
      for (const flag of command.flags ?? []) {
        const spellings = [flag.name, ...(flag.alias ?? [])];
        for (const spelling of spellings) {
          expect(universal.has(spelling), `${commandName(command)} redeclares --${spelling}`).toBe(
            false,
          );
        }
      }
    }
  });

  it("keeps every flag name a valid long flag", () => {
    // A name with a space or a leading dash would be untypeable and would break
    // the `--name=value` split before it ever reached the table.
    for (const command of COMMANDS) {
      for (const flag of command.flags ?? []) {
        expect(flag.name, `${commandName(command)} flag name`).toMatch(/^[a-z][a-z0-9-]*$/u);
        expect(flag.description.length, `${commandName(command)} --${flag.name}`).toBeGreaterThan(
          0,
        );
      }
    }
  });

  it("names a real contract from every tool-driven command", () => {
    // The same question `commandCoverage` asks, asserted directly against the
    // contract list so a change to the coverage function cannot loosen it.
    const names = new Set(TOOL_CONTRACTS.map((contract) => contract.name));
    for (const command of COMMANDS) {
      if (!isToolCommand(command)) continue;
      expect(names.has(command.tool), `${commandName(command)} names ${command.tool}`).toBe(true);
    }
  });
});
