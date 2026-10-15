#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { REPO_ROOT } from "./lib/paths.mjs";
import { runExtractionSelfCheck, runSteps } from "./lib/runKeySpans.mjs";

/**
 * Fail when a test run replaces Vitest's reporters and forgets the skip list.
 *
 * `vitest.config.ts` registers two reporters: Vitest's own, and the one that
 * names every skipped test. A CLI `--reporter` flag **replaces** that list rather
 * than adding to it, so a step that passes `--reporter=default --reporter=blob`
 * silently loses the skip list and reports skips as a bare count. That is the
 * shape `docs/testing.md` forbids — a silent skip and a passing test look
 * identical in a summary — and it is invisible in the run itself: the lane is
 * green, the count is right, and only the reasons are gone.
 *
 * Three CI steps pass reporter flags today and all three name the skip reporter
 * back. This exists for the fourth, which will be written by copying one of them
 * and dropping the flag that was not obviously doing anything.
 *
 * ## What is scanned
 *
 * Every `run:` in `.github/workflows/` and in the composite actions under
 * `.github/actions/`, plus every script in `package.json`, since an `npm` script
 * carrying the flags has exactly the same effect as a step carrying them. The
 * config is checked the other way round: it owns the local run, so it is required
 * to still register the reporter at all — otherwise a local run loses the names
 * even though every CI step keeps them.
 *
 * ## The mini-parse, and why it is not a YAML dependency
 *
 * Reading `run:` scalars needs a YAML parser, and the repository has none. The
 * extraction itself lives in `lib/runKeySpans.mjs`, because `verify-actions.mjs`
 * needs the same answer to a different question — which lines are shell text and
 * which are workflow syntax — and one interpretation with two callers belongs in
 * one place. What this file owns is the reporter rule and what it is applied to.
 *
 * The forms covered are the forms a step is written in; a form that leaves an
 * empty command is one this scan **fails on** rather than skipping. That matters
 * because the natural bug here is the quiet one: an unrecognised form read as
 * "a step with nothing to check" is a reporter flag nobody looked at, and a check
 * that silently looks at less than it says is worse than no check.
 *
 * `ruleSelfCheck()` below, and the extraction self-check the library runs, both
 * run on every invocation. The failure mode of a check like this is not being
 * wrong on the day it is written; it is a rule that stops matching after an edit,
 * and a scan that then finds nothing wrong.
 *
 * Environment: none. Exit status 1 when a run drops the skip list.
 */

/** The module that names skipped tests. */
const SKIP_REPORTER = "vitest-skipped-reporter.mjs";
/** How every caller spells it: as a path relative to the repository root. */
const SKIP_REPORTER_REF = `./scripts/lib/${SKIP_REPORTER}`;
const SKIP_REPORTER_FILE = path.join(REPO_ROOT, "scripts", "lib", SKIP_REPORTER);

/**
 * A flag that replaces the test reporters.
 *
 * `--coverage.reporter` is a different option and leaves `test.reporters` alone,
 * which is why the `--` has to be adjacent to the word: the dot before `reporter`
 * in `--coverage.reporter=text` is what keeps this from matching it. `--reporters`
 * (plural, jscpd's) is excluded by the same requirement that the flag end or be
 * followed by `=` or whitespace.
 */
const REPORTER_FLAG = /(?:^|\s)--reporter(?:=|\s|$)/u;

const YAML_FILE = /\.ya?ml$/u;

/** Whether a command replaces the reporters without naming the skip reporter. */
const dropsSkipList = (command) => REPORTER_FLAG.test(command) && !command.includes(SKIP_REPORTER);

/**
 * The rule, against commands rather than against the repository.
 *
 * Each case is a command this repository writes or could plausibly write, and the
 * expectation is the verdict the scan must reach for it. A case that flips is a
 * rule that no longer means what the paragraphs above say it means.
 */
