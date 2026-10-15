import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EXE, isWindows, versionOf, whichOnPath } from "./host.js";

/**
 * The two questions every provider asks about this machine.
 *
 * These moved out of `local/` when a second provider needed them, and a shared
 * module is the place where "it happened to work" stops being enough — the
 * docblock states what these do at the edges, and this file is what makes those
 * sentences checkable rather than merely plausible.
 *
 * The fixtures are plain files with a mode, not symlinks to `/bin/true`: what
 * `whichOnPath` decides is executability, and a file whose *content* is
 * irrelevant makes that the only variable in the test.
 */

let root: string;
let bin: string;
let savedPath: string | undefined;

/** A command name that cannot collide with anything installed on the host. */
const PROBE = "uvp-host-probe";
const PROBE_EXE = PROBE + EXE;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "uvp-host-")));
  bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });

  const runnable = join(bin, PROBE_EXE);
  writeFileSync(runnable, "#!/bin/sh\nexit 0\n");
  chmodSync(runnable, 0o755);

  // Present, and deliberately not executable.
  writeFileSync(join(bin, "uvp-host-nonexec"), "not a program\n");
  chmodSync(join(bin, "uvp-host-nonexec"), 0o644);

  savedPath = process.env["PATH"];
});

afterAll(() => {
  if (savedPath === undefined) delete process.env["PATH"];
  else process.env["PATH"] = savedPath;
  rmSync(root, { recursive: true, force: true });
});

/**
 * Run `body` with `PATH` set to `entries` and the working directory set to
 * `cwd`, and put both back whatever happens. The save/restore matches
 * `LocalToolchainProvider.test.ts`, which mutates `PATH` for the same reason.
 *
 * `chdir` is safe here only because this file's project runs in a forked
 * process per file (`adapters` in `vitest.config.ts`), so it cannot move the
 * working directory under another test file.
 */
const withPath = async (
  entries: string,
  body: () => Promise<void>,
  cwd?: string,
): Promise<void> => {
  const savedCwd = process.cwd();
  try {
    if (cwd !== undefined) process.chdir(cwd);
    process.env["PATH"] = entries;
    await body();
  } finally {
    process.chdir(savedCwd);
    if (savedPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = savedPath;
  }
};

describe("whichOnPath", () => {
  it("returns the path of a command that is on PATH and executable", async () => {
    await withPath(bin, async () => {
      expect(await whichOnPath(PROBE)).toBe(join(bin, PROBE_EXE));
    });
  });

  it("returns undefined for a command that is not on PATH at all", async () => {
    await withPath(bin, async () => {
      expect(await whichOnPath("uvp-host-definitely-absent")).toBeUndefined();
    });
  });

  it("returns undefined for a file that is there and is not executable", async () => {
    // The distinction that matters: a `cmake` present and not runnable fails at
    // every point of use exactly like a missing one, so answering with its path
    // would move the failure later and make it stranger.
    await withPath(bin, async () => {
      expect(await whichOnPath("uvp-host-nonexec")).toBeUndefined();
    });
  });

  it("treats an empty PATH entry as nothing, not as the current directory", async () => {
    // Run from the directory that holds the probe, so the two readings give
    // different answers: resolving the empty entry would find `./PROBE` here,
    // and skipping it finds nothing. Without this the test would pass either
    // way, which is the same as not testing it.
    await withPath(
      "",
      async () => {
        expect(await whichOnPath(PROBE)).toBeUndefined();
      },
      bin,
    );
  });

  it("keeps looking past an empty PATH entry rather than matching through it", async () => {
    // Same directory, so an empty entry that resolved would match first and
    // answer with a bare relative name. The absolute path is what says the
    // empty entry was skipped and the real one was used.
    await withPath(
      `${delimiter}${bin}`,
      async () => {
        expect(await whichOnPath(PROBE)).toBe(join(bin, PROBE_EXE));
      },
      bin,
    );
  });

  it("returns undefined when PATH is not set at all", async () => {
    // `NAME=value` with no `value` is the only way a caller can express "no
    // PATH" to a child, and Node deletes the variable for an empty string on
    // some platforms rather than passing it through, so both spellings are
    // exercised: this one deletes it, the ones above set it.
    try {
      delete process.env["PATH"];
      expect(await whichOnPath(PROBE)).toBeUndefined();
    } finally {
      if (savedPath !== undefined) process.env["PATH"] = savedPath;
    }
  });
});

describe("versionOf", () => {
  /** The interpreter running this suite, as a command that certainly exists. */
  const node = process.execPath;

  it("returns the first non-empty line the command printed", async () => {
    const printed = await versionOf(node, [
      "-e",
      "console.log('uvp-version-one'); console.log('uvp-version-two');",
    ]);
    expect(printed).toBe("uvp-version-one");
  });

  it("skips leading blank lines and trims the line it keeps", async () => {
    const printed = await versionOf(node, [
      "-e",
      "process.stdout.write('\\n\\n   uvp-version-trimmed   \\n');",
    ]);
    expect(printed).toBe("uvp-version-trimmed");
  });

  it("keeps output a command wrote before failing", async () => {
    // Declining to report a version a host plainly has would be the wrong
    // answer, and plenty of tools do exactly this: print, then exit non-zero.
    const printed = await versionOf(node, [
      "-e",
      "console.error('uvp-version-on-stderr'); process.exit(3);",
    ]);
    expect(printed).toBe("uvp-version-on-stderr");
  });

  it("returns undefined when a command fails and printed nothing", async () => {
    expect(await versionOf(node, ["-e", "process.exit(3);"])).toBeUndefined();
  });

  it("returns undefined when the command does not exist", async () => {
    expect(await versionOf(join(root, "uvp-host-no-such-program"), ["--version"])).toBeUndefined();
  });

  it("returns undefined when the command printed only whitespace", async () => {
    expect(await versionOf(node, ["-e", "process.stdout.write('   \\n\\t\\n');"])).toBeUndefined();
  });
});

describe("the host platform constants", () => {
  it("derives the executable suffix from the platform rather than assuming one", async () => {
    expect(EXE).toBe(isWindows ? ".exe" : "");
  });
});
