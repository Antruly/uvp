import type { BuildDiagnostic, BuildPhase } from "../application/ToolchainProvider.js";

/**
 * Reading a build's failures out of the text the tools printed.
 *
 * This is the owning boundary for build output. Three producers report failures
 * through it, and they disagree about almost everything: GCC/Clang and MSVC
 * disagree about how a *compiler* diagnostic is spelled, and CMake says its own
 * piece in a third format that is not a compiler diagnostic at all. All three are
 * parsed in this one module because a caller debugging a build must not have to
 * re-read raw tool output, and because an unparsed diagnostic is indistinguishable
 * from no diagnostic at all — which is what a configure failure used to be.
 *
 * Each format is matched, not approximated: a line is a CMake error because it is
 * spelled the way CMake spells one, never because it looks like a message. The
 * alternative — treating "any line with a colon that is not a compiler
 * diagnostic" as CMake's — would turn `-- Configuring done` into evidence about a
 * problem that does not exist.
 */

/**
 * The file part of a GCC or Clang diagnostic, drive letter and all.
 *
 * The drive prefix is there because the file part is otherwise "everything up to
 * the first colon", and a Windows path has one of its own. That is not
 * hypothetical here: `LocalToolchainProvider` probes for `gcc` on Windows as well
 * as `cl`, so a MinGW or clang build there reports
 * `C:/Users/dev/src/main.cpp:12:5: error: …` and a parser that stopped at the
 * drive colon read the whole line as not a diagnostic — the failure this module
 * exists to prevent, one platform over. It is the format being matched rather
 * than approximated, since that line is exactly what the tool prints.
 *
 * A separator is required after the colon rather than a drive letter being enough
 * on its own: `C:main.cpp` is relative to a drive's current directory and does
 * not appear in build output, while `a:b.cpp:3:5: error: …` — the shape a bare
 * letter-plus-colon rule would newly read as a diagnostic — is text a build log
 * can hold by accident.
 */
const GCC_DIAGNOSTIC =
  /^(?<file>(?:[A-Za-z]:[\\/])?[^:\n]+):(?<line>\d+):(?:(?<column>\d+):)?\s*(?<severity>error|warning|note|fatal error):\s*(?<message>.*)$/u;
const MSVC_DIAGNOSTIC =
  /^(?<file>[^(]+)\((?<line>\d+)(?:,(?<column>\d+))?\)\s*:\s*(?<severity>error|warning|note)\s+[A-Z]+\d+:\s*(?<message>.*)$/u;

const SEVERITIES = new Set(["error", "warning", "note"]);

/** A positive integer from a capture group, or undefined when it is absent or junk. */
const optionalNumber = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

/**
 * Parse one compiler line, or return undefined when it is not a diagnostic.
 *
 * Most lines in a build log are not diagnostics, so "not one of ours" is the
 * ordinary path and is not worth an exception or a partial object.
 */
const parseDiagnosticLine = (line: string, phase: BuildPhase): BuildDiagnostic | undefined => {
  const match = GCC_DIAGNOSTIC.exec(line) ?? MSVC_DIAGNOSTIC.exec(line);
  const groups = match?.groups;
  if (groups === undefined) return undefined;

  // GCC spells it "fatal error"; the contract has three severities, and a fatal
  // error is an error.
  const severity = groups["severity"] === "fatal error" ? "error" : groups["severity"];
  if (severity === undefined || !SEVERITIES.has(severity)) return undefined;

  const file = groups["file"]?.trim();
  const lineNumber = optionalNumber(groups["line"]);
  const columnNumber = optionalNumber(groups["column"]);

  return {
    severity: severity as BuildDiagnostic["severity"],
    ...(file === undefined || file === "" ? {} : { file }),
    ...(lineNumber === undefined ? {} : { line: lineNumber }),
    ...(columnNumber === undefined ? {} : { column: columnNumber }),
    message: groups["message"]?.trim() ?? "",
    phase,
  };
};

/**
 * CMake's own errors and warnings.
 *
 * A configure failure is not a compiler diagnostic and does not look like one.
 * CMake announces it with `CMake Error at <file>:<line> (<command>):` on one line
 * and puts the message on the *indented lines below it*; a location-less
 * `CMake Error: <message>` spells the one diagnostic per line. A parser that
 * reads a line at a time therefore sees a header it cannot use and, on the next
 * line, a message with nothing to attach it to — which is how a configure failure
 * came to be reported as `succeeded: false` with an empty diagnostic list, under a
 * limitation promising "the diagnostics below".
 *
 * The header names the command CMake was running when it gave up, which is
 * carried along rather than dropped: `pkg_check_modules` and `add_subdirectory`
 * are different failures to act on, and "the library was not found" is not the
 * same advice as "the compiler was not found".
 */
const CMAKE_LOCATED = /^CMake (?<severity>Error|Warning) at (?<location>.+):$/u;
const CMAKE_BARE = /^CMake (?<severity>Error|Warning):\s*(?<message>.*)$/u;
const CMAKE_LOCATION = /^(?<file>.+):(?<line>\d+)(?:\s*\((?<command>[^)]*)\))?$/u;

