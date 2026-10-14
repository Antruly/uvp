#!/usr/bin/env node
/**
 * The `uvp` executable.
 *
 * Deliberately thin. It resolves the compiled CLI, hands it the arguments, and
 * turns an unhandled rejection into an exit code — everything else belongs on
 * the other side of that import, where it can be tested without spawning a
 * process.
 *
 * The one piece of judgement here is what happens when `dist/` is missing. That
 * happens when someone runs the file from a fresh checkout before building, and
 * the default Node error ("Cannot find module") sends them looking for a bug in
 * the CLI rather than at the build step they skipped.
 */

const args = process.argv.slice(2);

let runCli;
try {
  ({ runCli } = await import("../dist/cli.js"));
} catch (error) {
  if (error.code === "ERR_MODULE_NOT_FOUND" || error.code === "MODULE_NOT_FOUND") {
    process.stderr.write(
      "uvp is not built: dist/cli.js is missing.\n" +
        "From a source checkout, run `npm ci && npm run compile` first.\n" +
        "From npm, reinstall the package — a published tarball always includes dist/.\n",
    );
    process.exit(2);
  }
  throw error;
}

if (typeof runCli !== "function") {
  process.stderr.write("dist/cli.js does not export runCli. The build output is inconsistent.\n");
  process.exit(2);
}

try {
  // The CLI owns its own exit code: a failed assertion exits 1, bad input exits
  // 2. Passing it through unchanged is what lets a shell script branch on it.
  process.exitCode = await runCli(args);
} catch (error) {
  process.stderr.write(`${error?.stack ?? String(error)}\n`);
  process.exitCode = 2;
}
