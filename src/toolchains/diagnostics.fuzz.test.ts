import { describe, expect, it } from "vitest";

import {
  type Fuzzer,
  fuzzer,
  fuzzIterations,
  fuzzSeeds,
  replay,
  reportFuzzRun,
  seedFor,
} from "../../tests/support/fuzz.js";
import type { BuildDiagnostic, BuildPhase } from "../application/ToolchainProvider.js";
import { parseDiagnostics } from "./diagnostics.js";

/**
 * What `parseDiagnostics` does with inputs nobody wrote down.
 *
 * `diagnostics.test.ts` answers a different question with the same function: it
 * holds text captured from real tools on this host, which is the only way to know
 * the parser agrees with GCC and CMake rather than with this repository's idea of
 * them. That file's blind spot is the line neither tool printed for the person
 * writing it — a message block that runs past a cap, a path with a drive letter, a
 * header truncated mid-word by an interrupt.
 *
 * This file generates those. The two lanes are complementary and neither is
 * sufficient: a generator cannot say its renderings are what the tools emit, and a
 * capture cannot say what happens one character to the left. So the properties
 * here are stated as invariants over generated text — never throws, always
 * well-formed, never invents a diagnostic, loses nothing it was given — and the
 * MSVC half inherits the other file's limitation, since there is no MSVC on this
 * host and the format is the documented one rather than an observed one.
 *
 * **What this does not establish.** A bounded search over generated inputs is not
 * a statement about the input space, and nothing here is evidence about a real
 * compiler: the renderings are written from the formats, from the same
 * documentation the parser was written from. The seed list, the iteration count,
 * and the derived total are printed by every run for exactly this reason — "no
 * case failed" and "no case was tried" must not read alike.
 */

const SEEDS = fuzzSeeds();
const ITERATIONS = fuzzIterations();
const PHASES: readonly BuildPhase[] = ["configure", "compile", "link", "post"];

/**
 * Fragments a real build log is made of, none of which is a diagnostic.
 *
 * These are the ordinary lines — progress, summaries, the paths CMake prints —
 * and several of them are here because they *look* like they could be read as
 * something. `-- Found ZLIB: /usr/lib/libz.so` has a colon and a path; `make[1]:
 * Entering directory '/tmp'` has the shape of a file and a line; `main.cpp: In
 * function 'int main()':` is GCC's own context line, which is a diagnostic's
 * neighbour rather than one. A parser that reported any of them would be
 * reporting a problem that does not exist, which is the failure this module's
 * doc comment calls out by name.
 *
 * Deliberately absent: the driver lines that carry a failure without carrying a
 * location, `collect2: error: ld returned 1 exit status` and its `ld: cannot find
 * -lfoo` relative. They are not in this list because whether they *should* be
 * reported is unresolved — see the last block.
 */
const ORDINARY_OUTPUT = [
  "-- The CXX compiler identification is GNU 13.2.0",
  "-- Configuring done (0.4s)",
  "-- Generating done (0.1s)",
  "-- Build files have been written to: /tmp/uvp-build",
  '-- Found ZLIB: /usr/lib/x86_64-linux-gnu/libz.so (found version "1.2.13")',
  "-- Could NOT find PkgConfig (missing: PKG_CONFIG_EXECUTABLE)",
  "[ 20%] Building CXX object CMakeFiles/hello.dir/src/main.cpp.o",
  "[100%] Linking CXX executable hello",
  "Built target hello",
  "Scanning dependencies of target hello",
  "make[1]: Entering directory '/tmp/uvp-build'",
  "make[2]: Leaving directory '/tmp/uvp-build'",
  "ninja: no work to do.",
  "main.cpp: In function 'int main()':",
  "  this is a continuation of nothing in particular",
  "",
  "   ",
  "	",
];

const WORDS = [
  "invalid",
  "use",
  "of",
  "undeclared",
  "identifier",
  "cannot",
  "find",
  "-lfoo",
  "in",
  "expansion",
  "macro",
  "'x'",
  "definition",
  "template",
  "argument",
  "substituted",
  "here",
  "required",
  "from",
];

