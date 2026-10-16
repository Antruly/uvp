#!/usr/bin/env node
/**
 * The producer golden for `scripts/mutation-survivor-kinds.mjs`.
 *
 * That script's whole answer is a *classification*, and the two ways of getting it
 * wrong are silent. It can report a survivor as compiling because it applied the
 * replacement to the wrong span — a mutation that never happened leaves a file the
 * compiler is happy with — and it can report a mutant as refused because the
 * compiler was already failing on the tree, which would say the same thing about
 * every mutant in the sweep. Neither shows up as a crash, and both make the table
 * look healthier than the tree is.
 *
 * So the fixtures here do not ask the real compiler anything. `MUTATION_TYPECHECK`
 * names a stub that reads the file it is pointed at and answers from its content,
 * which lets one fixture hold all three verdicts at once — compiles, refused with a
 * diagnostic, and a command that failed without naming one. The stub also records
 * every snapshot it was shown, so the check can assert that **the mutation was
 * applied to the span the report named** rather than trusting the verdict, and that
 * the file is the report's own source again when the run ends.
 *
 * The stub is written into the fixture directory, and the script is spawned with
 * that directory as its working directory, so nothing here touches the repository.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT } from "./lib/paths.mjs";

const FILE_UNDER_TEST = path.join(REPO_ROOT, "scripts", "mutation-survivor-kinds.mjs");
const TARGET = "src/example.ts";

/**
 * The stub compiler. It is the whole of this check's independence from the real
 * `tsc`: a verdict is decided by what the file says, so one fixture can carry all
 * three answers and the expected table is arithmetic rather than a claim about
 * TypeScript.
 *
 * The file is read relative to the working directory the script spawns its compiler
 * in, and every snapshot is appended to `seen.jsonl` before the verdict — that log
 * is what makes "the mutation went to the span its report names" an assertion
 * instead of an assumption.
 */
const STUB = `import { appendFileSync, readFileSync } from "node:fs";
const text = readFileSync("${TARGET}", "utf8");
appendFileSync("seen.jsonl", JSON.stringify(text) + "\\n");
if (text.includes("TWO_CODES")) {
  console.log("${TARGET}(1,1): error TS2375: the stub refuses this file.");
  console.log("${TARGET}(2,1): error TS7027: and this one too.");
  process.exit(1);
}
if (text.includes("COMPILE_ERROR")) {
  console.log("${TARGET}(1,1): error TS2375: the stub refuses this file.");
  process.exit(1);
}
if (text.includes("NO_DIAGNOSTIC")) process.exit(2);
process.exit(0);
`;

/** `const a = 1;\nconst b = 2;\n` — two one-character spans, at 1:11 and 2:11. */
const PRISTINE = "const a = 1;\nconst b = 2;\n";

/** A survivor at the span `line:11-12`, which is the digit on that line. */
const survivor = (line, replacement) => ({
  mutatorName: "StringLiteral",
  replacement,
  status: "Survived",
  location: { start: { line, column: 11 }, end: { line, column: 12 } },
});

const report = (mutants, source = PRISTINE) => ({
  files: { [TARGET]: { source, mutants } },
});

/**
 * What the stub was shown, per case, and what the table has to say about it.
 *
 * `seen` is the number of times the stub ran — the baseline, plus one per surviving
 * mutant it reached — which is how a case asserts that classification *stopped*
 * rather than that it merely printed the right words. `seenTexts`, where a case
 * gives them, is the exact sequence the stub was shown.
 */
