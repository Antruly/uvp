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
 * Where this fixture and a Windows host disagree, and the issue tracking it.
 *
 * `discoverArtifacts` decides what a build produced from a mode bit on POSIX and
 * from an extension on Windows — that branch is in `artifacts.ts` and is right on
 * both platforms. The fixture below names its outputs the POSIX way: no
 * extension, set executable. On Windows the walk finds the file and correctly
 * refuses to call it an artifact, so the four tests that assert one *is* found
 * fail with `expected [] to deeply equal [...]`, while the tests that assert
 * nothing is found pass for the wrong reason. #19 tracks naming them the way the
 * host names an executable, which is what the fix PR does.
 */
const windowsGap =
  process.platform === "win32"
    ? "Windows decides executable-ness by extension, and this fixture names none (see #19)"
    : undefined;

/** `title`, with the reason attached on the host that cannot run it. */
const named = (title: string): string =>
  windowsGap === undefined ? title : `${title} — skipped: ${windowsGap}`;

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
  it.skipIf(windowsGap !== undefined)(
    named("reports an executable file with its size and its digest"),
    async () => {
      const dir = buildDir("basic");
      const produced = put(dir, "hello-service", "a produced binary\n", 0o755);

      const found = await discoverArtifacts(dir);

      expect(found).toEqual([
        {
          path: produced,
          bytes: Buffer.byteLength("a produced binary\n"),
          digest: sha256Of("a produced binary\n"),
        },
      ]);
    },
  );

  it("skips a file that is present and not executable", async () => {
    const dir = buildDir("not-executable");
    put(dir, "notes.txt", "scratch\n", 0o644);
    put(dir, "generated", "still just data\n", 0o644);

    expect(await discoverArtifacts(dir)).toEqual([]);
  });

  it("skips an executable file that is empty", async () => {
    // A zero-byte output is a build that did not finish writing, and its digest
    // would be the digest of nothing.
    const dir = buildDir("empty");
    put(dir, "half-written", "", 0o755);

    expect(await discoverArtifacts(dir)).toEqual([]);
  });

  it("skips a file with an extension even when it is executable", async () => {
    // On a POSIX host the extension is not the signal; an executable `.so` is
    // build output, but an executable `.sh` in a build directory is the
    // heuristic's known cost, and the bias is toward missing rather than
    // inventing.
    const dir = buildDir("with-extension");
    put(dir, "helper.sh", "#!/bin/sh\n", 0o755);

    expect(await discoverArtifacts(dir)).toEqual([]);
  });

  it.skipIf(windowsGap !== undefined)(
    named("descends into a subdirectory and finds what is in it"),
    async () => {
      const dir = buildDir("nested");
      const produced = put(join(dir, "bin"), "service", "binary\n", 0o755);

      const found = await discoverArtifacts(dir);

      expect(found.map((artifact) => artifact.path)).toEqual([produced]);
    },
  );

  it.skipIf(windowsGap !== undefined)(
    named("does not descend into CMakeFiles or a dot-directory"),
    async () => {
      const dir = buildDir("skipped-dirs");
      put(join(dir, "CMakeFiles"), "compiler-check", "binary\n", 0o755);
      put(join(dir, ".cache"), "something", "binary\n", 0o755);
      const kept = put(dir, "kept", "binary\n", 0o755);

      const found = await discoverArtifacts(dir);

      expect(found.map((artifact) => artifact.path)).toEqual([kept]);
    },
  );

  it.skipIf(windowsGap !== undefined)(
    named("does not walk past four levels of subdirectory"),
    async () => {
      // The bound exists so a symlink cycle or an unexpected tree cannot turn
      // discovery into an unbounded walk. Depth 5 is past it, so this file is not
      // reported — which is the cost of the bound, made visible.
      const dir = buildDir("too-deep");
      const deep = join(dir, "a", "b", "c", "d", "e");
      put(deep, "unreachable", "binary\n", 0o755);
      const reachable = put(join(dir, "a", "b", "c", "d"), "reachable", "binary\n", 0o755);

      const found = await discoverArtifacts(dir);

      expect(found.map((artifact) => artifact.path)).toEqual([reachable]);
      expect(existsSync(join(deep, "unreachable"))).toBe(true);
    },
  );

  it("returns nothing for a directory that does not exist", async () => {
    // A build that never produced a directory is not an error about artifacts;
    // there simply are none.
    expect(await discoverArtifacts(join(root, "no-such-build-dir"))).toEqual([]);
  });
});
