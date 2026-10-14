import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { REPO_ROOT } from "./paths.mjs";

/**
 * Helpers for files that are derived from source and committed anyway.
 *
 * A generated file that is committed can go stale, and a stale generated file is
 * worse than a missing one: it looks authoritative. Every generator therefore
 * runs in one of two modes — write, or check — and CI always uses check. A
 * difference is a build failure with the diff printed, not a review comment
 * somebody has to remember to leave.
 */

export const BANNER = "// Generated file. Do not edit by hand; run `npm run docs:generate`.";

export const repositoryPath = (relative) => path.join(REPO_ROOT, relative);

/**
 * Compare `contents` against the file at `relative`, or write it.
 *
 * Returns `{ changed, missing }` for check mode and `{ changed: true }` for
 * write mode, so a caller can report a summary rather than exiting on the first
 * difference.
 */
export const emitGeneratedFile = async ({ relative, contents, check }) => {
  const target = repositoryPath(relative);
  const normalised = contents.endsWith("\n") ? contents : `${contents}\n`;

  if (check) {
    let existing;
    try {
      existing = await readFile(target, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return { changed: true, missing: true, relative };
      throw error;
    }
    if (existing === normalised) return { changed: false, missing: false, relative };
    return { changed: true, missing: false, relative, existing, expected: normalised };
  }

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, normalised, "utf8");
  return { changed: true, missing: false, relative };
};

/**
 * Print the first differing lines of a stale generated file.
 *
 * Printing the whole file is useless in CI output; the first few differing lines
 * are usually enough to see whether the change is real or a formatting slip.
 */
export const reportDifference = (result, lines = 12) => {
  if (result.missing) {
    console.error(`  missing: ${result.relative}`);
    return;
  }
  console.error(`  stale:   ${result.relative}`);
  const before = result.existing.split("\n");
  const after = result.expected.split("\n");
  const limit = Math.max(before.length, after.length);
  let printed = 0;
  for (let index = 0; index < limit && printed < lines; index += 1) {
    if (before[index] === after[index]) continue;
    console.error(`    line ${index + 1}`);
    console.error(`      on disk:  ${JSON.stringify(before[index] ?? null)}`);
    console.error(`      expected: ${JSON.stringify(after[index] ?? null)}`);
    printed += 1;
  }
};

/** Turn a list of check results into an exit code and a readable summary. */
export const finishCheck = (results, { label }) => {
  const stale = results.filter((result) => result.changed);
  if (stale.length === 0) {
    console.log(`${label}: ${results.length} file(s) up to date.`);
    return 0;
  }
  console.error(`${label}: ${stale.length} of ${results.length} file(s) out of date.`);
  for (const result of stale) reportDifference(result);
  console.error("Run `npm run docs:generate` and commit the result.");
  return 1;
};
