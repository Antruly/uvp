#!/usr/bin/env node
import { rm } from "node:fs/promises";
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

const TARGETS = [
  "dist",
  "coverage",
  "reports",
  ".cache",
  "docs/.vitepress/cache",
  "docs/.vitepress/dist",
  "*.tsbuildinfo",
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

Removes: ${TARGETS.join(", ")}`);
  process.exit(0);
}

for (const target of TARGETS) {
  const resolved = path.join(REPO_ROOT, target);
  if (values["dry-run"]) {
    console.log(`would remove ${target}`);
    continue;
  }
  await rm(resolved, { recursive: true, force: true });
}
