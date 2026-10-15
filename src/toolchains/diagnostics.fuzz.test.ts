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
 * Deliberately absent: the lines a link failure prints. They are diagnostics now,
 * and they are rendered as such by `linkCase` below — this list is for output that
 * holds no diagnostic at all, which is the other half of the same claim.
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

/** A section offset as a linker writes one: what is left of a location with no line. */
const sectionValue = (f: Fuzzer): string =>
  `(${f.pick([".text", ".text.startup", ".text.unlikely"])}+0x${f.string("0123456789abcdef", 1, 3)})`;

/** A symbol a link failure can be about, mangled or not. */
const symbolValue = (f: Fuzzer): string =>
  `${f.string("abcdefghijklmnopqrstuvwxyz_", 2, 8)}${f.chance(0.3) ? "()" : ""}`;

/**
 * A link failure, rendered from the formats the captures in `diagnostics.test.ts`
 * were written from — the format rather than the regex, for the reason every other
 * renderer here is: an expectation computed from what the tool is being asked to
 * say cannot agree with a parser that changed its mind about the format.
 *
 * Four shapes, one of which is the driver's rather than the linker's, and the
 * phase is `link` in all four however the caller's own phase reads. Two of them
 * print a first line naming the object and the enclosing function, which is not a
 * diagnostic and is rendered to make sure of it: the location on the line below
 * says the same thing and says where.
 *
 * These are not in `RENDERERS`, because the mixed log cannot expect them: the
 * driver's summary is reported only when no linker complaint was *anywhere* in the
 * log, and that is a property of the whole parse rather than of one line.
 * `diagnostics.test.ts` holds the pair that pins it.
 */
