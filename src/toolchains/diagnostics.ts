import type { BuildDiagnostic, BuildPhase } from "../application/ToolchainProvider.js";

/**
 * Reading a build's failures out of the text the tools printed.
 *
 * This is the owning boundary for build output. Four producers report failures
 * through it, and they disagree about almost everything: GCC/Clang and MSVC
 * disagree about how a *compiler* diagnostic is spelled, CMake says its own piece
 * in a third format that is not a compiler diagnostic at all, and the linker says
 * a fourth on lines that carry neither a line nor a column. All four are parsed in
 * this one module because a caller debugging a build must not have to re-read raw
 * tool output, and because an unparsed diagnostic is indistinguishable from no
 * diagnostic at all — which is what a configure failure used to be, and what a
 * link failure was until the formats below were written from captures of real
 * ones.
 *
 * Each format is matched, not approximated: a line is a CMake error because it is
 * spelled the way CMake spells one, never because it looks like a message. The
 * alternative — treating "any line with a colon that is not a compiler
 * diagnostic" as CMake's — would turn `-- Configuring done` into evidence about a
 * problem that does not exist.
 *
 * ## The locale these formats were written in
 *
 * A format is only worth matching if the text it matches is the text the tool
 * prints, and for the linker that is a property of the environment rather than of
 * the tool: `ld` translates its messages through gettext, so on a host whose
 * locale is not English the same link failure reads `找不到 -luvcpp` where the
 * pattern below expects `cannot find`. GNU Make translates its lines entirely, the
 * full-width colon it separates a target with included — and Make is not a
 * bystander here, since the `Nothing to be done for` that `noWorkWasDone` matches
 * is Make's own. Measured on this host, which is `zh_CN.UTF-8` to begin with: `ld`
 * and `gmake` translate, this CMake and this GCC do not, and `ld`'s catalogue is
 * partial in its turn — its `multiple definition of` stays English at the same
 * locale. So this is a pin on the two tools that would otherwise go unread, and
 * not a general claim about which tools speak which language.
 * `buildOutputEnvironment` is the environment that holds them to the English
 * spellings below, and the providers give it to every build subprocess — a parser
 * written against captured English output and run against localized output
 * reports nothing, which reads exactly like a build that failed for no reason.
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
  /^(?<file>[^(]+)\((?<line>\d+)(?:,(?<column>\d+))?\)\s*:\s*(?<severity>fatal error|error|warning|note)\s+[A-Z]+\d+:\s*(?<message>.*)$/u;

const SEVERITIES = new Set(["error", "warning", "note"]);

/** A positive integer from a capture group, or undefined when it is absent or junk. */
const optionalNumber = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

/**
 * A linker's phrase inside a compiler's own shape.
 *
 * ld.gold reports an undefined reference the way GCC reports a compile error, on
 * one line and with a source location — captured here, from a workspace that
 * called a symbol nothing defines:
 *
 *     /tmp/uvp-link-probe/src/main.cpp:2: error: undefined reference to 'uvp_missing_symbol(int)'
 *
 * That line is genuinely GCC's shape, so the compiler format above reads it
 * correctly as to file, line and message, and the only thing it gets wrong is the
 * phase: this is a link failure, and calling it a compile failure is exactly what
 * the phase field exists to prevent. What identifies it is the wording, which is
 * the linker's and not a compiler's — a compiler never reports that a symbol is
 * undefined referenceable, because at compile time the reference is all it sees.
 */
