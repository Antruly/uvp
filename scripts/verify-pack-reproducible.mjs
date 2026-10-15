#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { REPO_ROOT } from "./lib/paths.mjs";

/**
 * Fail when the published tarball depends on anything except its own contents.
 *
 * `npm pack` produces the one artifact a user installs, and `npm publish`
 * uploads whatever it produced. If those bytes depend on where the checkout
 * sits, when it was packed, or which directory received it, then the digest a
 * consumer can compute is not a fact about the source tree — so it cannot be
 * checked against one, and nobody can reproduce a release from its tag. The
 * claim being made here is narrow and testable: pack the same contents twice,
 * from two different places, and get the same bytes.
 *
 * ## Four packs, and the one thing each of the last three varies
 *
 *   1. the tree as it is, into its own directory                   — the reference
 *   2. the tree again, into a second directory, seconds later      — the
 *      destination and the moment are not inputs
 *   3. a copy of the first tarball's own contents, unpacked at a
 *      different absolute path and depth, with fresh mtimes        — the path and
 *      the clock are not inputs
 *   4. the tree again, after all of that                            — packing does
 *      not consume or rewrite what it reads
 *
 * Each one lands in its own directory, and is digested there: two packs into one
 * directory write the same file name, and the second replaces the first, so a
 * comparison by path afterwards reads one tarball twice. That is how the first
 * version of this file passed while never looking at its second pack.
 *
 * All four pass `--ignore-scripts`, so that one thing varies at a time. `npm
 * pack` otherwise runs the `prepare` lifecycle — `husky` in this repository —
 * which a copy of the tarball's contents cannot run: the copy has no
 * `node_modules`, and it should not, being what the tarball holds. Holding the
 * lifecycle constant is what makes the four comparable, and it costs nothing to
 * hold it: packing this tree with the lifecycle scripts and with
 * `--ignore-scripts` produced the same digest, measured rather than assumed.
 *
 * ## Why the copy is an unpacking of the tarball
 *
 * Which files go into a tarball is npm's answer, from `files[]`, `.npmignore`,
 * `package.json`'s own always-included entries, and npm's defaults. Copying
 * "the inputs" here would mean writing a second implementation of that answer,
 * and a second implementation drifts: the day `files[]` gains an entry, the copy
 * misses it and the check compares two trees that are no longer the same tree.
 * Unpacking the tarball cannot drift, because it is the artifact's own contents.
 * It also asks a sharper question than path independence: **packing what the
 * tarball holds must produce the tarball**, so the contents and the archive agree
 * about themselves.
 *
 * ## What this establishes, and what it does not
 *
 * Established, on this host: the same bytes from a second destination, from the
 * contents unpacked at a different absolute path and depth, and again after that.
 * That covers npm's portable-tar handling (mtimes and ownership are normalised —
 * observable in the listing as `1985-10-26 16:15 0/0`), absolute paths that a
 * source map or a generated file could carry out of a checkout, and any
 * timestamp a build could have written into `dist/`.
 *
 * Not established, and stated rather than implied — so that a pass is not read
 * as more than it is:
 *
 *   - **The build.** These four packs read one `dist/`, so a pass says nothing
 *     about whether `npm run compile` emits the same bytes twice; putting a full
 *     `tsc` run inside a repository check is a cost this does not pay. It was
 *     measured by hand instead, twice on 2026-10-16: a clean rebuild between runs
 *     reproduced the digest. The gap is in what the check establishes, and the
 *     check is the part that runs unattended.
 *   - **Another npm version.** `packageManager` in `package.json` pins the one
 *     this repository uses, which is what makes the check the same check
 *     everywhere. Packing under another major is untested here.
 *   - **Another machine.** The unpacked copy varies the path and the mtimes,
 *     which are the two a check on one host can vary safely. Filesystem was tried
 *     by hand rather than in the check — the same tree on `tmpfs` matched too —
 *     and one more filesystem is one more data point, not all of them. A second
 *     host, a second architecture and byte-order differences are not sampled at
 *     all.
 *
 * ## Fail-closed
 *
 * A tree with no `dist/` packs into a perfectly reproducible tarball that is not
 * the artifact anyone installs, so that is a failure with the script to run
 * rather than a pass. `tar` missing is a failure too: the check cannot compare
 * what it cannot unpack, and reporting that as reproducible would be the exact
 * lie this file exists to prevent. The unbuilt-tree test is made against the
 * tarball's own listing rather than a guessed filename, so a renamed output does
 * not quietly turn the check off.
 */

const run = promisify(execFile);

const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

