#!/usr/bin/env node
/**
 * The producer golden for `scripts/mutation-equivalence.mjs`.
 *
 * The instrument's answer is a verdict about *another program*, and every way of
 * getting it wrong is silent: a comparison that cannot see `{ extra: undefined }`
 * reports equivalence; a run that never applied the mutation compares the module
 * with itself; a mutation applied in the wrong place compares a program nobody
 * described. So the fixtures here are small modules whose behaviour this file
 * knows, and the assertions are about what the comparator had to notice to say what
 * it said.
 *
 * Four properties are checked beyond the verdicts themselves:
 *
 * - **The shape walk sees a present-but-undefined key**, which `JSON.stringify`
 *   would erase — the reason the comparator is a walk rather than a string
 *   comparison.
 * - **A throw is a result**, so a mutant that throws where the module answers is
 *   distinguishable rather than looking like an absent value.
 * - **A blind control refuses the run** with exit 2: a control the comparison
 *   cannot see is the instrument saying it is blind, not clear. The same code covers
 *   a mutation that does not apply once, two ids that sanitise to one mutant path
 *   (the ESM cache would hand the second the first's module), an input file that
 *   escapes its directory, and an unexpected error while comparing — Node's default
 *   exit 1 would report the instrument breaking as a distinguishable mutant.
 * - **Each mutant is written beside the module and removed again**, and the module
 *   itself is byte-identical afterwards — the mutation is a comparison, never an
 *   edit of the tree. That includes a refusal after an earlier mutant was written.
 *
 * Exit codes follow the script's own contract: 0 equivalent, 1 distinguishable,
 * 2 untrustworthy.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT } from "./lib/paths.mjs";

const FILE_UNDER_TEST = path.join(REPO_ROOT, "scripts", "mutation-equivalence.mjs");

/** Reads one JSON file from a directory and normalises two of its fields. */
const READER = `import { readFileSync } from "node:fs";
import { join } from "node:path";

export function read(root) {
  const parsed = JSON.parse(readFileSync(join(root, "data.json"), "utf8"));
  return { name: parsed.name, count: typeof parsed.count === "number" ? parsed.count : 0 };
}
`;

const SUM = `export function add(a, b) {
  return a + b;
}
`;

const CYCLE = `export function read() {
  const value = { value: 1 };
  value.self = value;
  return value;
}
`;

/** The fixture modules, by the path a config names. */
const MODULES = { "main/reader.mjs": READER, "main/sum.mjs": SUM, "main/cycle.mjs": CYCLE };

const INPUTS = [
  { label: "name only", files: { "data.json": '{"name":"svc"}' } },
  { label: "count 3", files: { "data.json": '{"name":"svc","count":3}' } },
  { label: "count as string", files: { "data.json": '{"name":"svc","count":"3"}' } },
];

const ARGUMENT_INPUTS = [
  { label: "2 and 3", args: [2, 3] },
  { label: "undefined and 5", args: [{ $undefined: true }, 5] },
];

/** The equivalent mutation and the control this file's first two cases share. */
const EQUIVALENT = {
  id: "eq",
  what: "`===` to `==` where both sides are the string `typeof` answers",
  from: 'typeof parsed.count === "number"',
  to: 'typeof parsed.count == "number"',
};
const CONTROL = {
  id: "c1",
  what: "the fallback count",
  from: "? parsed.count : 0",
  to: "? parsed.count : 1",
  control: true,
};

const config = (overrides) => ({
  module: "main/reader.mjs",
  export: "read",
  call: "directory",
  inputs: "inputs.json",
  mutants: [EQUIVALENT],
  ...overrides,
});

/**
 * What each fixture expects. `includes` is matched against stdout and stderr
 * together; `json` is matched against the parsed `--json` report when the case
 * asks for one.
 */