/**
 * A path of the shapes a tool prints, Windows ones included.
 *
 * The Windows form is not decoration: `LocalToolchainProvider` probes for `gcc`
 * on Windows as well as `cl`, so a MinGW or clang build there produces GCC-format
 * diagnostics whose file part begins with a drive letter. Whether the parser
 * reads those is a question this generator asks rather than assumes.
 */
const pathValue = (f: Fuzzer, windows: boolean): string => {
  const stem = f.string("abcdefghijklmnopqrstuvwxyz0123456789_-", 1, 10);
  const extension = f.pick([".cpp", ".h", ".cc", ".cmake", ".txt"]);
  const depth = f.int(3);
  const directories = Array.from({ length: depth }, () =>
    f.string("abcdefghijklmnopqrstuvwxyz", 1, 7),
  );
  const relative = [...directories, stem + extension].join("/");
  if (!windows) return relative;
  return `C:${f.chance(0.5) ? "/" : "\\"}${relative}`;
};

/** A message with no newline and no leading or trailing space, as the tools print. */
const messageValue = (f: Fuzzer): string =>
  Array.from({ length: 1 + f.int(7) }, () => f.pick(WORDS)).join(" ");

interface RenderedCase {
  readonly text: string;
  readonly expected: readonly BuildDiagnostic[];
}

/**
 * A GCC or Clang diagnostic, rendered from the format rather than from the regex.
 *
 * `fatal error` is one of GCC's severities and the contract has three, so a case
 * that renders it expects the severity `error` — the mapping is asserted where it
 * is made rather than folded in here.
 */
const gccCase = (f: Fuzzer, phase: BuildPhase): RenderedCase => {
  const file = pathValue(f, f.chance(0.25));
  const line = 1 + f.int(9_999);
  const column = f.chance(0.6) ? 1 + f.int(200) : undefined;
  const severity = f.pick(["error", "warning", "note"] as const);
  const message = messageValue(f);
  const spelled = `${file}:${String(line)}:${column === undefined ? "" : `${String(column)}:`} ${severity}: ${message}`;
  return {
    text: spelled,
    expected: [
      {
        severity,
        file,
        line,
        ...(column === undefined ? {} : { column }),
        message,
        phase,
      },
    ],
  };
};

/** An MSVC diagnostic, in the documented format — there is no MSVC on this host. */
const msvcCase = (f: Fuzzer, phase: BuildPhase): RenderedCase => {
  const file = pathValue(f, true).replaceAll("/", "\\");
  const line = 1 + f.int(9_999);
  const column = f.chance(0.5) ? 1 + f.int(200) : undefined;
  const severity = f.pick(["error", "warning", "note"] as const);
  const code = `${f.pick(["C", "LNK", "MSB"])}${String(1 + f.int(9_999))}`;
  const message = messageValue(f);
  const spelled =
    `${file}(${String(line)}${column === undefined ? "" : `,${String(column)}`})` +
    `: ${severity} ${code}: ${message}`;
  return {
    text: spelled,
    expected: [
      {
        severity,
        file,
        line,
        ...(column === undefined ? {} : { column }),
        message,
        phase,
      },
    ],
  };
};

/**
 * CMake's located form: a header naming a place, then the message indented below.
 *
 * The command in the parentheses is prepended to the message by the parser — it is
 * carried rather than dropped, because `pkg_check_modules` failing and
 * `add_subdirectory` failing want different answers — so the expectation here says
 * so. That is the contract this generator pins, and the reason it is written out
 * rather than derived.
 */
