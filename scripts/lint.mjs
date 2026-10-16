#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { DIST_DIR, REPO_ROOT } from "./lib/paths.mjs";

/**
 * Run oxlint, and when it fails, print the state of the tree as it failed.
 *
 * `oxlint` has failed a gate three times with `Failed to open file
 * …/dist/… with error "No such file or directory (os error 2)"`, and the three
 * logs that survive say nothing about where that path came from, or what else was
 * running. Six tests of four candidate mechanisms found nothing, so the next
 * occurrence is worth more than a seventh guess — but only if it arrives with
 * evidence attached.
 *
 * The report below is that evidence, collected at the moment of failure rather
 * than reconstructed afterwards: the argv oxlint was handed, whether `dist/`
 * exists and how long ago it was written, what the named paths look like now, and
 * which builds were alive in this repository. It goes to stderr, after oxlint's
 * own output, and only on a non-zero exit — a passing run costs one process and
 * prints nothing new.
 *
 * What it cannot do: it sees a read that failed, not the read that asked for the
 * path. If the next occurrence names a path whose directory listing was taken
 * before `compile` rewrote `dist/`, this says so; if it names one that was never
 * in the walk, this says only that it was absent at the time. Neither is a
 * diagnosis, and the row stays open either way.
 */

const require = createRequire(import.meta.url);

/**
 * The oxlint this install provides, resolved rather than assumed.
 *
 * `node_modules/.bin/oxlint` is the obvious path, and it is the one npm puts on
 * `PATH` for a script that names the binary. Reaching it through the package's own
 * manifest instead is what lets `knip` see that this repository still uses its
 * `oxlint` devDependency: the dependency is read from what the code resolves, and
 * a binary started through a path nothing follows reads as unused.
 */
const resolveOxlint = () => {
  try {
    const manifest = require.resolve("oxlint/package.json");
    const { bin } = JSON.parse(readFileSync(manifest, "utf8"));
    return path.join(path.dirname(manifest), typeof bin === "string" ? bin : bin.oxlint);
  } catch (error) {
    console.error(`Cannot resolve oxlint: ${error.message}`);
    console.error("Install first: npm ci");
    process.exit(2);
  }
};

const OXLINT = resolveOxlint();

/** How many entries of a listing to print before saying how many were left. */
const LISTING_LIMIT = 8;

/**
 * What the build processes in this repository are called.
 *
 * This filter exists so the report is readable on a developer's machine, where a
 * bare `ps` matches an editor's language servers and a dozen background shells.
 * The question the list answers is narrow — was a build writing `dist/` while this
 * ran — so it shows the processes that could have been, and says nothing about the
 * rest. CI's dedicated runner has no others.
 */
const BUILD_COMMANDS = /\b(tsc|clean-build-output|turbo|oxlint|vitest|lint\.mjs|npm|node)\b/;

const describe = (target) => {
  try {
    const stats = statSync(target);
    return {
      exists: true,
      mtime: new Date(stats.mtimeMs).toISOString(),
      ageSeconds: Math.round((Date.now() - stats.mtimeMs) / 1000),
      size: stats.size,
    };
  } catch (error) {
    return { exists: false, reason: error.code ?? error.message };
  }
};

/** One `path: facts` line, relative to the repository root. */
const describeLine = (target) => {
  const facts = describe(target);
  const relative = path.relative(REPO_ROOT, target) || ".";
  const said = facts.exists
    ? `mtime ${facts.mtime} (${facts.ageSeconds}s ago), ${facts.size} bytes`
    : `absent now (${facts.reason})`;
  return `  ${relative}: ${said}`;
};

/** The newest files under `dist/`, so a write that just happened leads the list. */
const distListing = () => {
  const found = [];
  const walk = (directory, depth) => {
    if (depth > 4) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else found.push(full);
    }
  };
  try {
    walk(DIST_DIR, 0);
  } catch (error) {
    return [`  dist/ unreadable: ${error.code ?? error.message}`];
  }
  found.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  const shown = found.slice(0, LISTING_LIMIT).map(describeLine);
  if (found.length > shown.length) {
    shown.push(`  … ${found.length - shown.length} more files not shown`);
  }
  return shown.length === 0 ? ["  dist/ holds no files"] : shown;
};