const LINKER_PHRASES = /^(?:undefined reference to|multiple definition of) /u;

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
  const message = groups["message"]?.trim() ?? "";

  return {
    severity: severity as BuildDiagnostic["severity"],
    ...(file === undefined || file === "" ? {} : { file }),
    ...(lineNumber === undefined ? {} : { line: lineNumber }),
    ...(columnNumber === undefined ? {} : { column: columnNumber }),
    message,
    phase: LINKER_PHRASES.test(message) ? "link" : phase,
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

/**
 * The linker's own lines, and the driver's line about it.
 *
 * A link failure was the last producer with no format here, and the reason was
 * that writing one needed a capture rather than a plausible-looking log — the
 * drive-letter fix beside it is a worked example of what a pattern invented from
 * imagination costs. These four are all captures, taken on 2026-10-16 from
 * `cmake --build` on a workspace that links a library that is not installed, calls
 * a symbol nothing defines, or defines one twice, on this host's GNU ld 2.42
 * through the `g++` driver, with GNU Make and with Ninja.
 *
 * The pair of lines a linker prints under `<tool>: <object>: in function \`f':` is
 * read as **one** diagnostic, from the second line, which is the one that names a
 * place in the caller's own source. The first line is left unmatched rather than
 * folded in: it says which object and which function, and the source location on
 * the line below it says both better.
 */

/**
 * GNU ld saying it cannot find a library or a file the link line named.
 *
 *     /usr/bin/ld: cannot find -luvcpp: No such file or directory
 *     /usr/bin/ld.gold: error: cannot find -luvcpp
 *
 * The name is a library (`-luvcpp`, which is how this project's own dependency is
 * spelled on a link line that cannot resolve it), or a path when one was named.
 * gold announces the same failure with an `error:` marker and no errno text, and
 * the two are one format here because they are one failure with one message.
 *
 * The errno text is optional rather than required because it is the C library's
 * `strerror`, appended by ld when the search failed on the filesystem. It is the
 * only part of the line that a different libc may word differently, and a parser
 * that required it would drop the failure on exactly the hosts where it matters.
 */
const LD_CANNOT_FIND = /^(?:[^\s:]*\/)?ld(?:\.bfd)?: (?<said>cannot find [^\s:]+(?:: .*)?)$/u;
const GOLD_CANNOT_FIND = /^(?:[^\s:]*\/)?ld\.gold: error: (?<said>cannot find [^\s:]+)$/u;

/**
 * The linker naming a symbol it could not resolve.
 *
 * With debug information, the location is the source file and line:
 *
 *     /tmp/uvp-link-probe/src/main.cpp:2:(.text+0xe): undefined reference to `uvp_missing_symbol(int)'
 *
 * Without it — a `Release` build, or any build that passes no `-g` — there is no
 * line to name, and the location falls back to the file the object's symbol table
 * records, which is the **basename** the compiler wrote there:
 *
 *     main.cpp:(.text.startup+0xa): undefined reference to `uvp_missing_symbol(int)'
 *
 * Hence the optional line number and the required section. The section is the
 * offset of the reference inside the object, and it is kept in the message
 * because the contract's diagnostic has no field for it and because on the
 * no-debug shape it is the only locator there is.
 */
const LD_UNDEFINED_REFERENCE =
  /^(?<file>(?:[A-Za-z]:[\\/])?[^:\n]+):(?:(?<line>\d+):)?(?<section>\([^)]+\)): (?<said>undefined reference to `[^'\n]+')$/u;

/**
 * The linker naming a symbol that more than one object defines.
 *
 *     /tmp/uvp-link-probe/src/other.cpp:1: multiple definition of `uvp_duplicate()'; CMakeFiles/hello.dir/src/main.cpp.o:/tmp/uvp-link-probe/src/main.cpp:1: first defined here
 *     other.cpp:(.text+0x0): multiple definition of `uvp_duplicate()'; CMakeFiles/hello.dir/src/main.cpp.o:main.cpp:(.text+0x0): first defined here
 *
 * One location and then the message — a source line when there is debug
 * information, a section offset when there is not, and never both, which is what
 * the alternation below is for. It is not the same shape as the undefined
 * reference above, which prints both, and writing one pattern for the two was a
 * defect this file shipped for as long as it took to run it against these
 * captures.
 *
 * The trail after the semicolon names the *first* definition, which is why it is
 * kept in the message rather than cut off: "first defined here" is the half a
 * caller acts on.
 */
const LD_MULTIPLE_DEFINITION =
  /^(?<file>(?:[A-Za-z]:[\\/])?[^:\n]+):(?:(?<line>\d+):|(?<section>\([^)]+\)):) (?<said>multiple definition of `[^'\n]+'; .+)$/u;

/**
 * The C++ driver's summary of a link that failed.
 *
 *     collect2: error: ld returned 1 exit status
 *
 * `collect2` is the helper `g++` runs to invoke the linker, so this line is
 * present for every GNU link failure — including the ones whose linker message
 * this module does not know. Captured here: a link line with a bad option, where
 * the linker's own words are `ld: unrecognized option '--bogus-option'` and
 * nothing above this line is a format this module matches. Reported only when no
 * linker complaint was found, because beside one it says nothing the caller does
 * not already have.
 */
const COLLECT2_LINK_FAILED = /^collect2: error: (?<said>ld returned \d+ exit status)$/u;

/** A line the linker printed, and whether it is the driver's summary of one. */
interface LinkLine {
  readonly diagnostic: BuildDiagnostic;
  /** True for `collect2:`, which the scan reports only when nothing else was. */
  readonly summary: boolean;
}

/**
 * The section an object-relative location named, folded into the message.
 *
 * The contract's diagnostic has `file`, `line` and `column` and no field for a
 * link-time offset, so dropping the section would lose the only place the linker
 * said the reference is — which on a build with no debug information is the only
 * place there is. Folding tool context into the message is what the CMake
 * diagnostic above already does with the command it was running. The section
 * arrives with its own parentheses, which is how ld writes a location, so it is
 * appended as it was printed rather than wrapped again.
 */
const withSection = (said: string, section: string | undefined): string =>
  section === undefined ? said : `${said} ${section}`;

/**
 * Read one of the linker's lines, or return undefined when it is not one.
 *
 * Every one of these is a single line that stands alone: the linker's pair is read
 * from its second line, and the driver's summary is one line. Nothing here needs
 * to look at a neighbouring line, which is what keeps a truncated log — and the
 * byte caps on captured output mean logs are truncated — from turning a link
 * failure into no diagnostic.
 */
const parseLinkLine = (line: string): LinkLine | undefined => {
  const error = (diagnostic: BuildDiagnostic, summary = false): LinkLine => ({
    diagnostic,
    summary,
  });

  const cannotFind = LD_CANNOT_FIND.exec(line) ?? GOLD_CANNOT_FIND.exec(line);
  if (cannotFind !== null) {
    return error({
      severity: "error",
      message: cannotFind.groups?.["said"] ?? "",
      phase: "link",
    });
  }

  for (const format of [LD_UNDEFINED_REFERENCE, LD_MULTIPLE_DEFINITION]) {
    const located = format.exec(line);
    const groups = located?.groups;
    if (groups === undefined) continue;
    const file = groups["file"]?.trim();
    const lineNumber = optionalNumber(groups["line"]);
    return error({
      severity: "error",
      ...(file === undefined || file === "" ? {} : { file }),
      ...(lineNumber === undefined ? {} : { line: lineNumber }),
      message: withSection(groups["said"] ?? "", groups["section"]),
      phase: "link",
    });
  }

  const collect2 = COLLECT2_LINK_FAILED.exec(line);
  if (collect2 !== null) {
    return error(
      {
        severity: "error",
        message: collect2.groups?.["said"] ?? "",
        phase: "link",
      },
      true,
    );
  }

  return undefined;
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
 * The linker's formats are tried first because they are the most specific: each
 * one begins by naming the tool that printed it, so a line that matches is the
 * linker's beyond argument. They are followed by the compiler's, which are the
 * cheaper match, and then CMake's. No line can match two of them — a compiler's
 * diagnostic does not begin `CMake ` or `collect2: `, and CMake's headers carry no
 * `error:`/`warning:` marker — so the order decides nothing except which parser
 * does the work.
 */
const diagnosticAt = (
  lines: readonly string[],
  from: number,
  phase: BuildPhase,
): { readonly diagnostic: BuildDiagnostic; readonly spanned: number } | undefined => {
  const link = parseLinkLine((lines[from] ?? "").trimEnd());
  if (link !== undefined) return { diagnostic: link.diagnostic, spanned: 0 };
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
 *
 * The one diagnostic that is held back is the driver's summary of a link failure:
 * it is reported only when no linker complaint was, because `ld returned 1 exit
 * status` beside `cannot find -luvcpp` adds a second failure to a list that has
 * one. Held back rather than dropped, because with the linker's own message in a
 * spelling this module does not know it is the only line that says the failure
 * was the link's — and the streams are read out of order relative to each other,
 * so "was one found" is a question about the whole scan and not about what came
 * before this line.
 */
export const parseDiagnostics = (
  stdout: string,
  stderr: string,
  phase: BuildPhase,
): readonly BuildDiagnostic[] => {
  const diagnostics: BuildDiagnostic[] = [];
  const seen = new Set<string>();
  const add = (diagnostic: BuildDiagnostic): void => {
    const key = identity(diagnostic);
    if (seen.has(key)) return;
    seen.add(key);
    diagnostics.push(diagnostic);
  };

  let summary: BuildDiagnostic | undefined;
  let linkerSpoke = false;
  const lines = `${stderr}\n${stdout}`.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trimEnd();
    const link = parseLinkLine(line);
    if (link !== undefined) {
      if (link.summary) summary ??= link.diagnostic;
      else {
        linkerSpoke = true;
        add(link.diagnostic);
      }
      continue;
    }
    const found = diagnosticAt(lines, index, phase);
    if (found === undefined) continue;
    // Skip what the diagnostic already read, so a CMake message block is not
    // scanned again for diagnostics of its own.
    index += found.spanned;
    // A failure the linker stated in a compiler's shape — gold's undefined
    // reference — is a linker complaint like any other, so it is one of the
    // reasons the summary below is not repeated.
    if (found.diagnostic.phase === "link") linkerSpoke = true;
    add(found.diagnostic);
  }

  if (summary !== undefined && !linkerSpoke) add(summary);
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

/**
 * The environment a build subprocess runs in, so that its output is readable.
 *
 * A build is not only asked for; it is *read*, by the formats above and by
 * `noWorkWasDone`. Those formats are English because the tools print English on
 * the host they were captured on, and two of the tools that print into these
 * streams do not print English everywhere: `ld` and GNU Make translate their
 * messages through gettext. Captured on this host on 2026-10-16, with
 * `LANG=zh_CN.UTF-8`, the link failure above comes back as
 *
 *     /usr/bin/ld: 找不到 -luvcpp: 没有那个文件或目录
 *     gmake[2]: *** [CMakeFiles/hello.dir/build.make:97：hello] 错误 1
 *
 * — which no format here matches. `noWorkWasDone` loses the same way, and to the
 * same tool: the `Nothing to be done for 'all'.` it reads comes back as
 * `make: 对“all”无需做任何事。`, which the pattern does not recognise either. A
 * parser run against text in a language it was not written for reports nothing,
 * and nothing is what a build that failed for no stated reason looks like: the
 * failure would be real, the exit code non-zero, and the diagnostic list empty of
 * anything a caller can act on.
 *
 * ## The two variables, and why `LC_ALL` is emptied rather than set
 *
 * `LC_ALL` is emptied rather than set to `C` because a non-empty `LC_ALL`
 * overrides `LC_MESSAGES` and a non-empty `LC_ALL=C` would override the rest of
 * the locale too. What is deliberately *not* changed is the character category:
 * `LC_CTYPE` stays whatever the host has, so a source file in a non-UTF-8 encoding
 * still compiles as it did before, and a build is not silently given a different
 * idea of what its own bytes mean. Measured here: with `LC_ALL=` and
 * `LC_MESSAGES=C`, `locale` reports `LC_CTYPE="zh_CN.UTF-8"` from `LANG` while `ld`
 * and `gmake` print English.
 *
 * The empty value is glibc's reading of "not set"; a C library that instead
 * rejected it would leave the program in the `C` locale it starts in, which is
 * English too. So the two libraries disagree about the character category and not
 * about the language, which is the one that decides whether a diagnostic is read.
 *
 * Here rather than in a provider because it is the environment these formats
 * require, and a provider that forgot it would report a localized build as a
 * failure with no diagnostics — the exact defect this module exists to prevent,
 * one layer out.
 */
export const buildOutputEnvironment = (): Readonly<Record<string, string>> => ({
  LC_ALL: "",
  LC_MESSAGES: "C",
});
