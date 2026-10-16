import { describe, expect, it } from "vitest";

import { wordsOf } from "../../tests/support/recordedCommand.js";
import { runProcess } from "./processRunner.js";

/**
 * The command a caller is handed back, as a line they can re-run.
 *
 * `commands` is not a log: it is the field `uvp build` publishes as evidence,
 * and the sentence beside it says these are what to re-run to read a failure in
 * full. A line that omits the environment the command ran under is a line that
 * reports a different failure — the build points CMake at the libuvcpp uvp found
 * through `CMAKE_PREFIX_PATH` and `PKG_CONFIG_PATH`, so a re-run without them
 * answers "uvcpp is not installed" to a question about a syntax error.
 *
 * `/bin/true` on `PATH` is not used here; the child is this Node binary, which
 * is always present and exits immediately. What is under test is how the call is
 * described, so a command that does nothing is the right one to describe.
 */

/** Run `node -e ""` with an environment, and hand back how it was recorded. */
const recorded = async (env?: Readonly<Record<string, string>>): Promise<string> =>
  (
    await runProcess({
      command: process.execPath,
      args: ["-e", ""],
      ...(env === undefined ? {} : { env }),
      timeoutMs: 30_000,
    })
  ).command;

describe("the recorded form of a command", () => {
  it("is the command and its arguments when no environment was set", async () => {
    // Unchanged from before this was a function, and worth pinning: most
    // commands have no environment, and prefixing all of them would make the
    // common record harder to read than the command it describes.
    //
    // The `''` is the empty argument `-e` was handed, not decoration: a word that
    // is not written is a word the invocation does not have, and `node -e` on its
    // own is not the command that ran.
    expect(await recorded()).toBe(`${process.execPath} -e ''`);
  });

  it("names the variables it set, in a stable order", async () => {
    // Sorted, because two runs of the same build must produce the same record:
    // an evidence digest covers this, and property order in an object is not a
    // fact about the build.
    expect(await recorded({ ZED: "2", ALPHA: "1" })).toBe(
      `env ALPHA=1 ZED=2 ${process.execPath} -e ''`,
    );
  });

  it("quotes a value a shell would otherwise split or swallow", async () => {
    // A prefix with a space in it is a path someone has, and an unquoted
    // `CMAKE_PREFIX_PATH=/opt/my libs` re-runs as a command about `/opt/my`.
    expect(await recorded({ CMAKE_PREFIX_PATH: "/opt/my libs" })).toBe(
      `env CMAKE_PREFIX_PATH='/opt/my libs' ${process.execPath} -e ''`,
    );
    // A value holding a quote is closed, escaped, and reopened — the only
    // spelling that survives a POSIX shell intact. It is also the spelling that
    // catches a naive `'${value}'`, which would end the quoting early and run
    // whatever followed as a command.
    expect(await recorded({ ODD: "it's" })).toBe(`env ODD='it'\\''s' ${process.execPath} -e ''`);
  });

  it("quotes an argument by the same rule, not only the environment", async () => {
    // The half of the rule that was missing: `cmake -S /tmp/uvp probe/ws` is four
    // arguments to a reader and two to uvp, so the line was not re-runnable for
    // exactly the workspace the quoting exists for. Asserted through the same
    // reader the tests use for the environment, so this pins the notation the
    // product writes rather than this file's idea of it.
    const outcome = await runProcess({
      command: process.execPath,
      args: ["-e", "", "/tmp/uvp probe/ws"],
      timeoutMs: 30_000,
    });
    expect(outcome.command).toBe(`${process.execPath} -e '' '/tmp/uvp probe/ws'`);
    // Read back word by word: the argument is one word with a space in it, which
    // is what the child received.
    expect(wordsOf(outcome.command)).toEqual([process.execPath, "-e", "", "/tmp/uvp probe/ws"]);
  });
});
