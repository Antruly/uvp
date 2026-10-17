import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { BuildArtifact } from "../application/ToolchainProvider.js";
import { sha256 } from "../domain/identity.js";

/**
 * What a build directory actually produced, as files this host can read.
 *
 * This lived in `LocalToolchainProvider` and is not local to anything. A
 * container provider bind-mounts the workspace at the same absolute path, so the
 * build directory it is handed is an ordinary host directory by the time the
 * build finishes, and "which files appeared, and what is in them" is the same
 * question with the same answer. That is also why the platform heuristic below
 * is about *this* host rather than about whatever compiled the code: the
 * artifacts that get hashed here are host files, whoever wrote them.
 *
 * ## Why the walk is bounded and forgiving
 *
 * A build directory is a tree whose shape the project chose, so uvp cannot
 * enumerate artifacts from a manifest — it has to look. Looking means every
 * failure mode of a filesystem walk: a directory that vanished between listing
 * and opening, a symlink cycle, a path too deep to be a build output. Nothing
 * here is a finding about the build, so none of it is reported: a read that
 * fails is a file that is not an artifact, and the walk gives up past a fixed
 * depth rather than following whatever it finds.
 */

/** No build output of interest sits deeper than this. */
const MAX_DEPTH = 4;

/** Directories whose contents are build machinery rather than build outputs. */
const isSkippedDirectory = (entry: string): boolean =>
  entry === "CMakeFiles" || entry.startsWith(".");

/**
 * Whether an entry looks like something that was built, rather than a file that
 * went into building it.
 *
 * An executable bit is the signal on Unix and an extension is the signal on
 * Windows, and both are heuristics — there is no marker CMake writes that means
 * "this is an output". The bias is deliberate: reporting a source file as an
 * artifact would put a digest in the evidence bundle for something the build did
 * not produce, so the test is narrow and would rather miss an artifact than
 * invent one.
 */
const looksBuilt = (entry: string, mode: number): boolean =>
  process.platform === "win32"
    ? entry.endsWith(".exe") || entry.endsWith(".dll")
    : !entry.includes(".") && (mode & 0o111) !== 0;

/**
 * Every non-empty file under `buildDir` that looks built, each with its digest.
 *
 * An empty file is skipped: a zero-byte output is a build that did not finish
 * writing, and its digest would be the digest of nothing.
 */
export const discoverArtifacts = async (buildDir: string): Promise<readonly BuildArtifact[]> => {
  const { readdir, stat: statFile } = await import("node:fs/promises");
  const found: BuildArtifact[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let info;
      try {
        info = await statFile(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        if (isSkippedDirectory(entry)) continue;
        await walk(full, depth + 1);
        continue;
      }
      if (!looksBuilt(entry, info.mode) || info.size === 0) continue;
      let bytes: Buffer;
      try {
        bytes = await readFile(full);
      } catch {
        // A file the walk may stat but not read is not an artifact this tool
        // can describe; it is not a failed build. `readdir` and `stat` above
        // already take this view, and the caller's build succeeded.
        continue;
      }
      found.push({ path: full, bytes: info.size, digest: sha256(bytes) });
    }
  };
  await walk(buildDir, 0);
  return found;
};