const CASES = [
  {
    name: "one survivor compiles and one is refused, and a killed mutant is not classified",
    report: report([
      survivor(1, "1"),
      survivor(2, "COMPILE_ERROR"),
      { ...survivor(1, "9"), status: "Killed" },
    ]),
    status: 0,
    seenTexts: [PRISTINE, PRISTINE, "const a = 1;\nconst b = COMPILE_ERROR;\n"],
    includes: [
      "| src/example.ts | 2 | 1 | 1 | 0 |",
      "| **total** | **2** | **1** | **1** | **0** |",
      "## The diagnostics named by the 1 that do not compile",
      "| TS2375 | 1 |",
      "## The 1 survivor(s) that do not compile",
      "| src/example.ts:2:11 | TS2375 | `COMPILE_ERROR` |",
      "A mutant the compiler refuses is not a mutant the suite missed.",
    ],
    excludes: [`${TARGET}:1:11 | TS`, "Killed"],
    covers: [
      "a survivor the compiler accepts is counted as compiling, and a killed mutant is not",
      "a survivor the compiler refuses is listed with the diagnostic the compiler named",
      "the diagnostics the class is made of are tallied, not only listed",
      "each mutation is applied to the span its report names, in order",
    ],
  },
  {
    name: "a survivor naming two diagnostics is counted under both, and the rows say they overlap",
    report: report([survivor(1, "TWO_CODES")]),
    status: 0,
    seenTexts: [PRISTINE, "const a = TWO_CODES;\nconst b = 2;\n"],
    includes: [
      "| src/example.ts | 1 | 0 | 1 | 0 |",
      "## The diagnostics named by the 1 that do not compile",
      "| TS2375 | 1 |",
      "| TS7027 | 1 |",
      "A mutant can name more than one code, so these rows do not sum to 1.",
      "| src/example.ts:1:11 | TS2375+TS7027 | `TWO_CODES` |",
    ],
    covers: [
      "a survivor refused with two diagnostics is counted under each of them, and the tally " +
        "states that the rows overlap rather than implying they partition the class",
    ],
  },
  {
    name: "a compiler that fails without naming a diagnostic is undetermined, not refused",
    report: report([survivor(1, "NO_DIAGNOSTIC")]),
    status: 0,
    seenTexts: [PRISTINE, "const a = NO_DIAGNOSTIC;\nconst b = 2;\n"],
    includes: [
      "| src/example.ts | 1 | 0 | 0 | 1 |",
      "Unknown: 1 survivor(s) the typecheck did not answer for.",
      "1:11: the typecheck exited 2 without a TS diagnostic",
    ],
    excludes: ["## The 1 survivor(s) that do not compile"],
    covers: [
      "a command that failed without a TS diagnostic is reported as unknown, not as a refusal",
    ],
  },
  {
    name: "a file that is not the source the report recorded is not classified",
    report: report([survivor(1, "1")]),
    onDisk: "const a = 10;\nconst b = 2;\n",
    status: 0,
    seen: 1,
    includes: [
      "not classified: the file on disk is not the source the report recorded",
      "| **total** | **0** | **0** | **0** | **0** |",
    ],
    excludes: ["| src/example.ts | 1 |"],
    covers: [
      "a file that has moved since the sweep stays unclassified with the reason, rather than " +
        "being classified against a tree that never existed",
    ],
  },
  {
    name: "a report that carries no source for a file is not classified",
    report: { files: { [TARGET]: { mutants: [survivor(1, "1")] } } },
    onDisk: PRISTINE,
    status: 0,
    seen: 1,
    includes: [
      "not classified: the report carries no source for it",
      "| **total** | **0** | **0** | **0** | **0** |",
    ],
    excludes: ["| src/example.ts | 1 |"],
    covers: ["a report that embedded no source cannot be classified, and says so"],
  },
  {
    name: "a pristine tree that does not compile is refused before any mutant is classified",
    report: report([survivor(1, "1")]),
    onDisk: "const a = COMPILE_ERROR;\nconst b = 2;\n",
    status: 1,
    seenTexts: ["const a = COMPILE_ERROR;\nconst b = 2;\n"],
    includes: ["The pristine tree does not typecheck (TS2375)", "Nothing was classified."],
    excludes: ["| **total**"],
    covers: [
      "a tree that already does not typecheck is refused, because every mutant's verdict would " +
        "describe the tree rather than the mutation",
    ],
  },
  {
    name: "a report that cannot be read is a failure, not an empty sweep",
    missingReport: true,
    status: 1,
    seen: 0,
    includes: ["Could not read"],
    excludes: ["| **total**"],
    covers: ["a report that could not be read is reported rather than treated as no survivors"],
  },
];

/**
 * Every behaviour this check is here to watch. A case list that stopped expecting
 * one of them would be a check that quietly stopped covering it, so the guard below
 * fails on that instead of passing.
 */
const READINGS = [
  "| src/example.ts | 2 | 1 | 1 | 0 |",
  "TS2375",
  "the typecheck exited 2 without a TS diagnostic",
  "not classified: the file on disk is not the source the report recorded",
  "not classified: the report carries no source for it",
  "The pristine tree does not typecheck (TS2375)",
  "Nothing was classified.",
  "Could not read",
];

/**
 * Case-list guard, in the shape `verify-mutation-summary.mjs` uses: every reading
 * has to be expected by some case, and every case has to say what it covers.
 */
