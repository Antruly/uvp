#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import path from "node:path";

import { ALL_TEST_PROJECTS } from "./lib/test-projects.mjs";
import { REPO_ROOT } from "./lib/paths.mjs";

/**
 * Fail when a test file on disk runs in no Vitest project.
 *
 * A test that belongs to no project is not a failing test — it is a test that
 * never runs, and its absence from the suite is invisible in every report. The
 * usual cause is a new directory that no `include` pattern covers, which is
 * exactly the moment the file is most likely to be wrong.
 *
 * The other direction is checked too: a file claimed by two projects runs twice,
 * once per project, which doubles the cost of the slowest tests and makes a
 * failure count ambiguous.
 */

const SEARCH_ROOTS = ["src", "tests"];
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "fixtures", ".vitepress", "coverage"]);
const TEST_FILE = /\.test\.ts$/u;

/**
 * Translate the small glob dialect used by `scripts/lib/test-projects.mjs`.
 *
 * Supporting `**`, `*`, and `{a,b}` is enough for the patterns that exist, and a
 * hand-written matcher is preferable to a dependency that has to agree with
 * Vitest's own — if the two disagreed, this script would report a discovery
 * problem that does not exist.
 */
const globToRegExp = (glob) => {
  let pattern = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        // `**/` matches zero or more directories; a bare `**` matches anything.
        if (glob[index + 2] === "/") {
          pattern += "(?:[^/]+/)*";
          index += 2;
        } else {
          pattern += ".*";
          index += 1;
        }
      } else {
        pattern += "[^/]*";
      }
      continue;
    }
    if (char === "{") {
      const end = glob.indexOf("}", index);
      if (end === -1) throw new Error(`Unbalanced brace in glob: ${glob}`);
      const alternatives = glob
        .slice(index + 1, end)
        .split(",")
        .map((part) => part.replaceAll(/[.+^${}()|[\]\\]/gu, "\\$&"));
      pattern += `(?:${alternatives.join("|")})`;
      index = end;
      continue;
    }
    pattern += char.replaceAll(/[.+^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`^${pattern}$`, "u");
};

const collect = async (directory, found = []) => {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return found;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      await collect(path.join(directory, entry.name), found);
    } else if (TEST_FILE.test(entry.name)) {
      found.push(
        path.relative(REPO_ROOT, path.join(directory, entry.name)).split(path.sep).join("/"),
      );
    }
  }
  return found;
};

const files = [];
for (const root of SEARCH_ROOTS) await collect(path.join(REPO_ROOT, root), files);
files.sort();

const claims = ALL_TEST_PROJECTS.map((project) => ({
  name: project.name,
  // Every pattern, not just the first. `vitest.config.ts` spreads the whole
  // array, so a project with two `include` entries runs files this script would
  // otherwise call unclaimed — and its remedy, "move the file", would be wrong
  // advice about a file that runs perfectly well.
  match: project.include.map(globToRegExp),
  exclude: (project.exclude ?? []).map(globToRegExp),
}));

const claimsFile = (claim, file) =>
  claim.match.some((re) => re.test(file)) && !claim.exclude.some((re) => re.test(file));

const unclaimed = [];
const duplicated = [];

for (const file of files) {
  const owners = claims.filter((claim) => claimsFile(claim, file)).map((claim) => claim.name);

  if (owners.length === 0) unclaimed.push(file);
  else if (owners.length > 1) duplicated.push({ file, owners });
}

const problems = [];
if (unclaimed.length > 0) {
  problems.push(
    `${unclaimed.length} test file(s) belong to no project and will never run:\n` +
      unclaimed.map((file) => `  ${file}`).join("\n") +
      "\nAdd an `include` pattern to scripts/lib/test-projects.mjs, or move the file.",
  );
}
if (duplicated.length > 0) {
  problems.push(
    `${duplicated.length} test file(s) are claimed by more than one project:\n` +
      duplicated.map(({ file, owners }) => `  ${file} -> ${owners.join(", ")}`).join("\n") +
      "\nNarrow one project's `exclude` so each file runs exactly once.",
  );
}

if (problems.length > 0) {
  console.error("Test discovery is inconsistent.\n");
  for (const problem of problems) console.error(`${problem}\n`);
  process.exit(1);
}

const byProject = claims.map(
  (claim) => `${claim.name}=${files.filter((file) => claimsFile(claim, file)).length}`,
);
console.log(
  `test discovery: ${files.length} file(s) across ${claims.length} project(s)\n  ${byProject.join("  ")}`,
);
