import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import { commandName } from "../../../src/cli/commandSpec.js";
import { COMMANDS } from "../../../src/cli/commands/index.js";
import { EXIT_NO, EXIT_OK, EXIT_WRONG } from "../../../src/cli/exitCodes.js";
import { parseUvpError } from "../../../src/domain/errors.js";
import { freePort } from "../../support/ports.js";

/**
 * The CLI as a process.
 *
 * Every other lane that touches the CLI either calls `runCli` in-process or
 * checks the registry against the contracts. Neither can see the thing a caller
 * depends on, because both stop at the function boundary: what a *process*
 * prints, and what it exits with. The published `uvp` is a bin script, three
 * streams' worth of convention, and an exit code, and that convention is what
 * scripts and agents are written against.
 *
 * Three promises are load-bearing enough to check from outside:
 *
 * - **stdout carries a result or nothing.** `uvp build --json | jq` must never
 *   have to distinguish "the build failed" from "uvp could not parse your flag"
 *   by inspecting the shape of what it received. The first is a result with
 *   `succeeded: false`; the second never reaches stdout.
 * - **an exit code says which question was asked.** `0` it worked, `1` the
 *   operation ran and the answer is no, `2` the question could not be put — a bad
 *   flag, no such workspace. A retry loop keyed on `1` is pointless; one keyed on
 *   `2` after fixing the environment is the whole point.
 * - **a failure is the error contract, never a stack trace.** A caller that
 *   mistyped a flag should be told which flag, not shown the inside of uvp.
 *
 * The invocations are gathered once, at module scope, and each `describe` below
 * asks a different question of the same observations — so the file costs about
 * thirty process starts rather than one per assertion. Every invocation is
 * read-only or fails before it writes: nothing here builds, launches, or
 * scaffolds anything, because a boundary lane that left a service running would
 * be a boundary lane nobody could run twice.
 *
 * ### One divergence is recorded, not asserted
 *
 * Nothing answered at the far end of a connection is reported two ways today.
 * `uvp ws` raises `endpoint_unreachable` and exits `1`; `uvp soap` returns a
 * result with `outcome: "transport_error"` and exits `2`. Both command specs
 * describe the same intent — "uvp could not put the question to the service at
 * all" — and the CLI's own `soap` verdict says that intent is the code for a
 * wrong environment. So one of the two is wrong, and the answer is not this
 * lane's to decide: it is a question about the exit-code table, which every tool
 * shares. The observations below pin the stream shapes, which do agree, and pin
 * the codes only where the intent is not in question.
 */

const promisified = promisify(execFile);

const REPOSITORY = resolve(import.meta.dirname, "..", "..", "..");
/** The published entry point — `bin.uvp` in package.json, what `npm i -g` links. */
const UVP = join(REPOSITORY, "scripts", "uvp.mjs");

/** A process that has not answered in this long is not slow, it is hung. */
const TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

interface Observation {
  /** What this invocation is here to observe, in the words of the contract. */
  readonly why: string;
  readonly args: readonly string[];
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}

