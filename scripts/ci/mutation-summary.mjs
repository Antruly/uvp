#!/usr/bin/env node
/**
 * Summarize a Stryker report into the two parts a human actually reads: the
 * mutants that **survived**, and what the kills rest on.
 *
 * A mutation score is a number that goes up when you add assertions and down
 * when you add code, which makes it a poor target and a decent signal. What
 * matters is the list underneath it — a survivor is a place where the code can
 * be wrong and the suite will not notice, which is the same class of problem as
 * an evidence report that says `verified` without having looked. The score
 * itself is an upper bound, and the kill basis below it is how much of one.
 *
 * Prints to stdout and, when `GITHUB_STEP_SUMMARY` is set, to the job summary.
 */

import { appendFileSync, readFileSync } from "node:fs";

const REPORT = process.env["MUTATION_REPORT"] ?? "reports/mutation/uvp.json";
const SURVIVING_STATUSES = new Set(["Survived", "NoCoverage", "Timeout"]);

/**
 * What a kill rests on.
 *
 * The runner is the built-in `command` runner (#30): it runs the whole mutation
 * group and Stryker records `Killed` whenever that run exits non-zero. A kill
 * here is therefore the group's exit code, not an assertion, so a group that
 * failed for a reason of its own — a flake, or damage that stops the run before
 * the suite reports — counts as detected, and the score is an **upper bound**.
 *
 * The report does not say which of the two happened. It does carry the one
 * thing that can be asked of it: core's `command` runner puts the child
 * process's combined stdout and stderr in each killed mutant's `statusReason`
 * (`completeResult` in `command-test-runner.js`), so a kill whose suite ran
 * carries the suite's own summary there, and a kill without one is a kill that
 * rests on the exit code alone.
 *
 * The patterns are a test reporter's wording, which makes them the kind of check
 * that should report a shape change rather than fail on one: if vitest renames
 * those lines, every kill stops matching and the count rising to all of them is
 * the signal. That is why the count is printed and never a failing condition —
 * the same reason a mutant that breaks the build is conventionally counted as
 * killed rather than as a defect in the grading.
 *
 * It holds only while the runner is `command` (#41 is the issue that would
 * change it), so the report's own `config.testRunner` decides whether to read it
 * at all. Under another runner — the `vitest` runner, where a result travels
 * back over the IPC channel instead of through a child's stdout — `statusReason`
 * is not known to hold the suite's output, and every kill would match nothing:
 * "0 of 936 kills carry the suite's own summary" is exactly the false alarm that
 * a third state exists to avoid. The score is an upper bound under any runner;
 * what is unknown is by how much, and that is what gets said.
 */
