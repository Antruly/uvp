#!/usr/bin/env node
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { REPO_ROOT } from "./lib/paths.mjs";

/**
 * Remove build output.
 *
 * `npm run compile` runs this first. Compiling into a `dist/` that still holds
 * files from an earlier build is how a deleted module keeps being importable —
 * the build reports success, the test suite passes, and the failure only appears
 * for someone who checks out fresh. The cost is a full rebuild instead of an
 * incremental one, which is the right trade for a 200-file project.
 *
 * Only output is removed. Files that are generated and committed — the tool
 * catalog, the skill, the error schema — are left alone, because deleting them
 * would make a clean build look like a dirty working tree.
 */

/**
 * What is removed, and the parts of it that are kept.
 *
 * `native-probe` is the one exception, and it is not a cache. `npm run
 * build:native-probe` compiles a C++ program there against a libuvcpp install
 * with its C ABI enabled — expensive to produce, and impossible to produce at all
 * on a host without that install. Every compile would otherwise delete it, and
 * the consequence would be invisible: the `toolchain` lane that probes with that
 * binary skips with a reason, which reads as "this host has no probe" rather than
 * "the last command you ran deleted the one you built". Everything else under
 * `.cache` is cheap to regenerate, so this stays a wipe with one named hole in it
 * rather than a list of things to keep.
 */
const TARGETS = [
  { path: "dist" },
  { path: "coverage" },
  { path: "reports" },
  { path: ".cache", keep: ["native-probe"] },
  { path: "docs/.vitepress/cache" },
  { path: "docs/.vitepress/dist" },
  { path: "*.tsbuildinfo" },
];

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  console.log(`Usage: node scripts/clean-build-output.mjs [--dry-run]

Removes: ${TARGETS.map((target) => target.path).join(", ")}
Keeps:   ${TARGETS.flatMap((target) => (target.keep ?? []).map((kept) => `${target.path}/${kept}`)).join(", ")}`);
  process.exit(0);
}

for (const target of TARGETS) {
  const resolved = path.join(REPO_ROOT, target.path);
  const keep = new Set(target.keep ?? []);
  if (values["dry-run"]) {
    console.log(
      `would remove ${target.path}${keep.size === 0 ? "" : ` (keeping ${[...keep].join(", ")})`}`,
    );
    continue;
  }
  if (keep.size === 0) {
    await rm(resolved, { recursive: true, force: true });
    continue;
  }
  // A directory that is not there is not a failure: this runs before a build,
  // which is exactly when a fresh checkout has nothing to remove.
  const entries = await readdir(resolved).catch(() => []);
  for (const entry of entries) {
    if (keep.has(entry)) continue;
    await rm(path.join(resolved, entry), { recursive: true, force: true });
  }
}