const cmakeLocatedCase = (f: Fuzzer, phase: BuildPhase): RenderedCase => {
  const file = pathValue(f, f.chance(0.2));
  const line = 1 + f.int(9_999);
  const command = f.chance(0.7)
    ? f.pick(["message", "pkg_check_modules", "find_package"])
    : undefined;
  const severity = f.pick(["Error", "Warning"] as const);
  const parts = Array.from({ length: 1 + f.int(4) }, () => messageValue(f));
  const blankBetween = f.chance(0.4);
  const body = parts.flatMap((part, index) =>
    index > 0 && blankBetween ? ["", `  ${part}`] : [`  ${part}`],
  );
  return {
    text: [
      `CMake ${severity} at ${file}:${String(line)}${command === undefined ? "" : ` (${command})`}:`,
      ...body,
    ].join("\n"),
    expected: [
      {
        severity: severity === "Warning" ? "warning" : "error",
        file,
        line,
        message: command === undefined ? parts.join(" ") : `${command}: ${parts.join(" ")}`,
        phase,
      },
    ],
  };
};

/** CMake's location-less form: everything on the header line. */
const cmakeBareCase = (f: Fuzzer, phase: BuildPhase): RenderedCase => {
  const severity = f.pick(["Error", "Warning"] as const);
  const message = messageValue(f);
  return {
    text: `CMake ${severity}: ${message}`,
    expected: [
      {
        severity: severity === "Warning" ? "warning" : "error",
        message,
        phase,
      },
    ],
  };
};

const RENDERERS = [gccCase, msvcCase, cmakeLocatedCase, cmakeBareCase];

/** Some ordinary build output, as lines. */
const noise = (f: Fuzzer): string[] =>
  Array.from({ length: f.int(6) }, () => f.pick(ORDINARY_OUTPUT));

/**
 * A log made of noise and rendered diagnostics, with the diagnostics' positions
 * remembered so their order can be asserted rather than assumed.
 */
/**
 * The line a rendered block is closed with, so the next line starts a new one.
 *
 * A CMake message block ends at the first non-blank line that is flush left, and
 * continues through every indented one — which is how a message, a blank line, and
 * the list of missing packages stay one diagnostic. Real output is full of
 * indented context (`  this is a continuation…` is in the vocabulary above for
 * exactly that reason), so a generated log that followed a block with an indented
 * ordinary line would be one larger message and not two things. That is the parser
 * being right, and the expectation here is built from the rendering rather than
 * from the parser's rules, so the generator closes the block instead of asking a
 * reader to re-derive the rule to check the result.
 */
const BLOCK_TERMINATOR = "-- Build files have been written to: /tmp/uvp-build";

const mixedLog = (
  f: Fuzzer,
  phase: BuildPhase,
): { readonly text: string; readonly expected: readonly BuildDiagnostic[] } => {
  const lines: string[] = [];
  const expected: BuildDiagnostic[] = [];
  const seen = new Set<string>();
  for (let block = 0; block < 1 + f.int(4); block += 1) {
    lines.push(...noise(f));
    const rendered = f.pick(RENDERERS)(f, phase);
    lines.push(...rendered.text.split("\n"), BLOCK_TERMINATOR);
    for (const diagnostic of rendered.expected) {
      // The parser drops the second of two identical failures by design — CMake
      // retries a failed configure and prints the same error again — so a
      // generated log that happens to repeat one must expect it once. Two
      // random messages colliding is rare rather than impossible, and a
      // property that fails once in a hundred thousand runs is worse than no
      // property: it teaches the person who sees it to re-run.
      const key = identity(diagnostic);
      if (seen.has(key)) continue;
      seen.add(key);
      expected.push(diagnostic);
    }
  }
  lines.push(...noise(f));
  return { text: lines.join("\n"), expected };
};

/** The key the parser deduplicates on, repeated here so the expectation can apply it. */
const identity = (diagnostic: BuildDiagnostic): string =>
  [
    diagnostic.severity,
    diagnostic.file ?? "",
    diagnostic.line ?? "",
    diagnostic.column ?? "",
    diagnostic.message,
  ].join("|");

/**
 * A character from the set that means something to this parser.
 *
 * The mutations below are not random bytes: a random byte is almost always an
 * ordinary character in an ordinary word, so a corpus of them explores the fast
 * path of the regex rather than its edges. These are the characters that decide
 * whether a line is a diagnostic — the separator, the opener, the newline, the
 * carriage return a tty adds.
 */