const invoke = async (args: readonly string[]): Promise<Omit<Observation, "why">> => {
  const command = `uvp ${args.join(" ")}`;
  try {
    const { stdout, stderr } = await promisified(process.execPath, [UVP, ...args], {
      cwd: REPOSITORY,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    return { args, exit: EXIT_OK, stdout, stderr };
  } catch (cause) {
    const failure = cause as { code?: unknown; stdout?: string; stderr?: string; message: string };
    // A signal or a timeout is a different failure from a non-zero exit, and
    // folding it into "exited with a code" would make a hang look like an answer.
    if (typeof failure.code !== "number") {
      throw new Error(`${command} did not exit: ${failure.message}`);
    }
    return {
      args,
      exit: failure.code,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
};

/**
 * One JSON value, or a failure naming what was there instead.
 *
 * `JSON.parse` is the check: two objects, a banner line before the result, or a
 * trailing summary all make it throw. "The result object, verbatim, and then
 * nothing" is the promise, and this is that promise written as a parser.
 */
const soleJson = (text: string, where: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${where} is not one JSON value: ${JSON.stringify(text.slice(0, 200))}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${where} is JSON but not an object: ${JSON.stringify(text.slice(0, 200))}`);
  }
  return parsed as Record<string, unknown>;
};

/** A scratch directory, canonicalised so CMake and the kernel agree on its name. */
const SCRATCH = realpathSync(tmpdir());
const workspace = join(SCRATCH, `uvp-cli-boundary-${String(process.pid)}`);
const ABSENT_WORKSPACE = join(workspace, "no-such-workspace");
const OCCUPIED = join(workspace, "occupied");

mkdirSync(workspace, { recursive: true });
mkdirSync(OCCUPIED, { recursive: true });
writeFileSync(join(OCCUPIED, "keep.txt"), "written before uvp was asked anything\n");

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/**
 * A port that is free and stays free, so a connection to it is refused.
 *
 * Refused, not merely unanswered: a listener that accepts and stays silent would
 * hang until the tool's own timeout, where a closed port fails immediately and
 * the same way on every machine.
 */
const closedPort = await freePort();
const CLOSED_HTTP = `http://127.0.0.1:${String(closedPort)}/items`;
const CLOSED_WS = `ws://127.0.0.1:${String(closedPort)}/echo`;

const INVOCATIONS: readonly { readonly why: string; readonly args: readonly string[] }[] = [
  // The two shapes of a result: a report that judges nothing, and the same
  // report with a question attached. `uvp load` is the clearest example of the
  // distinction the exit codes exist to draw, because it is the same command
  // either way.
  {
    why: "a report that judges nothing",
    args: ["load", CLOSED_HTTP, "--requests", "3", "--concurrency", "1", "--json"],
  },
  {
    why: "the same report with a yes-or-no question attached",
    args: [
      "load",
      CLOSED_HTTP,
      "--requests",
      "3",
      "--concurrency",
      "1",
      "--max-error-rate",
      "0",
      "--json",
    ],
  },
  { why: "a read-only report whose verdict depends on the host", args: ["doctor", "--json"] },
  // The caller's mistakes. Each one has to reach stderr and nothing else.
  { why: "a missing positional argument", args: ["build", "--json"] },
  { why: "a workspace that is not there", args: ["build", ABSENT_WORKSPACE, "--json"] },
  { why: "a command that does not exist", args: ["buidl", "--json"] },
  { why: "a mistyped two-word command", args: ["capture", "statr", "--json"] },
  { why: "a flag that does not exist", args: ["build", "--nope", "--json"] },
  { why: "no command at all, under --json", args: ["--json"] },
  {
    why: "an exchange that was never captured",
    args: ["assert", "--exchange", "ex_nope", "--assert", "status=200", "--json"],
  },
  // Assertions the mini-language cannot lower into a check that means what the
  // caller wrote. Each has to be refused during argument reading, before the
  // workspace is opened or anything is built — the alternative is a check that
  // runs, is scoped to something the caller did not name, and passes.
  //
  // The word "verify" below is a red herring for the path: the workspace exists,
  // so a refusal here cannot be blamed on a missing directory.
  {
    why: "an assertion that no check applies a regex to a JSON path",
    args: [
      "verify",
      workspace,
      "--port",
      "1",
      "--request",
      "GET",
      "/",
      "--assert",
      "json:$.v~=^a",
      "--json",
    ],
  },
  {
    why: "a negated assertion, which verify does not have",
    args: [
      "verify",
      workspace,
      "--port",
      "1",
      "--request",
      "GET",
      "/",
      "--assert",
      "!status=200",
      "--json",
    ],
  },
  {
    why: "a latency comparison that is not a duration",
    args: [
      "verify",
      workspace,
      "--port",
      "1",
      "--request",
      "GET",
      "/",
      "--assert",
      "latency<soon",
      "--json",
    ],
  },
  {
    why: "a status assertion with no status in it",
    args: [
      "verify",
      workspace,
      "--port",
      "1",
      "--request",
      "GET",
      "/",
      "--assert",
      "status=",
      "--json",
    ],
  },
  {
    why: "an assertion field the contract does not declare",
    args: [
      "verify",
      workspace,
      "--port",
      "1",
      "--request",
      "GET",
      "/",
      "--assert",
      '{"kind":"status_equals","expected":200,"retries":3}',
      "--json",
    ],
  },
  {
    why: "an assertion before the request it would apply to",
    args: [
      "verify",
      workspace,
      "--port",
      "1",
      "--assert",
      "status=200",
      "--request",
      "GET",
      "/",
      "--json",
    ],
  },
  // Nothing answered. See the divergence note above.
  { why: "a handshake that cannot be attempted", args: ["ws", CLOSED_WS, "--json"] },
];

const observed: readonly Observation[] = await (async () => {
  const gathered: Observation[] = [];
  for (const invocation of INVOCATIONS) {
    gathered.push({ why: invocation.why, ...(await invoke(invocation.args)) });
  }
  return gathered;
})();

const byWhy = (why: string): Observation => {
  const found = observed.find((entry) => entry.why === why);
  if (found === undefined) throw new Error(`no observation recorded for "${why}"`);
  return found;
};

describe("what the process promises about its streams", () => {
  it("never succeeds or fails silently", () => {
    // The worst outcome for a caller is a code with nothing to act on: a script
    // sees a failure and has no message, a person sees a number. Every
    // invocation has to say something on one stream or the other.
    const silent = observed
      .filter((entry) => entry.stdout.trim() === "" && entry.stderr.trim() === "")
      .map((entry) => `uvp ${entry.args.join(" ")} exited ${String(entry.exit)} saying nothing`);
    expect(silent).toEqual([]);
  });

  it("keeps stdout for results, so a failure never arrives there", () => {
    // The property a pipe depends on. A result is an object that names its tool;
    // the error contract is an object that carries a code. Nothing may appear on
    // stdout that is neither, and no failure may appear at all.
    const wrong: string[] = [];
    for (const entry of observed) {
      if (entry.stdout.trim() === "") continue;
      const parsed = soleJson(entry.stdout, `uvp ${entry.args.join(" ")} stdout`);
      const where = `uvp ${entry.args.join(" ")}`;
      if (parsed["tool"] === undefined) wrong.push(`${where} printed an object with no tool`);
      if (parsed["code"] !== undefined) wrong.push(`${where} printed a failure on stdout`);
    }
    expect(wrong).toEqual([]);
  });

  it("prints failures as the error contract, and nothing else", () => {
    // Validated against the real schema rather than by looking for a field: an
    // error missing its category or its remedy is not a contract, and a caller
    // that branches on `category` would read a missing one as a fall-through.
    const wrong: string[] = [];
    for (const entry of observed) {
      if (entry.stderr.trim() === "") continue;
      const where = `uvp ${entry.args.join(" ")} stderr`;
      try {
        const error = parseUvpError(soleJson(entry.stderr, where));
        expect(error.remediation.action.length).toBeGreaterThan(0);
      } catch (cause) {
        wrong.push(`${where}: ${(cause as Error).message}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("puts nothing on stdout when the question could not be put", () => {
    // Exit `2` is the code a caller acts on by fixing its own invocation. A
    // result on stdout alongside it would be a partial answer to a question that
    // was never asked.
    const wrong = observed
      .filter((entry) => entry.exit === EXIT_WRONG)
      .filter((entry) => entry.stdout.trim() !== "")
      .map((entry) => `uvp ${entry.args.join(" ")}`);
    expect(wrong).toEqual([]);
  });

  it("reaches all three codes, so none of the above is vacuous", () => {
    // Without this, a table that happened to contain only successes would
    // satisfy every property above by never exercising the interesting half.
    const codes = new Set(observed.map((entry) => entry.exit));
    expect([...codes].sort()).toEqual([EXIT_OK, EXIT_NO, EXIT_WRONG]);
  });
});

describe("an answer of no, and a question that could not be asked", () => {
  it("exits 1 with the result when the caller attached a question", () => {
    const judged = byWhy("the same report with a yes-or-no question attached");
    expect(judged.exit).toBe(EXIT_NO);
    // The report is still a result: the caller asked whether the service was
    // good enough, and the answer rests on numbers it can read.
    const result = soleJson(judged.stdout, "uvp load --max-error-rate");
    expect(result["tool"]).toBe("uvp_load_test");
    expect(result["requests_failed"]).toBe(3);
    expect(judged.stderr.trim()).toBe("");
  });

  it("exits 0 with the same result when the caller did not", () => {
    // The pair is the point. Reporting is not judging, and a tool that exited 1
    // here would make every measurement a test.
    const plain = byWhy("a report that judges nothing");
    expect(plain.exit).toBe(EXIT_OK);
    expect(soleJson(plain.stdout, "uvp load")["requests_sent"]).toBe(3);
    expect(plain.stderr.trim()).toBe("");
  });

  it("exits 2, not 1, for a bad flag — the caller's mistake, not an answer", () => {
    const refusal = byWhy("a flag that does not exist");
    expect(refusal.exit).toBe(EXIT_WRONG);
    expect(refusal.stdout.trim()).toBe("");
    const error = parseUvpError(soleJson(refusal.stderr, "uvp build --nope"));
    expect(error.code).toBe("invalid_request");
    expect(error.category).toBe("invalid_input");
    // `details` is where a caller finds the offending word without parsing the
    // message, and the message is where a person finds it.
    expect(error.details?.["flag"]).toBe("nope");
    expect(error.message).toContain("--nope");
  });

  it("names the workspace it could not find", () => {
    const refusal = byWhy("a workspace that is not there");
    expect(refusal.exit).toBe(EXIT_WRONG);
    const error = parseUvpError(soleJson(refusal.stderr, "uvp build <absent>"));
    // `workspace_not_found` is an `unsupported_target`, which is on the "wrong
    // environment" side of the line: the caller has to create or point at a
    // workspace before there is anything to build.
    expect(error.code).toBe("workspace_not_found");
    expect(error.category).toBe("unsupported_target");
    expect(error.message).toContain(ABSENT_WORKSPACE);
  });

  it("names the command words it did not recognise, both of them", () => {
    // `uvp capture statr` matched the prefix of two real commands and stopped at
    // a word that finished neither. Reporting only what matched would answer "no
    // command named capture", which is true of a prefix and useful to nobody.
    const typo = byWhy("a mistyped two-word command");
    expect(typo.exit).toBe(EXIT_WRONG);
    const error = parseUvpError(soleJson(typo.stderr, "uvp capture statr"));
    expect(error.details?.["command"]).toBe("capture statr");
    expect(error.message).toContain("capture statr");
  });

  it("treats a command that does not exist as a refusal, not as an empty command line", () => {
    // Both end up at exit 2, and they are different mistakes: one caller typed
    // the wrong word, the other typed nothing. A lane that only checked the code
    // could not tell them apart, so the message is checked too.
    const unknown = byWhy("a command that does not exist");
    expect(unknown.exit).toBe(EXIT_WRONG);
    expect(parseUvpError(soleJson(unknown.stderr, "uvp buidl")).message).toContain("buidl");

    const nothing = byWhy("no command at all, under --json");
    expect(nothing.exit).toBe(EXIT_WRONG);
    expect(nothing.stdout.trim()).toBe("");
    expect(parseUvpError(soleJson(nothing.stderr, "uvp --json")).code).toBe("invalid_request");
  });

  it("reports an exchange that was never captured as a refusal, not as a failed assertion", () => {
    // "The exchange is not in this session" is not "the assertion did not hold",
    // and a caller that read exit 1 here would edit its assertion instead of
    // starting a capture.
    const unknown = byWhy("an exchange that was never captured");
    expect(unknown.exit).toBe(EXIT_WRONG);
    expect(parseUvpError(soleJson(unknown.stderr, "uvp assert")).code).toBe("invalid_request");
  });

  it("reports a handshake it could not attempt with the contract on stderr", () => {
    // Exit 1: nothing answered, so the caller's question has an answer, and the
    // answer is no. Pinned as observed — see the divergence note at the top of
    // the file for why `uvp soap` disagrees about the code.
    const unreachable = byWhy("a handshake that cannot be attempted");
    expect(unreachable.exit).toBe(EXIT_NO);
    expect(unreachable.stdout.trim()).toBe("");
    const error = parseUvpError(soleJson(unreachable.stderr, CLOSED_WS));
    expect(error.code).toBe("endpoint_unreachable");
    expect(error.retryable).toBe(true);
  });
});

describe("an assertion uvp cannot honour is refused, not lowered", () => {
  /**
   * Every one of these used to be a check that ran and answered a question the
   * caller had not asked.
   *
   * `json:$.value~=^a` is the clearest: the evaluator has no kind that applies a
   * regular expression to a JSON path, so lowering it would either drop the path
   * and match the whole body or drop the pattern and compare the literal text —
   * and either way the result would still read as scoped to `$.value`. Refusing
   * costs the caller one turn; lowering costs them a wrong answer they have no
   * reason to doubt.
   */
  const refusals: readonly { readonly why: string; readonly names: string }[] = [
    {
      why: "an assertion that no check applies a regex to a JSON path",
      names: "regular expression",
    },
    { why: "a negated assertion, which verify does not have", names: "negated" },
    { why: "a latency comparison that is not a duration", names: "not a duration" },
    { why: "a status assertion with no status in it", names: "status code" },
    { why: "an assertion field the contract does not declare", names: "retries" },
  ];

  for (const { why, names } of refusals) {
    it(`refuses ${why}`, () => {
      const refused = byWhy(why);
      // 2, not 1: uvp could not ask the question, so there is no answer to
      // report. A caller that read 1 here would look for a failing service.
      expect(refused.exit, why).toBe(EXIT_WRONG);
      expect(refused.stdout.trim(), why).toBe("");
      const error = parseUvpError(soleJson(refused.stderr, `uvp verify (${why})`));
      expect(error.code).toBe("invalid_request");
      // The message names the offending word, so the caller can fix the
      // invocation without reading a schema.
      expect(error.message).toContain(names);
    });
  }

  it("refuses an assertion that precedes the request it would apply to", () => {
    // Order is what associates an assertion with a request, so an assertion
    // before any `--request` has nothing to attach to. Accepting it and
    // attaching it to the *next* request would be a guess, and a guess about
    // which response gets checked is the one guess this tool cannot make.
    const orphan = byWhy("an assertion before the request it would apply to");
    expect(orphan.exit).toBe(EXIT_WRONG);
    expect(parseUvpError(soleJson(orphan.stderr, "uvp verify")).message).toContain("--request");
  });
});

describe("a failure is never a stack trace", () => {
  it("reports a bad flag in the contract's voice, without uvp's internals", async () => {
    // The regression this pins: the words were parsed *outside* the handler's
    // error trap, so a misspelled flag escaped to the process-level trap and
    // arrived as `UvpFailure: Unknown flag …` with a `file:///…js:17:11` frame
    // after it. That tells a caller uvp is broken when the caller is.
    const human = await invoke(["build", "--nope"]);
    expect(human.exit).toBe(EXIT_WRONG);
    expect(human.stdout.trim()).toBe("");
    expect(human.stderr).toMatch(/^invalid_request: /u);
    expect(human.stderr).toContain("remedy:");
    expect(human.stderr).not.toContain("UvpFailure");
    expect(human.stderr).not.toMatch(/\n\s+at .*\.js:\d+/u);
  });

  it("reports an unknown command the same way", async () => {
    const human = await invoke(["buidl"]);
    expect(human.exit).toBe(EXIT_WRONG);
    expect(human.stdout.trim()).toBe("");
    expect(human.stderr).toMatch(/^invalid_request: /u);
    expect(human.stderr).not.toContain("UvpFailure");
    expect(human.stderr).not.toMatch(/\n\s+at .*\.js:\d+/u);
  });

  it("still answers a bare `uvp` with the command list, on stdout", async () => {
    // The one invocation that prints a page of prose on stdout and exits 2: a
    // person who typed `uvp` wants the list, and the code says they did not
    // finish asking. Under `--json` there is no such case, which the previous
    // describe pins.
    const bare = await invoke([]);
    expect(bare.exit).toBe(EXIT_WRONG);
    expect(bare.stdout).toContain("Usage: uvp COMMAND");
    expect(bare.stderr.trim()).toBe("");
  });
});

describe("help", () => {
  it("names every command, and nothing that is not one", async () => {
    const help = await invoke(["--help"]);
    expect(help.exit).toBe(EXIT_OK);
    expect(help.stderr.trim()).toBe("");
    // Read from the registry rather than from a list written here: the claim is
    // that the rendered page is the registry, and a copy would pass while the
    // page lost a command.
    const missing = COMMANDS.map(commandName).filter((name) => !help.stdout.includes(name));
    expect(missing, "commands the help page does not name").toEqual([]);
  });

  it("answers `--help` on every command with that command's usage", async () => {
    // Every command, not a sample: `--help` is the one thing that has to work
    // before anything else does, and it is generated from the spec rather than
    // written, so a command whose spec is malformed shows up here.
    const wrong: string[] = [];
    for (const command of COMMANDS) {
      const name = commandName(command);
      const help = await invoke([...command.path, "--help"]);
      if (help.exit !== EXIT_OK) wrong.push(`${name} exited ${String(help.exit)}`);
      if (!help.stdout.startsWith(command.summary)) {
        wrong.push(`${name} does not open with its summary`);
      }
      if (!help.stdout.includes(command.usage)) wrong.push(`${name} does not print its usage`);
      if (help.stderr.trim() !== "") wrong.push(`${name} wrote to stderr`);
    }
    expect(wrong).toEqual([]);
  });
});

describe("the words are the same however they are ordered", () => {
  it("reads a global flag before the command as the command's own", async () => {
    // `uvp --json doctor` is a reasonable thing to type. Both spellings have to
    // reach the same handler with the same input, or the flag's position becomes
    // a thing a caller has to remember.
    const after = await invoke(["doctor", "--json"]);
    const before = await invoke(["--json", "doctor"]);
    expect(before.exit).toBe(after.exit);
    // Ids and observation times are deliberately not part of the answer — a
    // random id and a clock reading are what make two runs distinguishable, and
    // comparing them would make every pair of calls differ.
    const shape = (text: string): unknown => {
      const result = soleJson(text, "uvp doctor");
      return {
        tool: result["tool"],
        unknownQuestions: (result["unknowns"] as { question: string; reason: string }[]).map(
          (unknown) => [unknown.question, unknown.reason],
        ),
        evidenceKinds: (result["evidence"] as { kind: string }[]).map((entry) => entry.kind),
      };
    };
    expect(shape(before.stdout)).toEqual(shape(after.stdout));
  });
});

describe("a refused invocation writes nothing", () => {
  it("leaves the workspace it could not find alone", () => {
    // Fail-closed: an argument that names a directory is not permission to
    // create one. `uvp build <absent>` is in the observations above and this is
    // the other half of it — the error contract, and an unchanged filesystem.
    expect(() => readdirSync(ABSENT_WORKSPACE)).toThrow(/ENOENT/u);
  });

  it("refuses a directory that already has something in it, and adds nothing", async () => {
    // `uvp init` writes files, so the only boundary that matters is the one it
    // refuses to cross. Scaffolding into an occupied directory would overwrite
    // whatever is there, and the caller would find out by reading a diff.
    const before = readdirSync(OCCUPIED).sort();
    const init = await invoke([
      "init",
      OCCUPIED,
      "--name",
      "svc",
      "--template",
      "hello-http",
      "--json",
    ]);
    expect(init.exit).toBe(EXIT_WRONG);
    expect(init.stdout.trim()).toBe("");
    const error = parseUvpError(soleJson(init.stderr, "uvp init"));
    expect(error.code).toBe("invalid_request");
    expect(error.details?.["entries"]).toEqual([...before].sort());
    expect(readdirSync(OCCUPIED).sort()).toEqual(before);
  });
});
