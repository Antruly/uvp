#!/usr/bin/env node
/**
 * Whether a mutant is distinguishable from the module it mutates, over inputs the
 * caller supplies.
 *
 * `scripts/mutation-survivor-kinds.mjs` answers one axis of a survivor — whether a
 * type-checked tree could hold it at all — and it generalizes because the answer is
 * the compiler's. Equivalence does not generalize the same way: "no input tells the
 * mutant from the original" is a property of a *particular set of inputs*, so the
 * two halves of a measurement are different things. The comparison is generic and
 * lives here; the inputs are the target's and are brought by the caller. [#57] is
 * the gap this closes: the four equivalents `docs/testing.md` records for
 * `workspaceManifest.ts` were measured by a harness under `/tmp`, and a number
 * whose instrument no longer exists is quotable but cannot be re-measured.
 *
 * ## What it compares, and why it is a shape walk
 *
 * The compiled module is what the mutation lane runs, so that is what is compared —
 * the mutant is the report's replacement applied as a text edit to the built file,
 * not a recompilation of the TypeScript, and the caller names the edit because a
 * Stryker location is a TypeScript coordinate while the file compared is the
 * JavaScript `tsc` emitted.
 *
 * The comparison is a shape walk rather than `JSON.stringify`, because JSON drops a
 * key whose value is `undefined` and `{ binary: undefined }` against `{}` is exactly
 * the difference an object-literal mutant makes. A thrown error is compared as a
 * value (`{ threw: "TypeError: …" }`) so that "answers" and "throws" are different
 * results rather than one of them looking like an absence. What the walk sees is
 * enumerable data: a `Date`, a `Map` or a class instance is compared by its
 * enumerable keys, which is all a result made of plain records needs and is not
 * enough for a target that returns such a value — that target needs a comparator of
 * its own rather than this one bent to it. The same holds for a result that literally
 * equals the `{ "$undefined": true }` sentinel: the walk cannot tell that object from
 * `undefined`, which is the sentinel's cost and is named rather than left to be found.
 * A cyclic result cannot be walked at all; the run exits 2 saying the comparison
 * failed, because the instrument breaking is not a finding about the code.
 *
 * ## Controls are part of the verdict
 *
 * "No difference" from a comparator that cannot see is not evidence, so the caller
 * marks mutants as controls — mutations that *must* be distinguishable — and a run
 * in which a control is not distinguishable exits **2**, which is the instrument
 * saying it is blind rather than clear. A run with no control at all is only trusted
 * when a non-control mutant differs, because that difference is itself the
 * demonstration; a run with neither has shown nothing about its own sight and exits
 * **2** saying so. The same code covers a mutation that does not apply exactly once:
 * a replacement that occurs zero times or twice is a comparison of the wrong program.
 *
 * ## Usage
 *
 * ```text
 * node scripts/mutation-equivalence.mjs <config.json> [--json]
 * ```
 *
 * The config is read at this boundary and nothing downstream re-reads it:
 *
 * ```json
 * {
 *   "module": "dist/application/workspaceManifest.js",
 *   "export": "readWorkspaceManifest",
 *   "call": "directory",
 *   "inputs": "workspaceManifest.inputs.json",
 *   "mutants": [
 *     { "id": "e1", "what": "…", "from": "…", "to": "…" },
 *     { "id": "c1", "what": "…", "from": "…", "to": "…", "control": true }
 *   ]
 * }
 * ```
 *
 * - `module` and `inputs` are resolved relative to the config's own directory, and
 *   `inputs` may be an array instead of a path. The module is the built file, so
 *   `npm run compile` has to have run first; this tool never compiles and never
 *   writes the tree beyond the mutants it removes.
 * - `call: "directory"` invokes `export(root)` where `root` is a fresh temporary
 *   directory holding the input's `files`; a file's contents are a string, or
 *   `{ "base64": "…" }` for bytes.
 * - `call: "arguments"` invokes `export(...input.args)`; an argument written
 *   `{ "$undefined": true }` is passed as `undefined`, because JSON has no such
 *   value and the difference between absent and present-but-undefined is the one
 *   this file exists to see.
 * - Each mutant's `from` must occur exactly once in the module. Mutants are written
 *   beside the module — so relative imports resolve to the same files the original
 *   imports — and removed when the run ends, by `finally`, by a refusal, and by
 *   signal. Ids must stay distinct after sanitising to a file name: `"a b"` and
 *   `"a_b"` name one path, and the second `import()` would be handed the first
 *   module from the ESM cache, so that collision is refused rather than compared.
 * - A `directory` input's file names must stay inside the input's own directory;
 *   an absolute path or a `..` segment is refused.
 *
 * Exit codes: **0** every non-control mutant is indistinguishable over these inputs,
 * every control is distinguishable, and the run demonstrated its sight — a run with
 * no control counts only when a non-control differs; **1** a non-control mutant is
 * distinguishable (a finding: these inputs separate it); **2** the comparison cannot
 * be trusted (a blind control, no control and no difference, an ambiguous mutation, a
 * config this boundary refuses, or an unexpected error while comparing — the
 * instrument breaking is not a finding, and Node's default exit 1 would read as
 * one). The `--json` report carries the same verdict
 * under `untrustworthy`, which is `null` when the run is sound.
 *
 * [#57]: https://github.com/Antruly/uvp/issues/57
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Exit codes, in one place because the golden asserts them by name. */
const EXIT = { equivalent: 0, distinguishable: 1, untrustworthy: 2 };