const SYNTAX_ALPHABET = ":\n\r\t ()[]CMake 0129-_.errorwarningnote";

const MUTATORS: readonly ((f: Fuzzer, text: string) => string)[] = [
  (f, text) => text.slice(0, f.int(Math.max(0, text.length - 1))),
  (f, text) => {
    const at = f.int(Math.max(0, text.length - 1));
    return text.slice(0, at) + text.slice(at + 1);
  },
  (f, text) => {
    const at = f.int(text.length);
    return `${text.slice(0, at)}${f.string(SYNTAX_ALPHABET, 1, 3)}${text.slice(at)}`;
  },
  (f, text) => {
    const at = f.int(text.length);
    return `${text.slice(0, at)}\u0000${text.slice(at)}`;
  },
  (f, text) => {
    const lines = text.split("\n");
    const at = f.int(lines.length - 1);
    return [...lines.slice(0, at + 1), lines[at] ?? "", ...lines.slice(at + 1)].join("\n");
  },
  (f, text) => {
    const at = text.indexOf("\n", f.int(text.length));
    return at === -1
      ? `${text}\n${f.pick(ORDINARY_OUTPUT)}`
      : text.slice(0, at) + text.slice(at + 1);
  },
  (f, text) => text.replaceAll(":", f.chance(0.5) ? ";" : "\t"),
  (f, text) => text.repeat(1 + f.int(2)),
  (f, text) => `${f.pick(ORDINARY_OUTPUT)}\n${text}\n${f.pick(ORDINARY_OUTPUT)}`,
];

/**
 * The invariants every parse must satisfy, whatever it was given.
 *
 * These are the claims that hold for any input rather than for the inputs someone
 * listed: the parser answers, the answer is well formed, the answer is a function
 * of the text (not of what was parsed before it), and the answer is bounded by the
 * text it came from. Each returns a problem description rather than throwing, so
 * the caller can attach the input that produced it to the message.
 */
const malformedDiagnostic = (
  diagnostics: readonly BuildDiagnostic[],
  phase: BuildPhase,
  text: string,
): string | undefined => {
  const lineCount = text.split("\n").length;
  if (diagnostics.length > lineCount) {
    return `${String(diagnostics.length)} diagnostic(s) from ${String(lineCount)} line(s)`;
  }
  // The output is made of the input: every character of a message is a character
  // that was in a line, plus the separator a block's lines are joined with and
  // the command a located CMake header contributes twice. A parser that grew a
  // message out of nothing would fail this, and so would one that looped.
  const produced = diagnostics.reduce((total, diagnostic) => total + diagnostic.message.length, 0);
  if (produced > 2 * text.length + 64) {
    return `${String(produced)} character(s) of message from ${String(text.length)} character(s) of input`;
  }
  const seen = new Set<string>();
  for (const diagnostic of diagnostics) {
    if (!["error", "warning", "note"].includes(diagnostic.severity)) {
      return `severity ${JSON.stringify(diagnostic.severity)}`;
    }
    if (typeof diagnostic.message !== "string") return "message is not a string";
    if (diagnostic.file !== undefined && diagnostic.file === "") return "file is empty";
    if (
      diagnostic.line !== undefined &&
      !(Number.isInteger(diagnostic.line) && diagnostic.line > 0)
    ) {
      return `line ${JSON.stringify(diagnostic.line)}`;
    }
    if (
      diagnostic.column !== undefined &&
      !(Number.isInteger(diagnostic.column) && diagnostic.column > 0)
    ) {
      return `column ${JSON.stringify(diagnostic.column)}`;
    }
    if (diagnostic.phase !== phase) return `phase ${String(diagnostic.phase)}`;
    const key = identity(diagnostic);
    if (seen.has(key)) return `duplicate ${JSON.stringify(key)}`;
    seen.add(key);
  }
  return undefined;
};

