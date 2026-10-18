import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";

import { runProcess } from "./processRunner.js";

/**
 * Facts about the machine uvp is running on, asked in one place.
 *
 * Two questions live here, and both are asked by every provider that runs a
 * tool: is this command on the path, and what version does it report. They were
 * private to `local/` until a second provider needed them, which is the wrong
 * shape — a `container/` provider looking for `docker` and a `remote-ssh/` one
 * looking for `ssh` are asking the same question as `local/` looking for `cmake`.
 *
 * ## Why they are not reimplemented per provider
 *
 * They look like four lines each, which is exactly the problem. Two
 * implementations would eventually disagree about `PATHEXT`, about an empty
 * entry in `PATH` (which means the current directory on some systems and is
 * skipped here), or about a file that exists and is not executable — and the
 * disagreement would surface as one provider finding a compiler the other
 * cannot, which reads as a toolchain bug rather than a lookup bug.
 *
 * ## What this module deliberately does not own
 *
 * No caching. A caller that probes a command twice gets two answers, because the
 * second one is allowed to differ — someone installing a compiler mid-session is
 * not a case to optimise away, and a cache here would need invalidation that no
 * caller has asked for.
 *
 * No interpretation. `versionOf` returns the first line the command printed and
 * nothing else: it does not parse a version out of it, because the shape of that
 * line is a fact about the tool, and the tool that knows its own version string
 * is the one that should be parsing it.
 */

export const isWindows = process.platform === "win32";
export const EXE = isWindows ? ".exe" : "";

/**
 * The absolute path of the first of `names` that is on `PATH`, names in order.
 *
 * Unlike `whichOnPath`, the names are taken literally — an extension is part of
 * the name — and the whole list is tried in each directory before the next one is
 * opened. That is how CMake's `find_program(... NAMES_PER_DIR)` searches, and it
 * matters for `pkg-config` on Windows: CMake lists `pkg-config.bat` before the
 * extensionless name, so the wrapper it would pick is the one this reports, not
 * whichever `.exe` an extensionless lookup finds later on `PATH`.
 */
export const findOnPath = async (names: readonly string[]): Promise<string | undefined> => {
  const pathValue = process.env["PATH"];
  if (pathValue === undefined) return undefined;
  for (const dir of pathValue.split(delimiter)) {
    if (dir === "") continue;
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Not here; try the next name in this directory.
      }
    }
  }
  return undefined;
};

/**
 * The absolute path of `command` on `PATH`, or `undefined` if it is not there.
 *
 * `undefined` rather than a throw, because "not installed" is the ordinary
 * answer for most of what uvp looks for on a developer's machine, and a caller
 * that has to catch an exception to represent the common case will eventually
 * catch it too widely.
 *
 * Executability is checked, not just existence: a `cmake` that is present and
 * not runnable is indistinguishable from a missing one at every point of use,
 * so reporting a path for it would move the failure later and make it stranger.
 */
export const whichOnPath = async (command: string): Promise<string | undefined> => {
  const pathValue = process.env["PATH"];
  if (pathValue === undefined) return undefined;
  for (const dir of pathValue.split(delimiter)) {
    // An empty entry is the current directory on some platforms. Resolving it
    // would make which command runs depend on where uvp was started, so it is
    // skipped rather than interpreted.
    if (dir === "") continue;
    const candidate = join(dir, command + (isWindows && !command.endsWith(EXE) ? EXE : ""));
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; keep looking.
    }
  }
  return undefined;
};

/**
 * The first non-empty line `command args` printed, or `undefined` if it failed.
 *
 * An invocation counts as failed when it exits non-zero *and* printed nothing.
 * Non-zero with output is deliberately kept: plenty of tools answer `--version`
 * on stderr or exit 1 after printing something useful, and discarding that would
 * lose a version this host plainly has.
 *
 * The timeout is here rather than at the call sites because a version probe is a
 * courtesy, not a build: a command that hangs on `--version` should cost ten
 * seconds and an `undefined`, never a wedged inspection.
 */
export const versionOf = async (
  command: string,
  args: readonly string[],
): Promise<string | undefined> => {
  const outcome = await runProcess({ command, args, timeoutMs: 10_000 }).catch(() => undefined);
  if (
    outcome === undefined ||
    (outcome.exitCode !== 0 && outcome.stdout === "" && outcome.stderr === "")
  ) {
    return undefined;
  }
  const firstLine = `${outcome.stdout}\n${outcome.stderr}`
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine;
};