const CASES = [
  {
    name: "an equivalent mutant is indistinguishable and a control is seen",
    config: config({ mutants: [EQUIVALENT, CONTROL] }),
    status: 0,
    includes: [
      "| eq | indistinguishable over these inputs | 0 |",
      "| c1 (control) | distinguishable on 2 | 2 |",
      "verdict: 1 of 1 non-control mutant(s) indistinguishable over 3 input(s); 1 of 1 control(s) seen",
    ],
    covers: [
      "a mutation that changes nothing over the inputs is called indistinguishable, and a control " +
        "travelling with it is reported as seen",
    ],
  },
  {
    name: "a mutant the inputs separate is reported with the input and the path",
    config: config({
      mutants: [
        {
          id: "guard",
          what: "the counted value replaced by a constant",
          from: 'count: typeof parsed.count === "number" ? parsed.count : 0',
          to: "count: 0",
        },
      ],
    }),
    status: 1,
    includes: [
      "| guard | distinguishable on 1 | 1 |",
      'first: "count 3"',
      "returned.count: 3 vs 0",
    ],
    covers: [
      "a mutant some input separates is reported by the input's own label and the path where the " +
        "results diverge, not only as a count",
    ],
  },
  {
    name: "a key present with undefined is a difference",
    config: config({
      mutants: [
        {
          id: "extra",
          what: "adds a present-but-undefined key",
          from: "name: parsed.name,",
          to: "name: parsed.name, extra: undefined,",
        },
      ],
    }),
    status: 1,
    includes: ["returned.extra: absent from the original"],
    covers: [
      "a mutant that adds a key whose value is undefined is distinguishable, because the walk " +
        "counts presence and JSON.stringify would not",
    ],
  },
  {
    name: "a throw where the module answers is a difference",
    config: config({
      mutants: [
        {
          id: "throws",
          what: "throws instead of answering",
          from: "const parsed = JSON.parse",
          to: 'throw new TypeError("boom"); const parsed = JSON.parse',
        },
      ],
    }),
    status: 1,
    includes: ["returned: absent from the mutant", "threw: absent from the original"],
    covers: [
      "a mutant that throws is distinguishable from one that answers, rather than invisible",
    ],
  },
  {
    name: "a control the comparison cannot see refuses the run",
    config: config({
      mutants: [
        {
          id: "blind",
          what: "a control that changes nothing",
          from: "? parsed.count : 0",
          to: "? parsed.count : 0",
          control: true,
        },
      ],
    }),
    status: 2,
    includes: [
      "| blind (control) | **blind** — a control the comparison could not see | 0 |",
      "0 of 1 control(s) seen",
    ],
    covers: [
      "a control with no difference exits 2, because a comparison that cannot see its control " +
        "cannot clear anything",
    ],
  },
  {
    name: "a mutation that is not unique is refused rather than compared",
    config: config({ mutants: [{ id: "twice", from: "parsed", to: "parsed" }] }),
    status: 2,
    includes: ['its "from" text occurs 4 time(s) in the module, not once'],
    covers: [
      "a replacement that matches zero or several places is an error, because comparing a program " +
        "nobody described is worse than not comparing",
    ],
  },
  {
    name: "a refusal after a mutant was written removes what it wrote",
    config: config({
      mutants: [
        {
          id: "written-first",
          what: "an applicable mutation the refusal comes after",
          from: "? parsed.count : 0",
          to: "? parsed.count : 2",
        },
        { id: "twice", from: "parsed", to: "parsed" },
      ],
    }),
    status: 2,
    includes: ['mutant twice: its "from" text occurs 4 time(s) in the module, not once'],
    covers: [
      "a refusal after an earlier mutant was written still leaves no .mutant file beside the " +
        "module, because `fail` exits without unwinding a `finally`",
    ],
  },
  {
    name: "two ids that sanitise to one mutant path are refused",
    config: config({
      mutants: [
        { id: "a b", what: "the first id", from: "? parsed.count : 0", to: "? parsed.count : 2" },
        { id: "a_b", what: "the second id", from: "? parsed.count : 0", to: "? parsed.count : 3" },
      ],
    }),
    status: 2,
    includes: ['mutants "a b" and "a_b" both resolve to'],
    covers: [
      "two ids that sanitise to one file name are refused, because the ESM cache would hand the " +
        "second mutant the first one's module and call it equivalent",
    ],
  },
  {
    name: "an unexpected error while comparing exits 2 rather than the finding code",
    config: {
      module: "main/cycle.mjs",
      export: "read",
      call: "arguments",
      inputs: "argument-inputs.json",
      mutants: [
        {
          id: "control",
          what: "a control the crash happens before",
          from: "value: 1",
          to: "value: 2",
          control: true,
        },
      ],
    },
    status: 2,
    includes: ["the comparison failed"],
    covers: [
      "a cyclic result crashes the shape walk, and the run exits 2 — Node's default exit 1 would " +
        "report the instrument breaking as a distinguishable mutant",
    ],
  },
  {
    name: "an input file that escapes its directory is refused",
    config: config({
      inputs: [
        {
          label: "one",
          files: { "../escape.txt": "outside" },
        },
      ],
      mutants: [EQUIVALENT],
    }),
    status: 2,
    includes: ['input file "../escape.txt" is outside the input\'s directory'],
    covers: [
      "a directory input's file name that resolves outside the temporary root is refused rather " +
        "than written and left behind",
    ],
  },
  {
    name: "the machine-readable report carries the verdicts and the exit code",
    config: config({ mutants: [EQUIVALENT, CONTROL] }),
    json: true,
    status: 0,
    jsonExpect: [
      '"exitCode": 0',
      '"controls": 1',
      '"inputs": 3',
      '"blindControls": []',
      '"findings": []',
      '"untrustworthy": null',
      '"verdict": "indistinguishable"',
      '"verdict": "distinguishable"',
    ],
    covers: ["--json prints one object carrying the verdicts, the controls and the exit code"],
  },
  {
    name: "an arguments call passes an explicit undefined and compares the results",
    config: {
      module: "main/sum.mjs",
      export: "add",
      call: "arguments",
      inputs: "argument-inputs.json",
      mutants: [
        {
          id: "commute",
          what: "the operands exchanged",
          from: "return a + b;",
          to: "return b + a;",
        },
        {
          id: "undefined-first",
          what: "names an undefined first argument",
          from: "return a + b;",
          to: 'return a === undefined ? "no first argument" : a + b;',
          control: true,
        },
        {
          id: "minus",
          what: "a sum turned into a difference",
          from: "return a + b;",
          to: "return a - b;",
          control: true,
        },
      ],
    },
    status: 0,
    includes: [
      "| commute | indistinguishable over these inputs | 0 |",
      "| undefined-first (control) | distinguishable on 1 | 1 |",
      "| minus (control) | distinguishable on 1 | 1 |",
      "2 of 2 control(s) seen",
    ],
    covers: [
      'an arguments call invokes the export with the input\'s arguments, and `{"$undefined": true}` ' +
        "arrives as undefined — a control that only differs when it does proves the revival",
    ],
  },
  {
    name: "a run with no control and no difference has shown nothing and is refused",
    config: config({ mutants: [EQUIVALENT] }),
    status: 2,
    includes: [
      "untrustworthy: no control was supplied and no mutant differs, so nothing shows the comparison can see",
    ],
    covers: [
      "a run whose only mutant is indistinguishable and that carries no control exits 2, because " +
        "the instrument has demonstrated nothing about its own sight",
    ],
  },
  {
    name: "a config naming a module that does not exist is refused",
    config: config({ module: "main/absent.mjs" }),
    status: 2,
    includes: ['"module" names no file at'],
    covers: ["a module that is not there is refused at the boundary, not compared as an empty one"],
  },
];