describe("the build-output parser, against generated input", () => {
  reportFuzzRun("build diagnostics, invariants", SEEDS, ITERATIONS);

  it("never throws, is well formed, and is a function of its arguments", () => {
    for (const seed of SEEDS) {
      for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
        const f = fuzzer(seedFor(seed, iteration));
        const phase = f.pick(PHASES);
        const base = mixedLog(f, phase).text;
        const text = MUTATORS[f.int(MUTATORS.length - 1)]?.(f, base) ?? base;
        const input = f.chance(0.5) ? { stdout: text, stderr: "" } : { stdout: "", stderr: text };

        const diagnostics = parseDiagnostics(input.stdout, input.stderr, phase);
        const problem = malformedDiagnostic(diagnostics, phase, text);
        if (problem !== undefined)
          throw new Error(replay({ seed, iteration, input: text, problem }));

        // Twice in a row, because a `lastIndex` left behind on a shared regex is
        // exactly the kind of state that makes the second call differ from the
        // first — and a parser that answered differently the second time would
        // still pass every example test in the repository.
        const again = parseDiagnostics(input.stdout, input.stderr, phase);
        if (JSON.stringify(again) !== JSON.stringify(diagnostics)) {
          throw new Error(
            replay({
              seed,
              iteration,
              input: text,
              problem: `a second call answered differently: ${JSON.stringify(again)}`,
            }),
          );
        }
      }
    }
  });

  it("reads a diagnostic out of the text it was built from", () => {
    for (const seed of SEEDS) {
      for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
        const f = fuzzer(seedFor(seed, iteration));
        const phase = f.pick(PHASES);
        const { text, expected } = mixedLog(f, phase);
        const diagnostics = parseDiagnostics(text, "", phase);
        if (JSON.stringify(diagnostics) !== JSON.stringify(expected)) {
          throw new Error(
            replay({
              seed,
              iteration,
              input: text,
              problem: `expected ${JSON.stringify(expected)}\n  received ${JSON.stringify(diagnostics)}`,
            }),
          );
        }
      }
    }
  });

  it("reads nothing out of output that holds no diagnostic", () => {
    for (const seed of SEEDS) {
      for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
        const f = fuzzer(seedFor(seed, iteration));
        const text = noise(f).join("\n");
        const diagnostics = parseDiagnostics(text, text, "compile");
        if (diagnostics.length !== 0) {
          throw new Error(
            replay({
              seed,
              iteration,
              input: text,
              problem: `invented ${JSON.stringify(diagnostics)}`,
            }),
          );
        }
      }
    }
  });

  it("depends on the joined text and not on which stream a line came from", () => {
    for (const seed of SEEDS) {
      for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
        const f = fuzzer(seedFor(seed, iteration));
        const phase = f.pick(PHASES);
        const first = mixedLog(f, phase).text;
        const second = mixedLog(f, phase).text;
        // `parseDiagnostics(stdout, stderr)` reads `stderr` then `stdout`, so the
        // same two texts passed as one stream must give the same answer.
        const split = parseDiagnostics(first, second, phase);
        const joined = parseDiagnostics("", `${second}\n${first}`, phase);
        if (JSON.stringify(split) !== JSON.stringify(joined)) {
          throw new Error(
            replay({
              seed,
              iteration,
              input: `${first}\n=== second stream ===\n${second}`,
              problem: `split ${JSON.stringify(split)} vs joined ${JSON.stringify(joined)}`,
            }),
          );
        }
      }
    }
  });
});