/**
 * How much of a CMake message block is kept.
 *
 * The character cap is the real bound; the line cap only guards against a
 * pathological number of very short lines. A CMake message is normally one to
 * three lines, and the longest real one seen here is the list of packages
 * `pkg_check_modules` could not find, which is one line per package.
 */
const CMAKE_MESSAGE_LINES = 24;
const CMAKE_MESSAGE_CHARS = 2_000;

/** Where CMake said the problem is, when it said where. */
const cmakeLocation = (
  location: string,
): { readonly file?: string; readonly line?: number; readonly command?: string } => {
  const where = CMAKE_LOCATION.exec(location.trim()) ?? undefined;
  if (where === undefined) return {};
  const file = where.groups?.["file"]?.trim();
  const command = where.groups?.["command"]?.trim();
  const line = optionalNumber(where.groups?.["line"]);
  // A location CMake spelled in a shape not recognised here is dropped rather
  // than guessed at: the message is still the diagnostic.
  return {
    ...(file === undefined || file === "" ? {} : { file }),
    ...(command === undefined || command === "" ? {} : { command }),
    ...(line === undefined ? {} : { line }),
  };
};

/**
 * The message under a CMake header, joined, with the lines it consumed.
 *
 * The block ends at the first non-blank line that is **flush left**, which is
 * what `Call Stack (most recent call first):` is. Blank lines in the middle do
 * not end it, and that is not a detail: the message of the most likely configure
 * failure — a required package that was not found — is a sentence, a blank line,
 * then an indented list of the packages:
 *
 * ```
 * CMake Error at /usr/share/cmake-3.28/Modules/FindPkgConfig.cmake:619 (message):
 *   The following required packages were not found:
 *
 *    - uvcpp-absent
 *
 * Call Stack (most recent call first):
 * ```
 *
 * Stopping at the first blank line would keep the sentence and drop the name of
 * the package, leaving a diagnostic that says something is missing without saying
 * what. The `Call Stack` entries below the header are indented too, so the
 * terminator has to be the flush-left header itself rather than the indentation:
 * those entries name files and lines, and a reader that took them for diagnostics
 * would blame one of CMake's own modules for the caller's mistake.
 */
const cmakeMessage = (
  lines: readonly string[],
  header: number,
): { readonly message: string; readonly consumed: number } => {
  const parts: string[] = [];
  let consumed = 0;
  for (
    let index = header + 1;
    index < lines.length && parts.length < CMAKE_MESSAGE_LINES;
    index += 1
  ) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      // Part of the block: CMake separates a message from its list this way.
      consumed += 1;
      continue;
    }
    if (!/^\s+\S/u.test(line)) break;
    parts.push(line.trim());
    consumed += 1;
  }
  return { message: parts.join(" ").slice(0, CMAKE_MESSAGE_CHARS), consumed };
};

/** Which of CMake's two header forms a line is, and what it says on that line. */
interface CmakeHeader {
  readonly severity: "error" | "warning";
  /** `at <file>:<line> (<command>)` for the located form; empty for the other. */
  readonly location: string;
  /** The message, for the location-less form that spells it on the header line. */
  readonly said: string;
}

/** Read a header line, or undefined when it is not one of CMake's. */
const cmakeHeader = (line: string): CmakeHeader | undefined => {
  const severityOf = (spelling: string | undefined): "error" | "warning" =>
    spelling === "Warning" ? "warning" : "error";

  const located = CMAKE_LOCATED.exec(line);
  if (located !== null) {
    return {
      severity: severityOf(located.groups?.["severity"]),
      location: located.groups?.["location"] ?? "",
      said: "",
    };
  }
  const bare = CMAKE_BARE.exec(line);
  if (bare === null) return undefined;
  return {
    severity: severityOf(bare.groups?.["severity"]),
    location: "",
    said: bare.groups?.["message"]?.trim() ?? "",
  };
};