const RULE_CASES = [
  [
    `npm run test:fast -- --reporter=default --reporter=blob --reporter=${SKIP_REPORTER_REF}`,
    false,
  ],
  ["npm run test:fast -- --reporter=default --reporter=blob", true],
  ["npm run test:built -- --reporter=default --shard=1/3 --reporter=blob", true],
  ["npx --no-install stryker run", false],
  ["vitest run --coverage.enabled --coverage.reporter=text --coverage.reporter=lcov", false],
  ["jscpd src/ tests/ --reporters console,json --output .cache/static-checks/jscpd", false],
  [
    `vitest --merge-reports --reporter=default --reporter=junit --reporter=${SKIP_REPORTER_REF}`,
    false,
  ],
  ["vitest --merge-reports --reporter=default --reporter=junit", true],
  ["npm run test:fast", false],
  // The flag on a continuation line, which is how the merge step writes it.
  ["npm exec -- vitest --merge-reports \\\n  --reporter=default \\\n  --reporter=junit", true],
];

const ruleSelfCheck = () => {
  const wrong = [];
  for (const [command, expected] of RULE_CASES) {
    const actual = dropsSkipList(command);
    if (actual !== expected) {
      wrong.push(
        `${JSON.stringify(command)}\n      expected drops=${String(expected)}, got drops=${String(actual)}`,
      );
    }
  }
  if (wrong.length > 0) {
    console.error(
      "The reporter rule no longer decides these commands the way this file says it does:\n" +
        wrong.map((line) => `  ${line}`).join("\n") +
        "\n",
    );
    process.exit(1);
  }
};

/** Every `.yml`/`.yaml` directly inside one directory. */
const yamlFilesIn = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && YAML_FILE.test(entry.name))
    .map((entry) => path.join(directory, entry.name));
};

/**
 * The files under `.github/` that a job can reach a `run:` through.
 *
 * Workflows define the steps; a composite action defines steps that a workflow
 * step pulls in with `uses:`, so a reporter flag in one is the same defect one
 * level down. Both are read, and a directory that cannot be listed throws rather
 * than contributing nothing — a scan that read fewer files than exist must not
 * look like a scan that read them all.
 */