describe("the build-output parser's format edges", () => {
  it("maps GCC's `fatal error` onto the contract's `error`", () => {
    const [diagnostic] = parseDiagnostics(
      "main.cpp:2:3: fatal error: closing brace missing",
      "",
      "compile",
    );
    expect(diagnostic).toEqual({
      severity: "error",
      file: "main.cpp",
      line: 2,
      column: 3,
      message: "closing brace missing",
      phase: "compile",
    });
  });

  it("keeps a compiler diagnostic whose message is empty, since the location is the message", () => {
    // The CMake form makes the opposite choice — a header with nothing under it
    // returns no diagnostic at all, because "CMake failed" is already known from
    // the exit code. A compiler line that names a file and a line has said
    // something even when the words after `error:` are gone, so it is kept.
    const [diagnostic] = parseDiagnostics("main.cpp:2:3: error:", "", "compile");
    expect(diagnostic).toMatchObject({ severity: "error", file: "main.cpp", line: 2, message: "" });
  });

  it("reads a message block past the line cap and cuts it at the documented size", () => {
    const header = "CMake Error at CMakeLists.txt:4 (message):";
    const many = Array.from({ length: 40 }, (_, index) => `  line ${String(index)}`);
    const [capped] = parseDiagnostics([header, ...many].join("\n"), "", "configure");
    expect(capped?.message.split(" ").filter((part) => part === "line")).toHaveLength(24);

    const long = `  ${"x".repeat(5_000)}`;
    const [truncated] = parseDiagnostics([header, long].join("\n"), "", "configure");
    // The cap bounds the block CMake wrote, and the command the parser prepends
    // is its own context rather than part of that block, so the assembled message
    // is longer than the cap by the length of the command. Asserted exactly rather
    // than as "about 2000", because which of the two the cap bounds is the whole
    // content of the claim.
    expect(truncated?.message).toBe(`message: ${"x".repeat(2_000)}`);
  });

  it("takes an indented compiler diagnostic as part of the block CMake quoted", () => {
    // CMake's message may quote the compiler verbatim. The block is the message,
    // so a diagnostic-shaped line inside it is reported as what CMake said rather
    // than as a second failure of its own — the compiler's own line appears
    // separately when the compiler is what ran.
    const text = [
      "CMake Error at CMakeLists.txt:9 (message):",
      "  the compiler rejected this:",
      "  main.cpp:2:3: error: invalid use of 'this'",
    ].join("\n");
    expect(parseDiagnostics(text, "", "configure")).toEqual([
      {
        severity: "error",
        file: "CMakeLists.txt",
        line: 9,
        message: "message: the compiler rejected this: main.cpp:2:3: error: invalid use of 'this'",
        phase: "configure",
      },
    ]);
  });

  it("drops a CMake location spelled in a shape it does not recognise rather than guessing one", () => {
    const [diagnostic] = parseDiagnostics(
      ["CMake Error at CMakeLists.txt:", "  no line number anywhere in that header"].join("\n"),
      "",
      "configure",
    );
    expect(diagnostic).toEqual({
      severity: "error",
      message: "no line number anywhere in that header",
      phase: "configure",
    });
  });

  it("drops a repeat of the same failure and keeps a repeat that differs by position", () => {
    // CMake retries a failed configure and prints the error again. Reporting it
    // twice would read as two problems; the identity is the content, so the same
    // message at a different line is a different diagnostic and stays.
    const once = "main.cpp:2:3: error: invalid use of 'this'";
    expect(parseDiagnostics(`${once}\n${once}`, "", "compile")).toHaveLength(1);
    expect(
      parseDiagnostics(`${once}\nmain.cpp:9:3: error: invalid use of 'this'`, "", "compile"),
    ).toHaveLength(2);
  });

  it("reports a driver failure that carries no location as nothing at all", () => {
    // Recorded, not endorsed. `collect2: error: ld returned 1 exit status` and
    // `ld: cannot find -lfoo` are what a link failure prints, and both are dropped:
    // every format this module matches requires a line and a column (or a CMake
    // header), and a driver's message has neither. `src/toolchains/diagnostics.test.ts`
    // records the same shape from the other side — its negative cases are lines that
    // must not be read as diagnostics — and `tests/toolchain/buildFailure.test.ts`
    // covers a compile failure and a configure failure but no link failure, so what
    // a real link failure's output looks like has not been observed here.
    // Changing this means adding a fourth format, and adding one on a guess is how
    // a parser starts inventing diagnostics; the roadmap carries the row.
    const text = [
      "FAILED: hello",
      "ld: cannot find -luvcpp",
      "collect2: error: ld returned 1 exit status",
    ].join("\n");
    expect(parseDiagnostics(text, "", "link")).toEqual([]);
  });
});
