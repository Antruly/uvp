import { runKeySpans } from "./runKeySpans.mjs";

/**
 * Read a workflow file into the jobs, steps, and artifact uses a check can judge.
 *
 * Line-based, on purpose — the repository has no YAML parser and does not want one
 * for this. Each job keeps its own `if:` and its steps; each step keeps its `if:`,
 * its `uses:`, and its `with:` block. Conditions are recorded as text and parsed by
 * whoever needs them, so this module judges nothing.
 *
 * What it buys over a regex over the whole file is position. `if:` values are read
 * on the line that holds them and only at the level that owns them, a step is only
 * a step inside a `steps:` block, and `run:` bodies are masked before any of it
 * (`lib/runKeySpans.mjs`) — a shell script holding a line that reads like a step, or
 * an `if [ … ]`, cannot be one. Every one of those is a real line in this
 * repository's workflow rather than a hypothetical, and the `needs:` list below is
 * the one that caught this scanner: its items are indented exactly like steps.
 */

/**
 * Raised for anything this cannot read. Reported by the caller, never skipped: a
 * reader that shrugs at a line it does not understand reports "nothing wrong" for a
 * file it did not finish reading.
 */
export class Unreadable extends Error {}

/** A job header: two spaces, a name, a colon, nothing else. */
const JOB_HEADER = /^ {2}(?<job>[A-Za-z_][A-Za-z0-9_-]*):[ \t]*$/u;
/** A job-level key: four spaces. */
const JOB_KEY = /^ {4}(?<key>[A-Za-z_-]+):[ \t]?(?<rest>.*)$/u;
/** The start of a step: six spaces, a dash. */
const STEP_START = /^ {6}-[ \t]+(?<rest>.*)$/u;
/** A step-level key: eight spaces. */
const STEP_KEY = /^ {8}(?<key>[A-Za-z_-]+):[ \t]?(?<rest>.*)$/u;
/** A key inside a step's `with:` block: ten spaces. */
const WITH_KEY = /^ {10}(?<key>[A-Za-z_-]+):[ \t]?(?<rest>.*)$/u;
/** `key: value`, for the rest of a line that began with `- `. */
const INLINE_KEY = /^(?<key>[A-Za-z_-]+):[ \t]?(?<rest>.*)$/u;

/** The two actions that move an artifact between jobs. */
export const UPLOAD = "actions/upload-artifact@";
export const DOWNLOAD = "actions/download-artifact@";

/** Where a line is read from, for a message about it. */
const at = (file, lineNumber) => `${file}:${String(lineNumber)}`;

const startScan = (file) => ({
  file,
  jobs: new Map(),
  job: undefined,
  step: undefined,
  inWith: false,
  inSteps: false,
});

const readIf = (rest, where) => {
  if (rest === "") throw new Unreadable(`${where}: the \`if:\` value is on the next line`);
  // Recorded, not parsed. A condition is judged only where it can change an answer.
  return { text: rest, where };
};

const openJob = (state, name) => {
  state.job = { name, ifField: undefined, steps: [], uploads: [], downloads: [] };
  state.jobs.set(name, state.job);
  state.step = undefined;
  state.inWith = false;
  state.inSteps = false;
};

const recordStepKey = (state, key, rest, lineNumber) => {
  const { file } = state;
  if (key === "with") {
    state.inWith = true;
    return;
  }
  state.inWith = false;
  const { step } = state;
  if (key === "name") step.name = rest;
  if (key === "uses") {
    if (rest === "") throw new Unreadable(`${at(file, lineNumber)}: \`uses:\` with no value`);
    step.uses = rest.trim();
  }
  if (key === "if") step.ifField = readIf(rest, at(file, lineNumber));
};

const openStep = (state, rest, lineNumber) => {
  const { file } = state;
  state.step = { name: undefined, ifField: undefined, uses: undefined, with: {} };
  state.job.steps.push(state.step);
  const inline = INLINE_KEY.exec(rest.trim());
  if (inline === null) {
    if (rest.trim() !== "") {
      throw new Unreadable(`${at(file, lineNumber)}: cannot read the step "${rest}"`);
    }
    state.inWith = true;
    return;
  }
  recordStepKey(state, inline.groups.key, inline.groups.rest, lineNumber);
};

const recordJobKey = (state, key, rest, lineNumber) => {
  const { file } = state;
  // A step only ever sits under `steps:`. Everything else at this level — and every
  // nested line under it, `needs:`' list items included — is not a step, and
  // `      - changes` under `needs:` reads exactly like one. Position rather than
  // shape decides, because the two are the same shape.
  state.inSteps = key === "steps";
  state.step = undefined;
  state.inWith = false;
  if (key !== "if") return;
  if (state.job.ifField !== undefined) {
    throw new Unreadable(`${at(file, lineNumber)}: a second \`if:\` on the job`);
  }
  state.job.ifField = readIf(rest, at(file, lineNumber));
};

const recordWithKey = (state, key, rest, lineNumber) => {
  const { file } = state;
  if (rest === "") {
    throw new Unreadable(`${at(file, lineNumber)}: \`${key}:\` value on the next line`);
  }
  state.step.with[key] = rest.trim();
};

/** One line, dispatched by where it sits rather than by what it looks like. */
const handleLine = (state, line, lineNumber) => {
  const header = JOB_HEADER.exec(line);
  if (header !== null) {
    openJob(state, header.groups.job);
    return;
  }
  if (state.job === undefined) return;

  const jobKey = JOB_KEY.exec(line);
  if (jobKey !== null) {
    recordJobKey(state, jobKey.groups.key, jobKey.groups.rest, lineNumber);
    return;
  }
  if (!state.inSteps) return;

  const start = STEP_START.exec(line);
  if (start !== null) {
    openStep(state, start.groups.rest, lineNumber);
    return;
  }

  const withKey = state.inWith ? WITH_KEY.exec(line) : null;
  if (withKey !== null) {
    recordWithKey(state, withKey.groups.key, withKey.groups.rest, lineNumber);
    return;
  }

  const stepKey = STEP_KEY.exec(line);
  if (stepKey !== null) {
    recordStepKey(state, stepKey.groups.key, stepKey.groups.rest, lineNumber);
  }
};

/**
 * Turn each step's `uses:` into an artifact reference on its job.
 *
 * Collected after the scan rather than as the steps are read, because a step's
 * effective condition falls back to its job's, which may be read after it.
 */
const collectArtifactSteps = (state) => {
  const { file } = state;
  for (const job of state.jobs.values()) {
    for (const step of job.steps) {
      const uses = step.uses ?? "";
      const record = { job, step: step.name ?? uses, ifField: step.ifField };
      if (uses.startsWith(UPLOAD)) job.uploads.push({ ...record, name: step.with.name });
      if (uses.startsWith(DOWNLOAD)) job.downloads.push({ ...record, with: step.with });
    }
    for (const upload of job.uploads) {
      if (upload.name === undefined) {
        throw new Unreadable(`${file}: ${job.name} uploads an artifact with no \`name:\``);
      }
    }
  }
};

/** The jobs in one workflow, keyed by name. Raises `Unreadable` on anything else. */
export const readWorkflow = (text, file) => {
  const masked = new Set(runKeySpans(text).flatMap((span) => span.bodyLines));
  const state = startScan(file);
  text.split("\n").forEach((line, index) => {
    if (!masked.has(index + 1)) handleLine(state, line, index + 1);
  });
  collectArtifactSteps(state);
  return state.jobs;
};
