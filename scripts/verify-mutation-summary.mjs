#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { REPO_ROOT } from "./lib/paths.mjs";

/**
 * Fail when the sweep summary stops reporting what its kills rest on.
 *
 * `scripts/ci/mutation-summary.mjs` prints, beside the score, how many kills carry
 * the suite's own summary in their `statusReason` — the measurement that makes the
 * score's upward bias a number in the run rather than a sentence in two documents
 * ([#42](https://github.com/Antruly/uvp/issues/42)). Nothing in the weekly job can
 * tell whether that line is still true: the sweep takes 52 minutes, its report
 * arrives once a week, and a classification that has stopped matching prints a
 * plausible count either way.
 *
 * ## The two ways it goes wrong, and why the second is worse
 *
 * Vitest's colors are the first, and it is not hypothetical: the `command`
 * runner's `statusReason` is the child's output **as a terminal would see it**, so
 * its summary lines begin with an escape sequence rather than a space. Measured
 * over the 936 kills of the first full sweep (run `38919206652`), the two patterns
 * below match **936 of 936 after stripping ANSI and 0 of 936 without** — a summary
 * that forgets to strip reports every kill as resting on the exit code alone, on
 * every run, forever.
 *
 * The second is a matcher loosened to a bare `/Test Files/` or `/Tests/`, which
 * matches the failing test's own name and the suite's summary alike. That one
 * reports zero bias always, and it is worse because it reads as a clean sweep.
 * Anchoring `^\s*Tests\s+\d+` to a line start with a count on it is what separates
 * the two, so the fixtures include a kill whose output *mentions* a test file
 * without printing a summary at all.
 *
 * Both are silent in the same direction a passing test is: nothing in the run
 * contradicts them. So the script is run against fixture reports whose answer is
 * known by construction, one per reading it can produce — all kills carried, some
 * carried, none killed, a suite that reported no tests, and a report whose runner
 * is not the one this classifies.
 *
 * ## The counting, which is the other half of what a score is
 *
 * The score is the metrics package's, and `mutation-testing-metrics@3.8.4` counts
 * a `Timeout` as detected (`totalDetected = timeout + killed`) while this summary
 * counted it as a survivor — one mutant apart in the first full sweep, which is
 * the difference between the 73.15% Stryker printed and the 73.07% printed beside
 * it ([#43](https://github.com/Antruly/uvp/issues/43)). The same package keeps
 * errored, ignored and pending mutants out of the total altogether, where the
 * summary's `total - survivors` counted them as detected. Neither is a shape a
 * real sweep has produced, which is exactly why they are fixtures: there is no
 * run to check them against until there is a run that has one, and by then the
 * number is already wrong. The three cases below pin each reading.
 *
 * ## What this does not establish
 *
 * It is a producer golden, not the workflow: the real input is a 52-minute sweep
 * on a weekly schedule, and the boundary under test here is the script's reading of
 * a report, not Stryker's production of one. A real report could stop having the
 * shape these fixtures have — that is what the kill basis line in the weekly job's
 * own summary is for, and the two are read together. The runner gate is the same
 * division of labour: this pins that the script declines to classify a report whose
 * `config.testRunner` is not `command`, not that the weekly run's report still says
 * `command`.
 *
 * Environment: none. Exit status 1 when any case's output disagrees with what this
 * file says it should be.
 */

/** The script under test, run the way the weekly job runs it. */
const SUMMARY = path.join(REPO_ROOT, "scripts", "ci", "mutation-summary.mjs");
const FILE_UNDER_TEST = "scripts/ci/mutation-summary.mjs";

/**
 * One mutant, carrying only the fields the summary reads.
 *
 * `testsCompleted: 1` is what the `command` runner reports for every mutant, and
 * the summary treats 0 as a runner defect rather than a score — so it is set here
 * rather than left for each case to remember.
 */
const mutant = (overrides) => ({
  id: "0",
  mutatorName: "ConditionalExpression",
  replacement: "true",
  status: "Killed",
  location: { start: { line: 1, column: 1 }, end: { line: 1, column: 4 } },
  testsCompleted: 1,
  ...overrides,
});

/** A report with one file, whose path is the one the first sweep measured. */
const report = (mutants, config = { testRunner: "command" }) => ({
  schemaVersion: "3.0.2",
  config,
  files: { "src/domain/errors.ts": { mutants } },
});