/**
 * Readings no case may stop expecting, in the shape the other goldens use: the
 * guard below fails when the list and the expectations drift apart.
 */
const READINGS = [
  "indistinguishable over these inputs",
  "distinguishable on",
  "returned.extra: absent from the original",
  "threw: absent from the original",
  "blind",
  "no control was supplied and no mutant differs",
  "not once",
  "both resolve to",
  "the comparison failed",
  "is outside the input's directory",
  '"exitCode": 0',
  "| undefined-first (control) | distinguishable on 1 | 1 |",
  '"module" names no file at',
];

const checkCaseList = () => {
  const expected = CASES.flatMap((testCase) => [
    ...(testCase.includes ?? []),
    ...(testCase.jsonExpect ?? []),
  ]).join("\n");
  const gone = READINGS.filter((reading) => !expected.includes(reading));
  if (gone.length > 0) {
    console.error(
      "The equivalence verdicts have readings no fixture expects, so this check stopped watching them:\n" +
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

/** One empty directory holding the fixtures a case names. */
const fixture = async (index, testCase) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), `uvp-equivalence-${String(index)}-`));
  await mkdir(path.join(directory, "main"), { recursive: true });
  await writeFile(path.join(directory, "main", "reader.mjs"), READER);
  await writeFile(path.join(directory, "main", "sum.mjs"), SUM);
  await writeFile(path.join(directory, "main", "cycle.mjs"), CYCLE);
  await writeFile(path.join(directory, "inputs.json"), JSON.stringify(INPUTS));
  await writeFile(path.join(directory, "argument-inputs.json"), JSON.stringify(ARGUMENT_INPUTS));
  await writeFile(path.join(directory, "config.json"), JSON.stringify(testCase.config));
  return directory;
};