/** One `npm pack`, into `destination`, from `cwd`. Returns the tarball's path. */
const pack = async (cwd, destination) => {
  const { stdout } = await run(
    NPM,
    ["pack", "--ignore-scripts", "--pack-destination", destination],
    {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  // `npm pack` prints the file name it wrote, and one line of npm notice noise is
  // possible on stderr; the name is the last non-empty line of stdout.
  const name = stdout.trim().split("\n").filter(Boolean).pop();
  if (name === undefined || !name.endsWith(".tgz")) {
    throw new Error(`npm pack printed '${stdout.trim()}', which is not a tarball name`);
  }
  return path.join(destination, name);
};

const digestOf = async (file) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");

/** The entry names a tarball holds, in order. */
const entriesOf = async (tarball) => {
  const { stdout } = await run("tar", ["tzf", tarball], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim().split("\n").filter(Boolean);
};

/** Unpack a tarball into `directory`, without npm's `package/` prefix. */
const unpack = async (tarball, directory) => {
  await mkdir(directory, { recursive: true });
  await run("tar", ["xzf", tarball, "-C", directory, "--strip-components=1"]);
};

const short = (digest) => digest.slice(0, 12);

const main = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uvp-pack-"));
  // One directory per pack, because two packs into one directory write the same
  // file name and the second silently replaces the first. That is not
  // hypothetical: the first version of this file packed two of the four into the
  // same place, digested both by path afterwards, and compared one tarball with
  // itself twice — a check that reported agreement while never looking at the
  // second pack. Digesting each one where it is produced, into its own
  // directory, is what makes the comparison the one it claims to be.
  const [referenceDestination, secondDestination, copyDestination, againDestination] =
    await Promise.all(
      ["first", "second", "unpacked-copy", "again"].map(async (name) => {
        const directory = path.join(root, name);
        await mkdir(directory, { recursive: true });
        return directory;
      }),
    );
  // A deliberately different absolute path: more segments, more characters than
  // the repository's own, and not under the same parent as any pack target.
  const deepCopy = path.join(root, "a-copy-of-the-contents", "unpacked", "somewhere", "else");

  /**
   * Pack, digest where it landed, and require the reference digest.
   *
   * `what` names the one thing this pack varies, because that is the whole claim:
   * a failure here is a statement about what the tarball depends on, and the
   * message has to say which input turned out to be one.
   */
  const expectSame = async (what, tarball, reference, expectedEntries) => {
    const digest = await digestOf(tarball);
    if (digest !== reference) {
      const theirs = await entriesOf(tarball);
      const difference =
        theirs.length === expectedEntries
          ? "the entry count matches, so the difference is inside an entry"
          : `the entry count differs: ${String(expectedEntries)} against ${String(theirs.length)}`;
      throw new Error(
        [
          `packing ${what} produced ${short(digest)}, but packing the tree produced ${short(reference)}.`,
          `${difference}.`,
          "The tarball is not a fact about its contents, which means a release cannot be reproduced from its tag.",
        ].join("\n"),
      );
    }
    console.log(`pack reproducible: ${what} → ${short(digest)} (same)`);
  };

  try {
    const first = await pack(REPO_ROOT, referenceDestination);
    const reference = await digestOf(first);
    const entries = await entriesOf(first);

    if (!entries.some((entry) => entry.startsWith("package/dist/"))) {
      throw new Error(
        [
          `the tarball holds ${String(entries.length)} entries and no \`dist/\` among them,`,
          "so it was packed from a tree that was never built. Run `npm run compile` first:",
          "an unbuilt tree packs reproducibly and is not the artifact anyone installs.",
        ].join(" "),
      );
    }

    // Seconds later, into a different directory: neither the moment nor the
    // destination is an input.
    await expectSame(
      "a second destination, seconds later",
      await pack(REPO_ROOT, secondDestination),
      reference,
      entries.length,
    );

    // The contents of the first tarball, unpacked at another absolute path, with
    // fresh mtimes. This is the pack that asks whether packing what the tarball
    // holds produces the tarball.
    await unpack(first, deepCopy);
    await expectSame(
      "the contents unpacked at another path",
      await pack(deepCopy, copyDestination),
      reference,
      entries.length,
    );

    // Last, because a check that changes what it measures measures the wrong
    // thing: the tree has to still pack to the reference digest after all of the
    // above, which is also where a packing that rewrote its own inputs would show
    // up.
    await expectSame(
      "the tree again, after all of that",
      await pack(REPO_ROOT, againDestination),
      reference,
      entries.length,
    );

    console.log(
      `pack reproducible: ${short(reference)} over ${String(entries.length)} entries — the same bytes from another destination, from the contents unpacked at another path, and again afterwards`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

main().catch((error) => {
  // A missing `tar` is a reason to fail rather than to pass over the comparison;
  // the message says which tool could not be run instead of leaving a bare
  // ENOENT to be read as a packaging bug.
  if (error?.code === "ENOENT") {
    console.error(`pack reproducibility: cannot run ${String(error.path)} — this check needs it.`);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
});