/**
 * The tail of a killed mutant's `statusReason`, as the `command` runner records it.
 *
 * Quoted from the shortest such record in the first full sweep's report (a kill in
 * `workspaceManifest.ts`, run `38919206652`), with the counts left as that run
 * printed them. It is the last ten lines and not the whole record — the record is
 * 6.3 kB of failing-test output upstream of this, none of which the summary reads.
 */
const COLORED_SUITE_OUTPUT = [
  "    \u001b[90m 62|\u001b[39m   });",
  "",
  "\u001b[31m\u001b[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯\u001b[22m\u001b[39m",
  "",
  "\u001b[2m Test Files \u001b[22m \u001b[1m\u001b[31m1 failed\u001b[39m\u001b[22m\u001b[2m | \u001b[22m\u001b[1m\u001b[32m16 passed\u001b[39m\u001b[22m\u001b[90m (17)\u001b[39m",
  "\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[31m1 failed\u001b[39m\u001b[22m\u001b[2m | \u001b[22m\u001b[1m\u001b[32m390 passed\u001b[39m\u001b[22m\u001b[90m (391)\u001b[39m",
  "\u001b[2m   Start at \u001b[22m 15:34:38",
  "\u001b[2m   Duration \u001b[22m 4.22s\u001b[2m (tests 77%, import 12%, transform 11%, worker 1%)\u001b[22m",
  "",
].join("\n");

/** The same summary with the colors off, which is what `NO_COLOR` buys. */
const PLAIN_SUITE_OUTPUT = [
  " Test Files  1 failed | 16 passed (17)",
  "      Tests  1 failed | 390 passed (391)",
  "   Start at  15:34:38",
  "   Duration  4.22s",
  "",
].join("\n");

/**
 * A child that died before vitest reported anything, and that mentions a test file
 * on the way.
 *
 * The third line is the point of this fixture: `Error: expected Test Files 3 to be
 * 2` is output a mutant can genuinely produce — the mutation is in the message —
 * and a matcher that asked `/Test Files/` or `/Test Files\s+\d+/` without the line
 * anchor would count this kill as one whose suite reported. Nothing in the record
 * says the suite ran, so nothing here may be read as if it did.
 */
const CRASHED_OUTPUT = [
  "node:internal/modules/cjs/loader:1215",
  "  throw err;",
  "  ^",
  "",
  "Error: expected Test Files 3 to be 2",
  "    at src/domain/errors.test.ts:41:3",
  "",
].join("\n");

/** What vitest prints when it collected nothing: no count for either pattern. */
const NO_TESTS_OUTPUT = [" Test Files  no tests", "      Tests  no tests", ""].join("\n");

