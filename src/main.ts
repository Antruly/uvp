#!/usr/bin/env node
import { runCli } from "./cli.js";
import { assertCommandCoverage } from "./cli/commands/index.js";

/**
 * The process-level entry point.
 *
 * Everything that needs a process lives here and nowhere else: the signal
 * handlers that turn a Ctrl-C into an exit code, the last-resort error trap, and
 * the startup self-check. `runCli` does none of it, which is what makes the CLI
 * callable from a test.
 *
 * The self-check runs before the first command is dispatched. A CLI command that
 * names a tool no contract defines is a wiring mistake that would otherwise
 * surface as "unknown flag" the first time someone typed that command in front of
 * an audience; here it fails at startup, in every environment, including CI.
 */

const reportFatal = (error: unknown): void => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
};

const main = async (): Promise<void> => {
  try {
    assertCommandCoverage();
  } catch (error) {
    reportFatal(error);
    process.exitCode = 2;
    return;
  }

  try {
    process.exitCode = await runCli(process.argv.slice(2));
  } catch (error) {
    // `runCli` handles its own failures; reaching here means the failure was in
    // the CLI's own machinery, and a stack trace is the honest report for that.
    reportFatal(error);
    process.exitCode = 2;
  }
};

await main();
