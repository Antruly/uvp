import { describe, expect, it } from "vitest";

import { assignmentOf, wordsOf } from "../../tests/support/recordedCommand.js";
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
 * Two things are asserted, and they are asserted separately on purpose. The
 * **notation** is pinned on words whose spelling does not depend on the host —
 * an empty argument, a value with a space, a value with a quote. The **line as a
 * whole** is read back through `wordsOf`, the reader this repository actually
 * uses, and checked against the words that were run: that is the invariant, and
 * it holds on a host that writes `C:\…\node.exe` as well as on one that writes
 * `/usr/bin/node`. Writing the expectation as `${process.execPath} …` instead
 * would be an assertion about this host: on Windows the executable is single
 * quoted, because a backslash is an escape in the dialect the line is written in
 * and a bare one would not be the path that ran. The Windows lane failed on
 * exactly that, which is why the assertions read this way.
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
    // Worth pinning: most commands have no environment, and prefixing all of
    // them would make the common record harder to read than the command it
    // describes.
    const line = await recorded();
    expect(wordsOf(line)).toEqual([process.execPath, "-e", ""]);
    // The `''` is the empty argument `-e` was handed, not decoration: a word
    // that is not written is a word the invocation does not have, and a line
    // ending at `-e` is not the command that ran.
    expect(line.endsWith("-e ''")).toBe(true);
  });

  it("names the variables it set, in a stable order", async () => {
    // Sorted, because two runs of the same build must produce the same record:
    // an evidence digest covers this, and property order in an object is not a
    // fact about the build.
    const line = await recorded({ ZED: "2", ALPHA: "1" });
    expect(line.startsWith("env ALPHA=1 ZED=2 ")).toBe(true);
    // Read back word by word, with the reader this repository ships, so the
    // assignment is checked as the record's notation rather than as a substring.
    expect(wordsOf(line)).toEqual(["env", "ALPHA=1", "ZED=2", process.execPath, "-e", ""]);
    expect(assignmentOf(line, "ALPHA")).toBe("1");
  });

  it("quotes a value a shell would otherwise split or swallow", async () => {
    // A prefix with a space in it is a path someone has, and an unquoted
    // `CMAKE_PREFIX_PATH=/opt/my libs` re-runs as a command about `/opt/my`.
    const spaced = await recorded({ CMAKE_PREFIX_PATH: "/opt/my libs" });
    expect(spaced.startsWith("env CMAKE_PREFIX_PATH='/opt/my libs' ")).toBe(true);
    expect(assignmentOf(spaced, "CMAKE_PREFIX_PATH")).toBe("/opt/my libs");
    // A value holding a quote is closed, escaped, and reopened — the only
    // spelling that survives a POSIX shell intact. It is also the spelling that
    // catches a naive `'${value}'`, which would end the quoting early and run
    // whatever followed as a command.
    const odd = await recorded({ ODD: "it's" });
    expect(odd.startsWith(String.raw`env ODD='it'\''s' `)).toBe(true);
    expect(assignmentOf(odd, "ODD")).toBe("it's");
  });

  it("quotes an argument by the same rule, not only the environment", async () => {
    // The half of the rule that was missing: `cmake -S /tmp/uvp probe/ws` is four
    // arguments to a reader and two to uvp, so the line was not re-runnable for
    // exactly the workspace the quoting exists for. The argument's spelling is
    // host-independent, so it is pinned literally, and the line is read back to
    // show the space did not become a separator.
    const outcome = await runProcess({
      command: process.execPath,
      args: ["-e", "", "/tmp/uvp probe/ws"],
      timeoutMs: 30_000,
    });
    expect(outcome.command.endsWith(`-e '' '/tmp/uvp probe/ws'`)).toBe(true);
    expect(wordsOf(outcome.command)).toEqual([process.execPath, "-e", "", "/tmp/uvp probe/ws"]);
  });
});