const CASES = [
  {
    name: "every kill carries the suite's own summary",
    report: report([
      mutant({ id: "0", statusReason: COLORED_SUITE_OUTPUT }),
      mutant({ id: "1", location: { start: { line: 40 } }, statusReason: PLAIN_SUITE_OUTPUT }),
      mutant({ id: "2", status: "Survived", location: { start: { line: 77 } } }),
    ]),
    status: 0,
    includes: [
      "2/3 mutants detected — score 66.7%.",
      "Kill basis: all 2 kills carry the suite's own summary, so",
      "| src/domain/errors.ts:77 | `true` | Survived |",
    ],
    excludes: ["carry no suite", "Kill basis: not read"],
    // Both spellings have to carry the summary, and only the colored one proves
    // the strip. Which case holds which is stated here so that deleting one is a
    // change to this file rather than a case that quietly stopped covering it.
    covers: ["colored output is stripped", "plain output is matched"],
  },
  {
    name: "some kills carry no suite output at all",
    report: report([
      mutant({ id: "0", statusReason: COLORED_SUITE_OUTPUT }),
      mutant({ id: "1", location: { start: { line: 88 } }, statusReason: CRASHED_OUTPUT }),
      mutant({ id: "2", location: { start: { line: 3 } } }),
      mutant({ id: "3", location: { start: { line: 5 } }, statusReason: "" }),
      mutant({ id: "4", status: "Survived", location: { start: { line: 12 } } }),
      mutant({ id: "5", status: "NoCoverage", location: { start: { line: 60 } } }),
    ]),
    status: 0,
    includes: [
      "4/6 mutants detected — score 66.7%.",
      "Kill basis: 3 of 4 kills carry no suite",
      "src/domain/errors.ts:88, src/domain/errors.ts:3, src/domain/errors.ts:5",
      "| src/domain/errors.ts:12 | `true` | Survived |",
      "| src/domain/errors.ts:60 | `true` | NoCoverage |",
    ],
    excludes: ["Kill basis: all 4 kills", "Kill basis: not read"],
    covers: ["a crash and an absent statusReason are both silent"],
  },
  {
    name: "nothing was killed",
    report: report([
      mutant({ id: "0", status: "Survived" }),
      mutant({ id: "1", status: "Survived", location: { start: { line: 9 } } }),
    ]),
    status: 0,
    includes: ["0/2 mutants detected — score 0.0%.", "Kill basis: no mutant was killed."],
    excludes: ["carry the suite's own summary", "carry no suite", "Kill basis: not read"],
    covers: ["a sweep that detected nothing is not a sweep with no basis"],
  },
  {
    name: "a suite that collected no tests is not a suite that reported failures",
    report: report([mutant({ statusReason: NO_TESTS_OUTPUT })]),
    status: 0,
    includes: [
      "1/1 mutants detected — score 100.0%.",
      "Kill basis: 1 of 1 kills carry no suite",
      "src/domain/errors.ts:1.",
    ],
    excludes: ["carry the suite's own summary", "Kill basis: not read"],
    covers: ["the counts are required, so 'no tests' is the silent direction"],
  },
  {
    name: "a report from another runner is not classified",
    report: report([mutant({ statusReason: COLORED_SUITE_OUTPUT })], { testRunner: "vitest" }),
    status: 0,
    includes: [
      "Kill basis: not read.",
      'testRunner is "vitest".',
      "1/1 mutants detected — score 100.0%.",
    ],
    excludes: ["carry the suite's own summary", "carry no suite"],
    covers: ["the runner gate reports an unknown rather than a false alarm"],
  },
  {
    name: "a report that records no runner is not classified either",
    report: report([mutant({ statusReason: COLORED_SUITE_OUTPUT })], {}),
    status: 0,
    includes: ["Kill basis: not read.", "testRunner is missing."],
    excludes: ["carry the suite's own summary", "carry no suite"],
    covers: ["an absent runner is the third state, not a pass"],
  },
  {
    name: "a timeout is detected, where the metrics package counts it",
    report: report([
      mutant({ id: "0", statusReason: COLORED_SUITE_OUTPUT }),
      mutant({ id: "1", status: "Timeout", location: { start: { line: 219 } } }),
      mutant({ id: "2", status: "Survived", location: { start: { line: 12 } } }),
    ]),
    status: 0,
    includes: [
      "2/3 mutants detected — score 66.7%.",
      "Timeout: 1 of the detected mutants — src/domain/errors.ts:219.",
      "These are mutants the runner's limit stopped rather than a failing test",
      "| src/domain/errors.ts:12 | `true` | Survived |",
    ],
    // The timeout in the survivor table is the defect this case exists for: the
    // old counting listed it there and scored the report 1/3.
    excludes: ["| src/domain/errors.ts:219 |", "Timeout: no mutant exceeded", "Outside the score"],
    covers: ["a timeout is counted as the metrics package counts it"],
  },
  {
    name: "an errored mutant is neither detected nor surviving",
    report: report([
      mutant({ id: "0", statusReason: COLORED_SUITE_OUTPUT }),
      mutant({ id: "1", status: "Survived", location: { start: { line: 12 } } }),
      mutant({ id: "2", status: "RuntimeError", location: { start: { line: 30 } } }),
      mutant({ id: "3", status: "Ignored", location: { start: { line: 31 } } }),
    ]),
    status: 0,
    includes: [
      "1/2 mutants detected — score 50.0%.",
      "Outside the score: 1 RuntimeError, 1 Ignored.",
    ],
    excludes: ["| src/domain/errors.ts:30 |", "| src/domain/errors.ts:31 |", "3/4 mutants"],
    covers: ["errors and ignored mutants are outside the denominator"],
  },
  {
    name: "a report with nothing scoreable is not a score at all",
    report: report([
      mutant({ status: "RuntimeError" }),
      mutant({ id: "1", status: "CompileError", location: { start: { line: 2 } } }),
    ]),
    status: 1,
    includes: [
      "2 mutants were reported and none of them was scoreable",
      "1 RuntimeError, 1 CompileError",
    ],
    excludes: ["mutants detected", "Kill basis:", "Timeout:"],
    covers: ["the third state exists where the metrics package returns NaN"],
  },
  {
    name: "a mutant that ran no test is still not a score",
    report: report([
      mutant({ statusReason: COLORED_SUITE_OUTPUT }),
      mutant({ id: "1", location: { start: { line: 20 } }, testsCompleted: 0 }),
    ]),
    status: 1,
    includes: ["1 of 2 mutants ran zero tests"],
    excludes: ["mutants detected", "Kill basis:"],
    covers: ["the kill basis is not printed for a report the script will not score"],
  },
];