const linkCase = (f: Fuzzer): RenderedCase => {
  const kind = f.pick(["summary", "cannot find", "undefined reference", "multiple definition"]);

  if (kind === "summary") {
    const status = 1 + f.int(9);
    const said = `ld returned ${String(status)} exit status`;
    return {
      text: `collect2: error: ${said}`,
      expected: [{ severity: "error", message: said, phase: "link" }],
    };
  }

  if (kind === "cannot find") {
    const name = f.chance(0.5)
      ? `-l${f.string("abcdefghijklmnopqrstuvwxyz", 2, 8)}`
      : pathValue(f, false);
    if (f.chance(0.4)) {
      // gold's spelling: an `error:` marker and no errno text.
      const said = `cannot find ${name}`;
      return {
        text: `/usr/bin/ld.gold: error: ${said}`,
        expected: [{ severity: "error", message: said, phase: "link" }],
      };
    }
    // ld.bfd's: the description appended after it is the C library's, not the
    // linker's, so it is rendered with and without. A parser that required it would
    // be depending on a libc's wording for its own failure detection.
    const said = f.chance(0.7)
      ? `cannot find ${name}: ${f.pick(["No such file or directory", "Permission denied"])}`
      : `cannot find ${name}`;
    return {
      text: `/usr/bin/ld: ${said}`,
      expected: [{ severity: "error", message: said, phase: "link" }],
    };
  }

  const file = pathValue(f, f.chance(0.25));
  const line = 1 + f.int(9_999);
  const section = sectionValue(f);
  const symbol = symbolValue(f);

  if (kind === "undefined reference") {
    // Both captures: a source line plus a section when the build has debug
    // information, and the object's own file plus a section when it has none. The
    // section is in the message either way, because on the second shape it is the
    // only locator there is.
    const withLine = f.chance(0.5);
    const said = `undefined reference to \`${symbol}'`;
    return {
      text: [
        `/usr/bin/ld: CMakeFiles/hello.dir/main.cpp.o: in function \`main':`,
        `${file}:${withLine ? `${String(line)}:` : ""}${section}: ${said}`,
      ].join("\n"),
      expected: [
        {
          severity: "error",
          file,
          ...(withLine ? { line } : {}),
          message: `${said} ${section}`,
          phase: "link",
        },
      ],
    };
  }

  const origin = `${pathValue(f, false)}:${String(1 + f.int(9_999))}`;
  const said = `multiple definition of \`${symbol}'; ${origin}: first defined here`;
  // One location and not two, which is what makes this a shape of its own: the
  // debug form has a source line, the other has a section, and never both.
  const withLine = f.chance(0.5);
  return {
    text: [
      `/usr/bin/ld: CMakeFiles/main.cpp.o: in function \`${symbol}':`,
      `${file}:${withLine ? `${String(line)}:` : `${section}:`} ${said}`,
    ].join("\n"),
    expected: [
      {
        severity: "error",
        file,
        ...(withLine ? { line } : {}),
        message: withLine ? said : `${said} ${section}`,
        phase: "link",
      },
    ],
  };
};

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
    // The linker's formats answer with their own phase whatever the caller asked
    // for: `cmake --build` compiles and links in one call, so the phase a caller
    // passes names the step, and which of the two a failure was is named by the
    // line. Every other format answers with the phase it was given.
    if (diagnostic.phase !== phase && diagnostic.phase !== "link") {
      return `phase ${String(diagnostic.phase)}`;
    }
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
        // Every so often from a link failure rather than from a mixed log, because
        // the linker's formats are the ones a truncation is most likely to cut: they
        // are the last thing a build prints, and the byte caps on captured output
        // mean the last thing is what goes. A half-line of one must be read as
        // nothing rather than as a diagnostic invented from the remainder.
        const base = f.chance(0.25) ? linkCase(f).text : mixedLog(f, phase).text;
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

  it("reads a link failure out of the linker's own rendering of one", () => {
    // Each rendering is parsed on its own rather than folded into `mixedLog`, and
    // that is the whole-log rule in `parseDiagnostics` rather than a convenience:
    // the driver's summary is reported only when no linker complaint was found
    // *anywhere* in the log, so a log holding both has to expect the summary to be
    // absent — an expectation about the parse and not about the format. Alone, the
    // answer is the rendering: a linker complaint comes back as itself, and a
    // summary with nothing beside it comes back too.
    for (const seed of SEEDS) {
      for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
        const f = fuzzer(seedFor(seed, iteration));
        const phase = f.pick(PHASES);
        const { text, expected } = linkCase(f);
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

  it("reads the linker's own line out of a driver failure and holds its summary back", () => {
    // The capture this was written from, from a real `ld: cannot find -luvcpp`, and
    // the two lines around it that stay unread. `FAILED: hello` is Ninja's and names
    // the target rather than the failure — the command echo under it is the same
    // step again — and the `collect2:` line is the driver repeating what the linker
    // already said, so it is reported only when the linker said nothing this module
    // could read. Here the linker spoke, so one diagnostic comes out and not two;
    // the other half of that rule is in `diagnostics.test.ts`, where the linker's
    // spelling is one this module does not know.
    const text = [
      "FAILED: hello",
      "ld: cannot find -luvcpp",
      "collect2: error: ld returned 1 exit status",
    ].join("\n");
    expect(parseDiagnostics(text, "", "link")).toEqual([
      {
        severity: "error",
        message: "cannot find -luvcpp",
        phase: "link",
      },
    ]);
  });

  it("reports the driver's summary alone when the linker's spelling is one it does not know", () => {
    // The capture from `ld --bogus-option`, which is a real link failure whose
    // linker lines this module cannot read: neither carries a file, a line, or a
    // column. The phase would then be lost entirely — every other line of the log is
    // the compiler's or the generator's, and the caller asked for `compile` — and a
    // caller deciding what to re-run wants to know the link was the failing step, so
    // the driver's line is what carries it.
    const text = [
      "/usr/bin/ld: unrecognized option '--bogus-option'",
      "/usr/bin/ld: use the --help option for usage information",
      "collect2: error: ld returned 1 exit status",
    ].join("\n");
    expect(parseDiagnostics(text, "", "compile")).toEqual([
      { severity: "error", message: "ld returned 1 exit status", phase: "link" },
    ]);
  });
});