const COMMAND_RUNNER = "command";
const ANSI = /\u001B\[[0-9;]*m/gu;
const SUITE_SUMMARY_PATTERNS = [/^\s*Test Files\s+\d+/mu, /^\s*Tests\s+\d+/mu];

const reachedTheSuite = (mutant) => {
  const output = (mutant.statusReason ?? "").replace(ANSI, "");
  return SUITE_SUMMARY_PATTERNS.some((pattern) => pattern.test(output));
};

const readReport = () => {
  try {
    return JSON.parse(readFileSync(REPORT, "utf8"));
  } catch (cause) {
    process.stderr.write(`Could not read ${REPORT}: ${String(cause)}\n`);
    return undefined;
  }
};

// The report keys files by path and does not repeat the path on each mutant, so
// it is carried along here: a survivor list that names no file is a list nobody
// can act on.
const location = (mutant) => {
  const file = (mutant.fileName ?? "(unknown file)").replace(/^.*\/src\//u, "src/");
  const line = mutant.location?.start?.line;
  return line === undefined ? file : `${file}:${String(line)}`;
};

// The kill basis, as lines. Zero silent kills is the ordinary case and gets one
// sentence; anything else names locations, because a count a reader cannot act
// on is the same as no count.
const killBasisLines = (killed, runner) => {
  if (runner !== COMMAND_RUNNER) {
    return [
      "Kill basis: not read. The reading asks a kill's `statusReason` for the suite's own",
      "summary, which is the `command` runner's shape — the child process's combined",
      `stdout and stderr — and this report's testRunner is ${
        runner === undefined ? "missing" : JSON.stringify(runner)
      }.`,
      "Under exit-code grading the score is an upper bound; how much of one is not known here.",
    ];
  }
  if (killed.length === 0) return ["Kill basis: no mutant was killed."];
  const silent = killed.filter((mutant) => !reachedTheSuite(mutant));
  if (silent.length === 0) {
    return [
      `Kill basis: all ${String(killed.length)} kills carry the suite's own summary, so`,
      "none rests on the group's exit code alone.",
    ];
  }
  return [
    `Kill basis: ${String(silent.length)} of ${String(killed.length)} kills carry no suite`,
    `summary, so those rest on the group's exit code alone — ${silent.slice(0, 5).map(location).join(", ")}.`,
    "A mutant whose damage stops the run before the suite reports is counted as killed,",
    "which is what makes the score an upper bound by that many. Reported, never failed on.",
  ];
};

const main = () => {
  const report = readReport();
  if (report === undefined) {
    // A missing report is reported, not treated as a clean sweep. "I could not
    // read the result" and "nothing survived" are different findings.
    process.exitCode = 1;
    return;
  }

  const mutants = Object.entries(report.files ?? {}).flatMap(([fileName, file]) =>
    (file.mutants ?? []).map((mutant) => ({ ...mutant, fileName })),
  );

  // A mutant that was planned as a run and completed no test has no result to
  // report: Stryker reports "Survived" for a mutant it never executed, and a
  // score over a report of that shape reads exactly like a suite that notices
  // nothing while being a runner defect instead. Static mutants are exempt —
  // they are activated before the tests load, and Stryker sizes a run plan for
  // them from the whole project. The check stays now that the runner is the
  // `command` runner and every mutant reports one test: a zero here means the
  // sweep has stopped running tests again, whatever the runner is. See
  // docs/testing.md, "The runner ran no test".
  const unran = mutants.filter((mutant) => mutant.static !== true && mutant.testsCompleted === 0);
  if (unran.length > 0) {
    process.stderr.write(
      `${String(unran.length)} of ${String(mutants.length)} mutants ran zero tests. ` +
        "A score over this report would describe the runner, not the suite, so it is " +
        "reported as a failure instead of a number. Survivors are listed in the retained " +
        `report; the first few are ${unran.slice(0, 5).map(location).join(", ")}.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const survivors = mutants.filter((mutant) => SURVIVING_STATUSES.has(mutant.status));
  const detected = mutants.length - survivors.length;
  const score = mutants.length === 0 ? 0 : (detected / mutants.length) * 100;

  const killed = mutants.filter((mutant) => mutant.status === "Killed");

  const lines = [
    `# Mutation sweep`,
    "",
    `${String(detected)}/${String(mutants.length)} mutants detected — score ${score.toFixed(1)}%.`,
    "",
    ...killBasisLines(killed, report.config?.testRunner),
    "",
  ];

  if (survivors.length === 0) {
    lines.push("No survivors. Every mutated decision was caught by an assertion.");
  } else {
    lines.push(`## ${String(survivors.length)} survivor(s)`, "");
    lines.push("| Location | Mutation | Status |", "| --- | --- | --- |");
    for (const mutant of survivors) {
      const description = (mutant.replacement ?? mutant.mutatorName ?? "").replace(/\|/gu, "\\|");
      lines.push(`| ${location(mutant)} | \`${description}\` | ${String(mutant.status)} |`);
    }
    lines.push(
      "",
      "A survivor is a place where the code can be wrong and the suite still passes.",
      "Read each one: either an assertion is missing, or the mutation is equivalent",
      "and the mutant should be excluded with a reason.",
    );
  }

  const summary = `${lines.join("\n")}\n`;
  process.stdout.write(summary);
  const summaryFile = process.env["GITHUB_STEP_SUMMARY"];
  if (summaryFile) appendFileSync(summaryFile, summary);
};

main();