const githubFiles = async () => {
  const actionsRoot = path.join(REPO_ROOT, ".github", "actions");
  const found = await yamlFilesIn(path.join(REPO_ROOT, ".github", "workflows"));
  for (const entry of await readdir(actionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    found.push(...(await yamlFilesIn(path.join(actionsRoot, entry.name))));
  }
  return found.sort();
};

const relative = (file) => path.relative(REPO_ROOT, file).split(path.sep).join("/");

/**
 * The reporters a *default* run would use, asked of Vitest's config loader.
 *
 * The config's text is right here and a `reporters: [...]` match would be ten
 * characters shorter, but the config imports the reporter and instantiates it in
 * place, and a text match cannot tell "registered" from "imported and then left
 * out of the array" — which is the first thing an edit that breaks this produces,
 * and the one that would make this check lie about it. Asking the loader costs a
 * quarter of a second and answers the question the check is actually about.
 *
 * Reporters are compared by class **name**, not with `instanceof`: the config is
 * loaded through Vite's module graph, so the class in the resolved config is not
 * the same object as the one this file imports and `instanceof` is false for a
 * reporter registered exactly as intended. That was measured, not assumed.
 */
const resolvedReporters = async () => {
  const { createVitest } = await import("vitest/node");
  const vitest = await createVitest("test", { watch: false });
  try {
    return (vitest.config?.reporters ?? []).flat(Infinity);
  } finally {
    await vitest.close();
  }
};

/**
 * Fail when a default run's reporters no longer name skipped tests.
 *
 * Skipped entirely when the module is missing, which is already a problem above
 * and would make the config fail to load for the same reason — one cause reported
 * once is what a reader can act on.
 */
const checkResolvedReporters = async (report) => {
  if (!existsSync(SKIP_REPORTER_FILE)) return;
  // Imported by absolute URL rather than by a second relative spelling of the
  // same path: the class name is the whole comparison, and it must come from the
  // file every `--reporter` flag points at.
  const { default: SkippedTestsReporter } = await import(pathToFileURL(SKIP_REPORTER_FILE).href);
  let reporters;
  try {
    reporters = await resolvedReporters();
  } catch (error) {
    report.note(
      `vitest.config.ts could not be loaded, so its reporters are unknown: ${error.message}`,
    );
    return;
  }
  const names = reporters.map(
    (reporter) => reporter?.constructor?.name ?? Object.prototype.toString.call(reporter),
  );
  if (!names.includes(SkippedTestsReporter.name)) {
    report.drop(
      `vitest.config.ts resolves to reporters [${names.join(", ")}] and not one of them is ` +
        `${SkippedTestsReporter.name}, so a local run — and any CI step that passes no ` +
        "--reporter flags of its own — prints skips as a count with no names.",
    );
  }
};

const main = async () => {
  ruleSelfCheck();
  runExtractionSelfCheck();

  const problems = [];
  // The remedy below is about `--reporter` flags, so it is printed only when a
  // flag is what went wrong. An unreadable `run:` and a renamed module are
  // reported by their own message and would be answered by nothing in it.
  let droppedSkipList = false;
  const report = {
    drop: (message) => {
      droppedSkipList = true;
      problems.push(message);
    },
    note: (message) => problems.push(message),
  };
  const remedy =
    `Add \`--reporter=${SKIP_REPORTER_REF}\` to the flags, or drop the flags and let ` +
    "vitest.config.ts decide.";

  if (!existsSync(SKIP_REPORTER_FILE)) {
    report.note(
      `${SKIP_REPORTER_REF} does not exist. Every \`--reporter\` flag in this repository ` +
        "points at it, so renaming it has to reach all of them.",
    );
  }

  let files;
  try {
    files = await githubFiles();
  } catch (error) {
    console.error(`Cannot list the workflows and actions under .github/: ${error.message}\n`);
    process.exit(1);
  }
  if (files.length === 0) {
    // Not a pass: a scan that read nothing has established nothing.
    console.error("No workflow or action file was found under .github/; nothing was checked.\n");
    process.exit(1);
  }

  let replaced = 0;
  for (const file of files) {
    for (const step of runSteps(await readFile(file, "utf8"))) {
      if (step.command.trim() === "") {
        // A `run:` the extraction could not read. Failing here is the whole
        // difference between a check that covers the forms it names and one that
        // reads an unfamiliar form as a step with nothing in it.
        report.note(
          `${relative(file)}:${String(step.line)} has a \`run:\` value this check cannot read — ` +
            "a quoted scalar that runs past its line, or no value at all — so any reporter flag " +
            "in it would be missed. Write the command as a single line, as a `|`/`>` block, or " +
            "with its value on the line below the key.",
        );
        continue;
      }
      if (!REPORTER_FLAG.test(step.command)) continue;
      replaced += 1;
      if (dropsSkipList(step.command)) {
        report.drop(
          `${relative(file)}:${String(step.line)} passes its own --reporter flags without ` +
            `${SKIP_REPORTER_REF}, so the skips in that run are a count with no names.`,
        );
      }
    }
  }

  const manifest = JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
  let scripted = 0;
  for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
    if (typeof command !== "string" || !REPORTER_FLAG.test(command)) continue;
    scripted += 1;
    if (dropsSkipList(command)) {
      report.drop(
        `package.json: the "${name}" script passes its own --reporter flags without ` +
          `${SKIP_REPORTER_REF}.`,
      );
    }
  }

  await checkResolvedReporters(report);

  if (problems.length > 0) {
    console.error("A test run would report its skips without naming them.\n");
    for (const problem of problems) console.error(`  ${problem}\n`);
    if (droppedSkipList) console.error(`${remedy}\n`);
    process.exit(1);
  }

  console.log(
    `reporter flags: ${String(replaced)} step(s) across ${String(files.length)} file(s) under ` +
      `.github/ and ${String(scripted)} script(s) in package.json set their own reporters, and ` +
      "every one keeps the skip list; the resolved vitest.config.ts reporters include it",
  );
};

await main();