/** What the run wrote into the module's directory, and whether it restored it. */
const leftovers = async (directory, testCase) => {
  const mainDirectory = path.join(directory, "main");
  const names = (await readdir(mainDirectory)).filter((name) => name.includes(".mutant-"));
  const module = testCase.config.module;
  // `null` for a module the case expected the run to refuse, so the comparison is
  // only made where there is something to compare.
  const restored = await readFile(path.join(directory, module), "utf8").catch(() => null);
  return { names, restored, expected: MODULES[module] ?? null };
};

const main = async () => {
  checkCaseList();
  const failures = [];
  for (const [index, testCase] of CASES.entries()) {
    const directory = await fixture(index, testCase);
    try {
      const result = spawnSync(
        process.execPath,
        [
          FILE_UNDER_TEST,
          path.join(directory, "config.json"),
          ...(testCase.json ? ["--json"] : []),
        ],
        { cwd: directory, encoding: "utf8" },
      );
      const output = `${result.stdout}${result.stderr}`;

      if (result.status !== testCase.status) {
        failures.push(
          `${testCase.name}: expected exit ${String(testCase.status)}, got ` +
            `${String(result.status)}.\n${output.trim()}`,
        );
      }
      for (const text of testCase.includes ?? []) {
        if (!output.includes(text)) {
          failures.push(
            `${testCase.name}: the run never printed ${JSON.stringify(text)}.\n${output.trim()}`,
          );
        }
      }
      for (const text of testCase.jsonExpect ?? []) {
        if (!output.includes(text)) {
          failures.push(`${testCase.name}: the JSON report has no ${JSON.stringify(text)}.`);
        }
      }

      const { names, restored, expected } = await leftovers(directory, testCase);
      if (names.length > 0) {
        failures.push(
          `${testCase.name}: the run left ${names.join(", ")} beside the module instead of ` +
            "removing the mutants it wrote.",
        );
      }
      if (restored !== null && restored !== expected) {
        failures.push(
          `${testCase.name}: the module changed during the run — the comparison edited the tree ` +
            "rather than copying from it.",
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  if (failures.length > 0) {
    console.error("The equivalence comparison no longer separates what it is checked for.\n");
    for (const failure of failures) console.error(`  ${failure}\n`);
    process.exit(1);
  }

  console.log(
    `mutation equivalence: ${String(CASES.length)} fixture(s) — an equivalent mutant and a ` +
      "control are told apart in the verdicts, a difference is named by its input and path, a " +
      "present-but-undefined key and a throw are both differences, a blind control, an ambiguous " +
      "mutation, a colliding id, an escaping input file, an internal crash and a run that " +
      "demonstrated nothing exit 2, the JSON report carries the verdicts and the exit code, an " +
      "arguments call passes an explicit undefined, and the tree is left as it was found",
  );
};

await main();