/**
 * Every mutant file this run wrote beside the module.
 *
 * Module scope, because a refusal is one of the ways a run ends: `fail` exits
 * without unwinding, so a `finally` cannot remove what an earlier mutant wrote and
 * a config refused midway would otherwise leave `.mutant-*` files in the tree.
 */
const written = [];

/** Removes every mutant file this run wrote, and forgets them. */
const removeWritten = () => {
  for (const path of written) {
    rmSync(path, { force: true });
  }
  written.length = 0;
};

/** A shape-preserving deep copy: a key present with `undefined` stays present. */
const stable = (value) => {
  if (value === undefined) {
    return { $undefined: true };
  }
  if (Array.isArray(value)) {
    return value.map(stable);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, stable(entry)]));
  }
  return value;
};

/** Every place two stable shapes differ, each named by its path. */
const differences = (left, right, path = "") => {
  if (Object.is(left, right)) {
    return [];
  }
  if (typeof left !== typeof right) {
    return [`${path}: ${typeof left} vs ${typeof right}`];
  }
  if (left === null || right === null) {
    return [`${path}: ${String(left)} vs ${String(right)}`];
  }
  if (typeof left !== "object") {
    return [`${path}: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`];
  }
  const found = [];
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const here = path === "" ? key : `${path}.${key}`;
    if (!Object.hasOwn(left, key)) {
      found.push(`${here}: absent from the original`);
    } else if (!Object.hasOwn(right, key)) {
      found.push(`${here}: absent from the mutant`);
    } else {
      found.push(...differences(left[key], right[key], here));
    }
  }
  return found;
};

const fail = (message) => {
  removeWritten();
  process.stderr.write(`mutation-equivalence: ${message}\n`);
  process.exit(EXIT.untrustworthy);
};

/** `{ returned }` or `{ threw }` as a value, so the two are compared, not confused. */
const outcomeOf = async (call) => {
  try {
    return { returned: await call() };
  } catch (cause) {
    const name = cause?.constructor?.name ?? "Error";
    return { threw: `${name}: ${String(cause?.message ?? cause)}` };
  }
};

/** One input as the caller wrote it, checked here rather than trusted. */
const inputOf = (raw, index) => {
  if (raw === null || typeof raw !== "object" || typeof raw.label !== "string") {
    fail(`inputs[${index}] needs a string "label"`);
  }
  return raw;
};

const readConfig = (path) => {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    fail(`cannot read the config at ${path}`);
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    fail(`the config at ${path} is not JSON: ${String(cause.message)}`);
  }
};