/**
 * The build processes alive in this repository at failure time.
 *
 * The three logs prove `compile` runs beside `lint` in the task graph; they do not
 * prove it was running in the runs that failed, because both logs are summaries
 * written after the fact. A snapshot taken here answers that for the run in hand —
 * and "nothing was running" is an answer too, since it means `compile` had already
 * finished or had not started.
 *
 * Only `/proc` knows a process's working directory, so on a platform without it
 * this reports that it could not look rather than an empty list, which would read
 * as "no build was running".
 */
const processSnapshot = () => {
  if (process.platform !== "linux") {
    return [`  process list unavailable: no /proc on ${process.platform}`];
  }
  const startedAt = (pid) => {
    const stats = readFileSync(`/proc/${pid}/stat`, "utf8");
    // `comm` is parenthesised and may itself contain spaces, so the fields are
    // counted from after the last `)`. Field 22 is `starttime`, in clock ticks
    // since boot; every Linux this runs on reports 100 of them per second.
    const fields = stats.slice(stats.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(fields[19]);
    const uptime = Number.parseFloat(readFileSync("/proc/uptime", "utf8"));
    return Number.isFinite(ticks) ? Math.round(uptime - ticks / 100) : undefined;
  };
  const parent = (pid) => {
    const stats = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stats.slice(stats.lastIndexOf(")") + 2).split(" ")[1];
  };
  // This script, the shell npm spawned around it, and whatever launched them.
  // Those are the lint run itself; what the list is for is the build running
  // beside it, which is a sibling of this process rather than an ancestor.
  const skip = new Set();
  for (let pid = String(process.pid), hops = 0; pid && pid !== "0" && hops < 16; hops += 1) {
    skip.add(pid);
    pid = parent(pid);
  }
  const found = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry) || skip.has(entry)) continue;
    let cwd;
    try {
      cwd = readlinkSync(`/proc/${entry}/cwd`);
    } catch {
      continue; // Another user's process, or one that exited while listing.
    }
    if (cwd !== REPO_ROOT && !cwd.startsWith(`${REPO_ROOT}${path.sep}`)) continue;
    const command = readFileSync(`/proc/${entry}/cmdline`, "utf8")
      .split("\0")
      .filter(Boolean)
      .join(" ");
    if (!BUILD_COMMANDS.test(command)) continue;
    const age = startedAt(entry);
    const where = path.relative(REPO_ROOT, cwd) || ".";
    found.push(
      `  pid ${entry}, ${age === undefined ? "age unknown" : `${age}s old`}, in ${where}: ` +
        command.slice(0, 160),
    );
  }
  return found.length === 0 ? ["  no build process was running in this repository"] : found;
};

const version = (binary, args) => {
  const result = spawnSync(binary, args, { encoding: "utf8" });
  if (result.error) return `unavailable (${result.error.message})`;
  return (result.stdout ?? result.stderr ?? "").trim().split("\n")[0] || "no version reported";
};

/** Every path the run named as one it could not open. */
const namedOpenFailures = (output) => {
  const paths = new Set();
  for (const match of output.matchAll(/Failed to open file (\S+) with error/g)) {
    paths.add(match[1]);
  }
  return [...paths];
};

const args = process.argv.slice(2);
const run = spawnSync(OXLINT, args, { cwd: REPO_ROOT, encoding: "utf8" });
if (run.error) {
  console.error(`Cannot run ${OXLINT}: ${run.error.message}`);
  console.error("Install first: npm ci");
  process.exit(2);
}
process.stdout.write(run.stdout ?? "");
process.stderr.write(run.stderr ?? "");
const status = run.status ?? 1;
if (status === 0) process.exit(0);

const named = namedOpenFailures(`${run.stdout ?? ""}${run.stderr ?? ""}`);
console.error(
  [
    "",
    "uvp lint: oxlint failed, so here is the tree as it failed.",
    `  argv:    ${args.length === 0 ? "(no arguments)" : args.join(" ")}`,
    `  cwd:     ${REPO_ROOT}`,
    `  when:    ${new Date().toISOString()}`,
    `  oxlint:  ${version(OXLINT, ["--version"])}`,
    `  node:    ${process.version}`,
    describeLine(DIST_DIR),
    named.length === 0
      ? "  this output named no file it could not open"
      : "  named as unopenable, and what they are now:",
    ...named.map((target) => describeLine(path.resolve(REPO_ROOT, target))),
    "  dist/, newest first:",
    ...distListing(),
    "  build processes in this repository:",
    ...processSnapshot(),
  ].join("\n"),
);
process.exit(status);