/**
 * One CMake error or warning starting at `lines[at]`, with the lines it consumed.
 *
 * `consumed` is what lets the caller skip the message block. A scanner that did
 * not skip it would read the message again as a line that is not a diagnostic —
 * harmless — and would read the *location* line of a call stack as a diagnostic,
 * which is not.
 */
export const parseCmakeDiagnostic = (
  lines: readonly string[],
  at: number,
  phase: BuildPhase,
): { readonly diagnostic: BuildDiagnostic; readonly consumed: number } | undefined => {
  const header = cmakeHeader((lines[at] ?? "").trimEnd());
  if (header === undefined) return undefined;

  // The located form puts its message on the indented lines below the header and
  // names a place; the location-less form says everything on one line.
  const located = header.location !== "";
  const block = located ? cmakeMessage(lines, at) : { message: "", consumed: 0 };
  const place = located ? cmakeLocation(header.location) : {};
  const said = header.said === "" ? block.message : header.said;
  // A header with no message anywhere says only that something failed, which is
  // already known from the exit code.
  if (said === "") return undefined;

  // The command leads the message rather than being dropped. It goes into the
  // message because the contract's diagnostic has a `message` and no field for a
  // tool's own context, and inventing one would change a published schema for a
  // string.
  const message = place.command === undefined ? said : `${place.command}: ${said}`;

  return {
    diagnostic: {
      severity: header.severity,
      ...(place.file === undefined ? {} : { file: place.file }),
      ...(place.line === undefined ? {} : { line: place.line }),
      message,
      phase,
    },
    consumed: block.consumed,
  };
};

/** The key a diagnostic is deduplicated on: the same failure said twice is one. */
const identity = (diagnostic: BuildDiagnostic): string =>
  [
    diagnostic.severity,
    diagnostic.file ?? "",
    diagnostic.line ?? "",
    diagnostic.column ?? "",
    diagnostic.message,
  ].join("|");

/**
 * The diagnostic starting on `lines[from]`, with how many further lines it spans.
 *
 * The compiler formats are tried first only because they are the cheaper match;
 * they cannot both apply to one line, since CMake's headers carry no
 * `error:`/`warning:` marker and a compiler's diagnostics do not begin `CMake `.
 */
const diagnosticAt = (
  lines: readonly string[],
  from: number,
  phase: BuildPhase,
): { readonly diagnostic: BuildDiagnostic; readonly spanned: number } | undefined => {
  const compiler = parseDiagnosticLine((lines[from] ?? "").trimEnd(), phase);
  if (compiler !== undefined) return { diagnostic: compiler, spanned: 0 };
  const cmake = parseCmakeDiagnostic(lines, from, phase);
  if (cmake === undefined) return undefined;
  return { diagnostic: cmake.diagnostic, spanned: cmake.consumed };
};

/**
 * Every diagnostic in a tool's output, in the order the tools reported them.
 *
 * CMake retries a failed configure and prints the same error again, and a
 * compiler invoked through a wrapper may put its diagnostics on stdout rather
 * than stderr, so both streams are read and a repeat is dropped. A missing
 * diagnostic is worse than a duplicate, so the dedupe is by content and never by
 * position.
 */
export const parseDiagnostics = (
  stdout: string,
  stderr: string,
  phase: BuildPhase,
): readonly BuildDiagnostic[] => {
  const diagnostics: BuildDiagnostic[] = [];
  const seen = new Set<string>();
  const lines = `${stderr}\n${stdout}`.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const found = diagnosticAt(lines, index, phase);
    if (found === undefined) continue;
    // Skip what the diagnostic already read, so a CMake message block is not
    // scanned again for diagnostics of its own.
    index += found.spanned;
    const key = identity(found.diagnostic);
    if (seen.has(key)) continue;
    seen.add(key);
    diagnostics.push(found.diagnostic);
  }
  return diagnostics;
};

/**
 * Whether a build tool said it had nothing to do.
 *
 * Only the phrasings that mean exactly that are matched. `Built target` is *not*
 * one of them, however much it looks like one: GNU Make prints it for every
 * target on every successful build, including a fresh compile that took a second
 * and a half. Matching it would label each of those as coming from a cache,
 * which is an invented fact about work that plainly happened.
 *
 * Here rather than in a provider because it is a reading of build output like
 * any other, and two providers that disagreed about whether Ninja printed "no
 * work to do" would report the same build differently.
 */
export const noWorkWasDone = (output: string): boolean =>
  /ninja: no work to do|Nothing to be done for|is up to date|up-to-date:/iu.test(output);