/** The config's inputs, from the array it carries or the file it names. */
const inputsOf = (config, configDir) => {
  let list = config.inputs;
  if (typeof list === "string") {
    try {
      list = JSON.parse(readFileSync(resolve(configDir, list), "utf8"));
    } catch (cause) {
      fail(
        `cannot read "inputs" at ${resolve(configDir, config.inputs)}: ${String(cause.message)}`,
      );
    }
  }
  if (!Array.isArray(list) || list.length === 0) {
    fail(`"inputs" names no inputs`);
  }
  return list.map(inputOf);
};

const mutantsOf = (config) => {
  if (!Array.isArray(config.mutants) || config.mutants.length === 0) {
    fail(`"mutants" names no mutants`);
  }
  const seen = new Set();
  return config.mutants.map((mutant, index) => {
    if (typeof mutant.id !== "string" || mutant.id === "") {
      fail(`mutants[${index}] needs a non-empty string "id"`);
    }
    if (seen.has(mutant.id)) {
      fail(`mutants[${index}] repeats the id ${JSON.stringify(mutant.id)}`);
    }
    seen.add(mutant.id);
    if (typeof mutant.from !== "string" || typeof mutant.to !== "string") {
      fail(`mutant ${mutant.id} needs string "from" and "to" texts`);
    }
    return mutant;
  });
};

/** The module's source with a mutant applied, refusing an edit that is not unique. */
const mutatedSource = (source, mutant) => {
  const occurrences = source.split(mutant.from).length - 1;
  if (occurrences !== 1) {
    fail(
      `mutant ${mutant.id}: its "from" text occurs ${String(occurrences)} time(s) in the module, not once`,
    );
  }
  // A replacer function, not the replacement string: `$&`, `$1` and the other `$`
  // patterns in a mutant's own text are replacement syntax to `String.replace` and
  // would splice in the matched text instead of the replacement the report gave.
  return source.replace(mutant.from, () => mutant.to);
};

/** Where a mutant lives: beside the module, so its relative imports still resolve. */
const mutantPathOf = (modulePath, id) => {
  const extension = extname(modulePath);
  const safe = id.replaceAll(/[^A-Za-z0-9_.-]/gu, "_");
  return resolve(
    dirname(modulePath),
    `${basename(modulePath, extension)}.mutant-${safe}${extension}`,
  );
};

/**
 * Refuses two ids that sanitise to one mutant path.
 *
 * `import()` caches by URL, so the second mutant would be handed the first one's
 * module and compared as a program nobody described — a false "equivalent" is the
 * instrument's worst answer, so the collision is refused rather than hashed around.
 */
const checkPathsDistinct = (modulePath, mutants) => {
  const named = new Map();
  for (const mutant of mutants) {
    const path = mutantPathOf(modulePath, mutant.id);
    const previous = named.get(path);
    if (previous !== undefined) {
      fail(
        `mutants ${JSON.stringify(previous)} and ${JSON.stringify(mutant.id)} both resolve to ` +
          `${path}; ids must stay distinct after sanitising`,
      );
    }
    named.set(path, mutant.id);
  }
};

/** An input's file path, refused when it would escape the input's own directory. */
const inputFilePathOf = (root, name) => {
  const target = resolve(root, name);
  const inside = relative(root, target);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    fail(`input file ${JSON.stringify(name)} is outside the input's directory`);
  }
  return target;
};