/**
 * The readings this check exists to pin, so that a case list edited down to
 * nothing cannot pass as a case list that agrees with the script.
 *
 * The last entry is the one a future runner change makes: it is the reading #41
 * produces, and it is a reading rather than a failure only because the script says
 * which runner it saw.
 */
const READINGS = [
  "carry the suite's own summary",
  "carry no suite",
  "no mutant was killed",
  "Kill basis: not read",
  "Timeout: 1 of the detected mutants",
  "Outside the score: 1 RuntimeError, 1 Ignored.",
  "none of them was scoreable",
];

/**
 * Case-list guard, in the shape `verify-artifact-guards.mjs` uses for the reads it
 * watches: every reading has to be expected by some case, and every case has to
 * say which reading it covers.
 */
const checkCaseList = () => {
  const expected = CASES.flatMap((testCase) => testCase.includes).join("\n");
  const gone = READINGS.filter((reading) => !expected.includes(reading));
  if (gone.length > 0) {
    console.error(
      "The kill basis has readings no fixture expects, so this check stopped watching them:\n" +
        gone.map((reading) => `  ${reading}`).join("\n") +
        "\n  Either the summary changed or this file was edited down; both need a look.\n",
    );
    process.exit(1);
  }
  const unexplained = CASES.filter((testCase) => (testCase.covers ?? []).length === 0);
  if (unexplained.length > 0) {
    console.error(
      "These cases do not say what they are for:\n" +
        unexplained.map((testCase) => `  ${testCase.name}`).join("\n") +
        "\n",
    );
    process.exit(1);
  }
};

/**
 * Run the real script over one fixture, the way the weekly job runs it.
 *
 * `GITHUB_STEP_SUMMARY` is removed from the child's environment rather than left
 * alone: the summary appends to whatever that names, and a check that wrote its
 * fixtures into a job's own summary would be a check that changed the thing it was
 * measuring.
 */
const runSummary = (reportFile) => {
  const env = { ...process.env, MUTATION_REPORT: reportFile };
  delete env["GITHUB_STEP_SUMMARY"];
  return spawnSync(process.execPath, [SUMMARY], { cwd: REPO_ROOT, env, encoding: "utf8" });
};

const main = async () => {
  checkCaseList();

  // Each run gets its own empty directory. The fixtures are written here and
  // nowhere near the repository, so a failing case cannot leave a report behind
  // for the next `stryker run` to read as its own.
  const directory = await mkdtemp(path.join(os.tmpdir(), "uvp-mutation-summary-"));
  const failures = [];
  try {
    for (const [index, testCase] of CASES.entries()) {
      const reportFile = path.join(directory, `case-${String(index)}.json`);
      await writeFile(reportFile, JSON.stringify(testCase.report));
      const result = runSummary(reportFile);
      const output = `${result.stdout}${result.stderr}`;

      if (result.status !== testCase.status) {
        failures.push(
          `${testCase.name}: expected exit ${String(testCase.status)}, got ` +
            `${String(result.status)}.\n${output.trim()}`,
        );
      }
      for (const text of testCase.includes) {
        if (!output.includes(text)) {
          failures.push(
            `${testCase.name}: the summary never printed ${JSON.stringify(text)}.` +
              `\n${FILE_UNDER_TEST} and this check disagree about what it reports.`,
          );
        }
      }
      for (const text of testCase.excludes) {
        if (output.includes(text)) {
          failures.push(
            `${testCase.name}: the summary printed ${JSON.stringify(text)}, which this case ` +
              "says it must not.",
          );
        }
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error("The sweep summary no longer reports the kill basis it is checked for.\n");
    for (const failure of failures) console.error(`  ${failure}\n`);
    process.exit(1);
  }

  console.log(
    `mutation summary: ${String(CASES.length)} fixture report(s) over ${String(READINGS.length)} ` +
      "readings — all-carried, partly-carried, none-killed and not-read are each reported as " +
      "this check expects, a timeout is counted as detected and an errored mutant is not, and " +
      `${FILE_UNDER_TEST} declines to classify a runner whose output it is not written for`,
  );
};

await main();
