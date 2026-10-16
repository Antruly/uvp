#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { BUILT_PROJECT_NAMES, SOURCE_PROJECT_NAMES } from "./lib/test-projects.mjs";
import { REPO_ROOT } from "./lib/paths.mjs";

/**
 * Run a group of Vitest projects, named from the shared lane list.
 *
 * The groups used to be spelled out as `--project` flags in `package.json`, which
 * meant the lane list lived in two places and only one of them was the source of
 * truth. Adding a lane to `scripts/lib/test-projects.mjs` therefore did not add it
 * to `npm run test:fast` — the new lane ran under `npm test` and was silently
 * skipped by the command a developer actually runs while iterating, which is the
 * one place a lane most needs to run.
 *
 * Usage: `node scripts/run-tests.mjs <source|built|all> [--except <lane>]… [extra args…]`
 * Anything after the group is passed through, so `--watch` and a filename filter
 * work as they would with a direct `vitest` call.
 *
 * `--except` exists for `toolchain`, which needs a real libuvcpp on the host and
 * so is its own CI job rather than part of `test:built`. Naming the exclusion
 * here keeps the reason next to the list instead of in a second hardcoded list
 * that has to be kept in step with this one. `--only` is the same idea for a
 * single lane: it stays valid when the lane list changes, where an enumerated
 * `--project` flag does not.
 *
 * The Vitest CLI is resolved from Vitest's own manifest and run through the Node
 * already running this script, rather than spawned from `node_modules/.bin`.
 * That path is the obvious one and works on Linux and macOS; on Windows there is
 * no file there to execute, so the Windows lane would die before loading a test
 * file and the failure would look like a broken suite rather than a wrong path.
 */

const require = createRequire(import.meta.url);

/**
 * The Vitest entry point this install provides, resolved rather than assumed.
 *
 * Same reasoning as `scripts/lint.mjs`'s oxlint resolution: the package's own
 * manifest says where its binary is, so a layout change moves both together and
 * `knip` still sees the dependency being used. Spawning the path directly is not
 * enough either — the file behind it is a script with a shebang, which Windows
 * cannot start — so callers run it through `process.execPath`.
 */
const resolveVitest = () => {
  try {
    const manifest = require.resolve("vitest/package.json");
    const { bin } = JSON.parse(readFileSync(manifest, "utf8"));
    return path.join(path.dirname(manifest), typeof bin === "string" ? bin : bin.vitest);
  } catch (error) {
    console.error(`Cannot resolve vitest: ${error.message}`);
    console.error("Install first: npm ci");
    process.exit(2);
  }
};

const VITEST = resolveVitest();

const GROUPS = {
  source: SOURCE_PROJECT_NAMES,
  built: BUILT_PROJECT_NAMES,
  all: [...SOURCE_PROJECT_NAMES, ...BUILT_PROJECT_NAMES],
};

const argv = process.argv.slice(2);
const group = argv.shift();
const except = new Set();
const only = new Set();
const rest = [];
const OPTIONS = { "--except": except, "--only": only };
for (let index = 0; index < argv.length; index += 1) {
  const token = argv[index];
  const target = OPTIONS[token];
  if (target !== undefined) {
    const name = argv[index + 1];
    if (name === undefined) {
      console.error(`${token} needs a project name.`);
      process.exit(2);
    }
    target.add(name);
    index += 1;
    continue;
  }
  rest.push(token);
}

const groupProjects = GROUPS[group];

if (groupProjects === undefined) {
  console.error(`Unknown group "${group ?? ""}". Use one of: ${Object.keys(GROUPS).join(", ")}.`);
  process.exit(2);
}

// A name that is not in the group is a typo, and accepting it would either leave
// a lane the caller meant to skip running after all, or select nothing at all.
const strays = [...except, ...only].filter((name) => !groupProjects.includes(name));
if (strays.length > 0) {
  console.error(
    `${strays.join(", ")} is not in the "${group}" group, so it cannot be selected or excluded from it.`,
  );
  process.exit(2);
}
if (except.size > 0 && only.size > 0) {
  console.error("--except and --only are different questions; pass one or the other.");
  process.exit(2);
}

const projects =
  only.size > 0
    ? groupProjects.filter((name) => only.has(name))
    : groupProjects.filter((name) => !except.has(name));

if (projects.length === 0) {
  // Refusing beats running nothing and exiting 0, which would read as "the lane
  // passed" in a CI log.
  console.error(`The "${group}" group is empty, so there is nothing to run.`);
  process.exit(2);
}

const projectFlags = projects.flatMap((name) => ["--project", name]);
const result = spawnSync(process.execPath, [VITEST, "run", ...projectFlags, ...rest], {
  cwd: REPO_ROOT,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