const checkCaseList = () => {
  const expected = CASES.flatMap((testCase) => testCase.includes).join("\n");
  const gone = READINGS.filter((reading) => !expected.includes(reading));
  if (gone.length > 0) {
    console.error(
      "The classification has readings no fixture expects, so this check stopped watching them:\n" +
        gone.map((reading) => `  ${reading}`).join("\n") +
        "\n  Either the script changed or this file was edited down; both need a look.\n",
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

/** One fixture directory, holding a report and the file it points at. */
const fixture = async (index, testCase) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), `uvp-survivor-kinds-${String(index)}-`));
  // The target source is what the case put on disk, which is the report's own
  // source unless the case is about the two having diverged.
  const source = testCase.onDisk ?? testCase.report?.files?.[TARGET]?.source;
  if (source !== undefined) {
    await mkdir(path.join(directory, path.dirname(TARGET)), { recursive: true });
    await writeFile(path.join(directory, TARGET), source);
  }
  await writeFile(path.join(directory, "stub.mjs"), STUB);
  await writeFile(path.join(directory, "seen.jsonl"), "");
  const reportFile = testCase.missingReport
    ? path.join(directory, "absent.json")
    : path.join(directory, "report.json");
  if (!testCase.missingReport) await writeFile(reportFile, JSON.stringify(testCase.report));
  return { directory, reportFile, source };
};

const main = async () => {
  checkCaseList();

  const failures = [];
  for (const [index, testCase] of CASES.entries()) {
    // Each case gets its own empty directory, so a failing case cannot leave a
    // mutated file behind for the next one to read as its own.
    const { directory, reportFile, source } = await fixture(index, testCase);
    try {
      const result = spawnSync(process.execPath, [FILE_UNDER_TEST, reportFile], {
        cwd: directory,
        env: { ...process.env, MUTATION_TYPECHECK: `${process.execPath} stub.mjs` },
        encoding: "utf8",
      });
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
            `${testCase.name}: the run never printed ${JSON.stringify(text)}.` +
              `\n${FILE_UNDER_TEST} and this check disagree about what it reports.`,
          );
        }
      }
      for (const text of testCase.excludes ?? []) {
        if (output.includes(text)) {
          failures.push(
            `${testCase.name}: the run printed ${JSON.stringify(text)}, which this case says it ` +
              "must not.",
          );
        }
      }

      // The stub's own record of what it was shown. This is the assertion the
      // verdicts cannot make: a mutant counted as compiling because the replacement
      // went to the wrong span would print the same table.
      const seen = (await readFile(path.join(directory, "seen.jsonl"), "utf8"))
        .split("\n")
        .filter((line) => line !== "");
      const expectedSeen = testCase.seenTexts ?? Array.from({ length: testCase.seen }, () => "");
      if (seen.length !== expectedSeen.length) {
        failures.push(
          `${testCase.name}: the compiler ran ${String(seen.length)} time(s), expected ` +
            `${String(expectedSeen.length)}.`,
        );
      } else if (testCase.seenTexts !== undefined) {
        for (const [run, text] of testCase.seenTexts.entries()) {
          if (seen[run] !== JSON.stringify(text)) {
            failures.push(
              `${testCase.name}: compile ${String(run)} was shown ${String(seen[run])}, ` +
                `expected ${JSON.stringify(text)} — the mutation went somewhere else.`,
            );
          }
        }
      }

      if (source !== undefined) {
        const restored = await readFile(path.join(directory, TARGET), "utf8");
        if (restored !== source) {
          failures.push(
            `${testCase.name}: ${FILE_UNDER_TEST} left the file at ${JSON.stringify(restored)}, ` +
              `not the source it started from (${JSON.stringify(source)}).`,
          );
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  if (failures.length > 0) {
    console.error("The survivor classification no longer separates what it is checked for.\n");
    for (const failure of failures) console.error(`  ${failure}\n`);
    process.exit(1);
  }

  console.log(
    `mutation survivor kinds: ${String(CASES.length)} fixture report(s) over ` +
      `${String(READINGS.length)} readings — compiling, refused-with-a-diagnostic and ` +
      "undetermined are each counted and tabled as this check expects, the diagnostics behind " +
      "them are tallied with a survivor naming two counted under both, a mutation is applied to " +
      "the span its report names and the file is restored after it, a moved file and a report " +
      "without a source stay unclassified, and a tree that does not typecheck is refused before " +
      "anything is classified",
  );
};

await main();
