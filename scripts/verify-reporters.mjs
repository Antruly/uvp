#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { REPO_ROOT } from "./lib/paths.mjs";

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
 * Reading `run:` scalars needs a YAML parser, and the repository has none. What
 * is needed here is narrower than YAML: the text of each `run:` key's value, in
 * the two forms a step uses — a single-line scalar, and a `|` or `>` block whose
 * lines are indented past the key. A block's lines are consumed as they are
 * collected, so a line inside a shell script that happens to read `run:` cannot
 * be mistaken for a step.
 *
 * The two forms are the whole of the coverage, and a form neither covers while
 * looking like a `run:` key leaves an empty command — which the scan **fails on**
 * rather than skipping. That matters because the natural bug here is the quiet
 * one: an unrecognised form read as "a step with nothing to check" is a reporter
 * flag nobody looked at, and a check that silently looks at less than it says is
 * worse than no check. A `run:` with no command is also invalid in a workflow, so
 * there is no legitimate empty case to preserve.
 *
 * `ruleSelfCheck()` and `extractionSelfCheck()` below run on every invocation.
 * The failure mode of a check like this is not being wrong on the day it is
 * written; it is a rule that stops matching after an edit, and a scan that then
 * finds nothing wrong.
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

const STEP_KEY = /^(?<indent>[ \t]*)(?:-[ \t]+)?run:[ \t]?(?<rest>.*)$/u;
const BLOCK_SCALAR = /^[|>][+\-\d]*$/u;
const YAML_FILE = /\.ya?ml$/u;

const indentOf = (line) => line.length - line.trimStart().length;

/**
 * Every `run:` value in one workflow or action file, with the line it starts on.
 *
 * Three forms are read, because they are the three a step is written in: a
 * single-line scalar, a `|`/`>` block, and a plain scalar whose value starts on
 * the line below the key. A fourth — a quoted scalar spanning lines — is reported
 * as an empty command rather than truncated at its first line, since a value read
 * up to a line break is a command this check would search for a flag in and not
 * find, which is the silent miss all of this exists to avoid. The caller turns an
 * empty command into a failure; `runSteps` itself does not decide.
 *
 * Blank lines do not end a block: a shell command may contain them, and the only
 * reliable terminator is a line indented less than the key. For the plain-scalar
 * form the lines are folded with spaces, which is what YAML does with them; for a
 * block they are kept as written. Neither difference can hide a flag, which is
 * never the line break and never the indentation.
 */
const runSteps = (text) => {
  const lines = text.split("\n");
  const steps = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = STEP_KEY.exec(lines[index]);
    if (match === null) continue;

    const keyIndent = match[0].indexOf("run:");
    const rest = match.groups.rest.trim();
    const block = BLOCK_SCALAR.test(rest);

    if (block || rest === "") {
      const body = [];
      let cursor = index + 1;
      for (; cursor < lines.length; cursor += 1) {
        const line = lines[cursor];
        if (line.trim() === "") continue;
        if (indentOf(line) <= keyIndent) break;
        body.push(block ? line : line.trim());
      }
      steps.push({ line: index + 1, command: body.join(block ? "\n" : " ") });
      index = cursor - 1;
      continue;
    }

    // YAML reads a leading quote as the start of a quoted scalar, and one of
    // those can run past the line. An unbalanced quote here is therefore a
    // command whose remainder this file cannot see.
    const quote = rest[0];
    const unreadable = (quote === '"' || quote === "'") && !rest.endsWith(quote);
    steps.push({ line: index + 1, command: unreadable ? "" : rest });
  }
  return steps;
};

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

/**
 * A file to extract from, and the commands it must yield, trimmed.
 *
 * The case worth having is the third: a shell script whose *content* opens a line
 * with `run:`. If the scan re-entered a block it had already collected, it would
 * count another step here — and in a real workflow that is how a flag gets
 * attributed to the wrong command, which is the only way a check like this fails
 * quietly. The fourth is where a block ends: at the first line indented less than
 * its key, which is the line after it. The fifth and sixth are the forms a step
 * takes besides `|` — a folded `>-` block, which is a block like any other, and a
 * single-line scalar, which follows one. The seventh is the plain scalar, whose
 * value begins on the line below the key. The eighth is a quoted scalar that runs
 * past its line: it must come back empty, because `main` fails on an empty
 * command and that is what keeps a truncated read from looking like a read.
 */
const EXTRACTION_FIXTURE = [
  "      - run: npm ci",
  "      - name: Run the source tests",
  "        run: |",
  "          npm run test:fast -- --reporter=default",
  "            --reporter=./scripts/lib/vitest-skipped-reporter.mjs",
  "      - name: A shell script that is not a step",
  "        run: |",
  "          cat <<'EOF' > /tmp/x",
  "          run: echo hi",
  "          EOF",
  "      - name: A block that ends early",
  "        run: |",
  "          npm run test:built",
  "      - run: >-",
  "          npm run lint",
  "      - run: npm run docs:build",
  "      - name: A value on the line below the key",
  "        run:",
  "          npm run test:toolchain -- --reporter=blob",
  "            --reporter=./scripts/lib/vitest-skipped-reporter.mjs",
  "      - name: A scalar that runs past its line",
  '        run: "npm run test:built',
  '          --reporter=blob"',
].join("\n");

const EXTRACTION_EXPECTED = [
  "npm ci",
  [
    "npm run test:fast -- --reporter=default",
    "--reporter=./scripts/lib/vitest-skipped-reporter.mjs",
  ],
  ["cat <<'EOF' > /tmp/x", "run: echo hi", "EOF"],
  "npm run test:built",
  "npm run lint",
  "npm run docs:build",
  "npm run test:toolchain -- --reporter=blob --reporter=./scripts/lib/vitest-skipped-reporter.mjs",
  "",
].map((command) => [command].flat().join("\n"));

const extractionSelfCheck = () => {
  const commands = runSteps(EXTRACTION_FIXTURE).map((step) =>
    step.command
      .split("\n")
      .map((line) => line.trim())
      .join("\n"),
  );
  const same =
    commands.length === EXTRACTION_EXPECTED.length &&
    commands.every((command, index) => command === EXTRACTION_EXPECTED[index]);
  if (!same) {
    const detail =
      commands.length === EXTRACTION_EXPECTED.length
        ? "the same number of steps, but not the same commands"
        : `${String(EXTRACTION_EXPECTED.length)} step(s) expected, ${String(commands.length)} read`;
    // Both lists, because "expected 8, got 8" is the shape a reader cannot act on
    // and the difference is always in one line of one of them.
    console.error(
      `The \`run:\` extraction no longer reads this file's own fixture: ${detail}\n` +
        "  read:\n" +
        commands.map((command) => `    ${JSON.stringify(command)}`).join("\n") +
        "\n  expected:\n" +
        EXTRACTION_EXPECTED.map((command) => `    ${JSON.stringify(command)}`).join("\n") +
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
  extractionSelfCheck();

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
