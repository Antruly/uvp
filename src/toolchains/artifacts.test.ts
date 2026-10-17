import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { discoverArtifacts } from "./artifacts.js";
import { EXE } from "./host.js";

/**
 * Which files a build directory is reported to have produced.
 *
 * Moved out of `LocalToolchainProvider` when a second provider turned out to
 * need it, so this file is what holds the contract the module now states: what
 * counts as an artifact, what is skipped, and how far the walk goes.
 *
 * The heuristic is the part worth pinning. "An executable bit on Unix, an
 * extension on Windows" is a guess about what CMake wrote, and the guess is
 * deliberately biased toward missing an artifact rather than inventing one — a
 * source file reported as a build output would put a digest in the evidence
 * bundle for something the build did not produce.
 */

let root: string;

/**
 * Whether this process can be stopped from reading a file by its mode.
 *
 * A POSIX mode bit is what makes an executable unreadable here; root ignores the
 * bits entirely, and Windows ACLs are not set by `chmod`. Both leave the file
 * readable, so the case that exercises the failure is skipped with the reason
 * stated rather than passing for the wrong reason.
 */
const cannotSealRead = (): string | undefined => {
  if (process.platform === "win32") return "Windows ACLs are not set by chmod";
  if (process.getuid?.() === 0) return "a root process reads the file regardless of its mode";
  return undefined;
};

const sealedReason = cannotSealRead();

const named = (title: string): string =>
  sealedReason === undefined ? title : `${title} — skipped: ${sealedReason}`;

/**
 * The name this host gives a build output.
 *
 * `discoverArtifacts` decides what a build produced from a mode bit on POSIX and
 * from an extension on Windows, and the two are not interchangeable: a fixture
 * that writes `service` and sets the executable bit is naming its output the
 * POSIX way, and on Windows the same file is correctly not an artifact at all.
 * Every file below that is meant to be a build output is therefore named the way
 * the host names one, so each test tests the rule it is about rather than the
 * fixture's spelling of it. `EXE` is the product's own answer to what this host
 * appends to an executable's name, which is what makes the fixture and the walk
 * agree by construction instead of by comment.
 */
const producedName = (stem: string): string => `${stem}${EXE}`;

/** Write `name` under `dir` with `contents`, and return its full path. */
const put = (dir: string, name: string, contents: string, mode?: number): string => {
  mkdirSync(dir, { recursive: true });
  const full = join(dir, name);
  writeFileSync(full, contents);
  if (mode !== undefined) chmodSync(full, mode);
  return full;
};

const sha256Of = (text: string): string =>
  createHash("sha256").update(Buffer.from(text)).digest("hex");

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "uvp-artifacts-")));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A build directory shaped like the thing under test, named by the case. */
const buildDir = (name: string): string => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};

describe("discoverArtifacts", () => {
  it("reports an executable file with its size and its digest", async () => {
    const dir = buildDir("basic");
    const produced = put(dir, producedName("hello-service"), "a produced binary\n", 0o755);

    const found = await discoverArtifacts(dir);

    expect(found).toEqual([
      {
        path: produced,
        bytes: Buffer.byteLength("a produced binary\n"),
        digest: sha256Of("a produced binary\n"),
      },
    ]);
  });

  it("skips a file that is present and not executable", async () => {
    // Two readings of one fixture, because the host has two rules for this. On
    // POSIX the file is not executable: `generated` carries no mode bit worth
    // anything, and `notes.txt` is the extension the heuristic declines even when
    // it is set. On Windows there is no mode bit at all, and an extensionless file
    // is not named like an executable — the same answer by that host's own rule,
    // which is why this fixture is unchanged and still passes there.
    const dir = buildDir("not-executable");
    put(dir, "notes.txt", "scratch\n", 0o644);
    put(dir, "generated", "still just data\n", 0o644);

    expect(await discoverArtifacts(dir)).toEqual([]);
  });

  it("skips an executable file that is empty", async () => {
    // A zero-byte output is a build that did not finish writing, and its digest
    // would be the digest of nothing. Named as an output on this host, so on
    // Windows it is refused for being empty rather than for being nameless.
    const dir = buildDir("empty");
    put(dir, producedName("half-written"), "", 0o755);

    expect(await discoverArtifacts(dir)).toEqual([]);
  });

  it.skipIf(sealedReason !== undefined)(
    named("skips an executable it cannot read, rather than rejecting the build"),
    async () => {
      // An executable this process may run but not read is the ordinary way a
      // build output becomes unreadable, and it is still a successful build. The
      // walk's own rule — a read that fails is a file that is not an artifact —
      // has to hold for the digest read too, not just for `readdir` and `stat`.
      const dir = buildDir("unreadable");
      const sealed = put(dir, producedName("sealed"), "binary\n", 0o111);
      const readable = put(dir, producedName("open"), "binary\n", 0o755);

      const found = await discoverArtifacts(dir);

      expect(found.map((artifact) => artifact.path).sort()).toEqual([readable].sort());
      expect(existsSync(sealed)).toBe(true);
    },
  );

  it("skips a file with an extension even when it is executable", async () => {
    // On a POSIX host the extension is not the signal; an executable `.so` is
    // build output, but an executable `.sh` in a build directory is the
    // heuristic's known cost, and the bias is toward missing rather than
    // inventing. On Windows `.sh` is not an artifact for the opposite reason —
    // the extension is the only signal there, and this is not one of the two it
    // accepts — so this fixture is the rare one that reads the same on both.
    const dir = buildDir("with-extension");
    put(dir, "helper.sh", "#!/bin/sh\n", 0o755);

    expect(await discoverArtifacts(dir)).toEqual([]);
  });

  it("descends into a subdirectory and finds what is in it", async () => {
    const dir = buildDir("nested");
    const produced = put(join(dir, "bin"), producedName("service"), "binary\n", 0o755);

    const found = await discoverArtifacts(dir);

    expect(found.map((artifact) => artifact.path)).toEqual([produced]);
  });

  it("does not descend into CMakeFiles or a dot-directory", async () => {
    const dir = buildDir("skipped-dirs");
    put(join(dir, "CMakeFiles"), producedName("compiler-check"), "binary\n", 0o755);
    put(join(dir, ".cache"), producedName("something"), "binary\n", 0o755);
    const kept = put(dir, producedName("kept"), "binary\n", 0o755);

    const found = await discoverArtifacts(dir);

    expect(found.map((artifact) => artifact.path)).toEqual([kept]);
  });

  it("does not walk past four levels of subdirectory", async () => {
    // The bound exists so a symlink cycle or an unexpected tree cannot turn
    // discovery into an unbounded walk. Depth 5 is past it, so this file is not
    // reported — which is the cost of the bound, made visible.
    const dir = buildDir("too-deep");
    const deep = join(dir, "a", "b", "c", "d", "e");
    put(deep, producedName("unreachable"), "binary\n", 0o755);
    const reachable = put(
      join(dir, "a", "b", "c", "d"),
      producedName("reachable"),
      "binary\n",
      0o755,
    );

    const found = await discoverArtifacts(dir);

    expect(found.map((artifact) => artifact.path)).toEqual([reachable]);
    expect(existsSync(join(deep, producedName("unreachable")))).toBe(true);
  });

  it("returns nothing for a directory that does not exist", async () => {
    // A build that never produced a directory is not an error about artifacts;
    // there simply are none.
    expect(await discoverArtifacts(join(root, "no-such-build-dir"))).toEqual([]);
  });
});