/** An input's temporary directory, and the call that runs inside it. */
const directoryCall = async (fn, input) => {
  const root = await mkdtemp(resolve(tmpdir(), "uvp-equivalence-"));
  try {
    for (const [name, contents] of Object.entries(input.files ?? {})) {
      const target = inputFilePathOf(root, name);
      await mkdir(dirname(target), { recursive: true });
      if (typeof contents === "string") {
        await writeFile(target, contents, "utf8");
      } else {
        await writeFile(target, Buffer.from(String(contents.base64), "base64"));
      }
    }
    return await outcomeOf(() => fn(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

/** `{ "$undefined": true }` back to the value JSON cannot spell. */
const revive = (value) => {
  if (Array.isArray(value)) {
    return value.map(revive);
  }
  if (value !== null && typeof value === "object") {
    if (Object.keys(value).length === 1 && value["$undefined"] === true) {
      return undefined;
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, revive(entry)]));
  }
  return value;
};

const argumentsCall = async (fn, input) => {
  if (!Array.isArray(input.args)) {
    fail(`input ${JSON.stringify(input.label)} needs an "args" array for an arguments call`);
  }
  return await outcomeOf(() => fn(...revive(input.args)));
};

const callOf = (config) => {
  if (config.call === "directory") {
    return directoryCall;
  }
  if (config.call === "arguments") {
    return argumentsCall;
  }
  fail(`"call" must be "directory" or "arguments"`);
};

/** The modules the comparison needs: the original, then one per mutant. */
const loadAll = async (modulePath, source, mutants) => {
  const original = await import(pathToFileURL(modulePath).href);
  const loaded = new Map();
  for (const mutant of mutants) {
    const path = mutantPathOf(modulePath, mutant.id);
    writeFileSync(path, mutatedSource(source, mutant), "utf8");
    written.push(path);
    loaded.set(mutant.id, await import(pathToFileURL(path).href));
  }
  return { original, loaded };
};

/** Counts, per mutant, the inputs that told it from the original, and the first. */
const compareAll = async (originalExport, { seen, inputs, mutants, call }) => {
  for (const input of inputs) {
    const base = stable(await call(originalExport, input));
    for (const mutant of mutants) {
      const record = seen.get(mutant.id);
      const found = differences(base, stable(await call(record.exported, input)));
      if (found.length > 0) {
        record.differences += 1;
        // Four paths per input is enough to read the difference; the total travels
        // with them so a truncated list says so rather than looking complete.
        record.first ??= { label: input.label, found: found.slice(0, 4), total: found.length };
      }
    }
  }
};

/** Each mutant's verdict, and the exit code those verdicts add up to. */
const verdictsOf = (mutants, seen, inputCount) => {
  const results = mutants.map((mutant) => {
    const record = seen.get(mutant.id);
    const control = mutant.control === true;
    let verdict = "indistinguishable";
    if (record.differences > 0) {
      verdict = "distinguishable";
    } else if (control) {
      verdict = "blind";
    }
    return {
      id: mutant.id,
      what: mutant.what ?? "",
      control,
      inputs: inputCount,
      differences: record.differences,
      first: record.first,
      verdict,
    };
  });
  const findings = results.filter((result) => !result.control && result.differences > 0);
  const blind = results.filter((result) => result.control && result.differences === 0);
  const controls = results.filter((result) => result.control).length;
  // "No difference" is only evidence when something in the run shows the comparison
  // can see one: a control that differed, or a non-control that did. A run with
  // neither has demonstrated nothing about itself, and says so rather than passing.
  const unproven =
    blind.length > 0
      ? `the control(s) ${blind.map((result) => result.id).join(", ")} were not distinguishable`
      : controls === 0 && findings.length === 0
        ? "no control was supplied and no mutant differs, so nothing shows the comparison can see"
        : null;
  const exitCode =
    unproven !== null
      ? EXIT.untrustworthy
      : findings.length > 0
        ? EXIT.distinguishable
        : EXIT.equivalent;
  return { results, findings, blind, controls, exitCode, unproven };
};

const jsonReport = (config, modulePath, inputs, verdicts) => ({
  module: modulePath,
  export: config.export,
  call: config.call,
  inputs: inputs.length,
  mutants: verdicts.results,
  controls: verdicts.controls,
  blindControls: verdicts.blind.map((result) => result.id),
  findings: verdicts.findings.map((result) => result.id),
  untrustworthy: verdicts.unproven,
  exitCode: verdicts.exitCode,
});

/** The smallest sufficient answer: a table, then the first difference each found. */
const textReport = (config, inputs, verdicts) => {
  const lines = [
    `mutation-equivalence: ${config.module}#${config.export}, ${config.call} call, ${String(inputs.length)} input(s) per mutant`,
    "",
    "| mutant | verdict | inputs |",
    "| --- | --- | --- |",
  ];
  for (const result of verdicts.results) {
    const verdict =
      result.verdict === "blind"
        ? "**blind** — a control the comparison could not see"
        : result.differences === 0
          ? "indistinguishable over these inputs"
          : `distinguishable on ${String(result.differences)}`;
    lines.push(
      `| ${result.id}${result.control ? " (control)" : ""} | ${verdict} | ${String(result.differences)} |`,
    );
  }
  lines.push("");
  for (const result of verdicts.results) {
    lines.push(`${result.id}: ${result.what}`);
    if (result.first === null) {
      lines.push(
        `  no input distinguishes it from the module among the ${String(inputs.length)} supplied`,
      );
    } else {
      const truncated =
        result.first.total > result.first.found.length
          ? ` (first ${String(result.first.found.length)} of ${String(result.first.total)} differences)`
          : "";
      lines.push(`  first: ${JSON.stringify(result.first.label)}${truncated}`);
      for (const difference of result.first.found) {
        lines.push(`  ${difference}`);
      }
    }
  }
  const tested = verdicts.results.filter((result) => !result.control).length;
  lines.push(
    "",
    `verdict: ${String(tested - verdicts.findings.length)} of ${String(tested)} non-control mutant(s) indistinguishable over ${String(inputs.length)} input(s); ${String(verdicts.controls - verdicts.blind.length)} of ${String(verdicts.controls)} control(s) seen`,
  );
  if (verdicts.unproven !== null) {
    lines.push(`untrustworthy: ${verdicts.unproven}`);
  }
  return lines.join("\n");
};

const main = async () => {
  const json = process.argv.includes("--json");
  const configPath = process.argv.slice(2).find((argument) => !argument.startsWith("--"));
  if (configPath === undefined) {
    fail("usage: node scripts/mutation-equivalence.mjs <config.json> [--json]");
  }

  const config = readConfig(configPath);
  const configDir = dirname(resolve(configPath));
  if (typeof config.module !== "string" || config.module === "") {
    fail(`"module" names no file`);
  }
  const modulePath = resolve(configDir, config.module);
  if (!existsSync(modulePath)) {
    fail(`"module" names no file at ${modulePath}`);
  }
  if (typeof config.export !== "string" || config.export === "") {
    fail(`"export" names no function`);
  }
  const call = callOf(config);
  const inputs = inputsOf(config, configDir);
  const mutants = mutantsOf(config);
  checkPathsDistinct(modulePath, mutants);

  const source = await readFile(modulePath, "utf8");
  process.once("SIGINT", () => {
    removeWritten();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    removeWritten();
    process.exit(143);
  });

  const { original, loaded } = await loadAll(modulePath, source, mutants).catch((cause) => {
    fail(`importing a module failed: ${String(cause?.message ?? cause)}`);
  });
  const originalExport = original[config.export];
  if (typeof originalExport !== "function") {
    fail(`the module exports no function named ${JSON.stringify(config.export)}`);
  }
  const seen = new Map();
  for (const mutant of mutants) {
    const exported = loaded.get(mutant.id)[config.export];
    if (typeof exported !== "function") {
      fail(`mutant ${mutant.id} exports no function named ${JSON.stringify(config.export)}`);
    }
    seen.set(mutant.id, { exported, differences: 0, first: null });
  }

  try {
    await compareAll(originalExport, { seen, inputs, mutants, call });
  } finally {
    removeWritten();
  }

  const verdicts = verdictsOf(mutants, seen, inputs.length);
  process.stdout.write(
    json
      ? JSON.stringify(jsonReport(config, modulePath, inputs, verdicts), null, 2) + "\n"
      : textReport(config, inputs, verdicts) + "\n",
  );
  return verdicts.exitCode;
};

process.exitCode = await main().catch((cause) => {
  // An unexpected rejection is the instrument breaking, not a finding. Node's
  // default exit 1 would report it as `distinguishable`, so the third state is
  // named here rather than left to the runtime's choice of code.
  fail(`the comparison failed: ${String(cause?.message ?? cause)}`);
});
