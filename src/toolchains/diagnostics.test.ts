import { describe, expect, it } from "vitest";

import { parseDiagnostics } from "./diagnostics.js";

/**
 * Reading a build's failures out of the text the tools printed.
 *
 * `parseDiagnostics` is the owning boundary for build output: a caller debugging
 * a workspace reads the diagnostics, not the log, and a diagnostic this file
 * fails to recognise is not reported as "unrecognised" anywhere — it is simply
 * absent, indistinguishable from a build that failed for no stated reason. That
 * is what happened to every configure failure: CMake's errors are not compiler
 * diagnostics, they are not spelled like compiler diagnostics, and the parser
 * only knew the two compiler formats, so `uvp build` reported `succeeded: false`
 * with an empty list and a note telling the caller to read the diagnostics.
 *
 * Every block below is text captured from the real tools on the host this was
 * written on — CMake 3.28, GCC 13, GNU ld 2.42 — rather than text invented to
 * match the parser. The distinction matters: a fixture written from the parser's
 * shape proves the parser agrees with itself, and it is exactly how the configure
 * failure stayed invisible. The link failures in the last block were captured in
 * the same way, and two defects in the formats written for them were found by
 * running the captures through the parser rather than by reading it.
 *
 * The producers, one per block: GCC, MSVC (there is no MSVC on this host, so that
 * block is the documented format rather than a capture — it is marked as such),
 * CMake's located error, CMake's location-less error, and the linker.
 */

/** GCC 13, from a real `cmake --build` on a file with a syntax error. */
const GCC_COMPILE_FAILURE = [
  "main.cpp: In function ‘int main()’:",
  "main.cpp:2:3: error: invalid use of ‘this’ in non-member function",
  "    2 |   this is not c++;",
  "      |   ^~~~",
].join("\n");

/** CMake 3.28, from a configure whose CMakeLists calls a command that does not exist. */
const CMAKE_LOCATED_ERROR = [
  "CMake Error at CMakeLists.txt:4 (not_a_real_cmake_command):",
  '  Unknown CMake command "not_a_real_cmake_command".',
].join("\n");

/**
 * CMake 3.28, from `pkg_check_modules(… REQUIRED …)` for a package that is not
 * installed — the most likely way a real workspace fails to configure.
 *
 * Worth its size in the fixture: the message is a sentence, a blank line, then
 * the list of packages, and a call stack follows. A reader of this block that
 * stops at the first blank line keeps the sentence and drops the name of the
 * missing package, which is the only part a caller can act on.
 */
const CMAKE_MODULE_ERROR = [
  "CMake Error at /usr/share/cmake-3.28/Modules/FindPkgConfig.cmake:619 (message):",
  "  The following required packages were not found:",
  "",
  "   - uvcpp-absent",
  "",
  "Call Stack (most recent call first):",
  "  /usr/share/cmake-3.28/Modules/FindPkgConfig.cmake:841 (_pkg_check_modules_internal)",
  "  CMakeLists.txt:4 (pkg_check_modules)",
  "",
].join("\n");

/** CMake 3.28, from `cmake -S` on a directory that does not exist. */
const CMAKE_LOCATIONLESS_ERROR = [
  'CMake Error: The source directory "/tmp/nope" does not exist.',
  "Specify --help for usage, or press the help button on the CMake GUI.",
].join("\n");

/** CMake 3.28, from a `project(svc VERSION)` with nothing after `VERSION`. */
const CMAKE_WARNING = [
  "CMake Warning at CMakeLists.txt:2 (project):",
  "  VERSION keyword not followed by a value or was followed by a value that",
  "  expanded to nothing.",
  "",
  "",
].join("\n");

/** The configure that produced the warning. A warning is not a failure. */
const CMAKE_WARNING_STDOUT = ["-- Configuring done (0.3s)", "-- Generating done (0.0s)"].join("\n");

/**
 * GNU ld 2.42 through the `g++` driver, from a `cmake --build` of a workspace whose
 * link line names a library that is not installed.
 *
 * The failure this project's own users meet most: `-luvcpp` is what a workspace
 * links, and a build with no libuvcpp to link against gets exactly this. The
 * driver's summary and Make's own line follow, and neither is a format here.
 */
const LD_CANNOT_FIND = [
  "[100%] Linking CXX executable hello",
  "/usr/bin/ld: cannot find -luvcpp: No such file or directory",
  "collect2: error: ld returned 1 exit status",
  "gmake[2]: *** [CMakeFiles/hello.dir/build.make:97: hello] Error 1",
].join("\n");

/**
 * The same failure with Ninja as the generator, whose `FAILED: hello` line and
 * command echo are not diagnostics either.
 *
 * Kept beside the Make capture because the generator decides almost everything
 * about the surrounding lines and nothing about the linker's, which is the claim
 * being pinned: the same one diagnostic comes out of both.
 */
const LD_CANNOT_FIND_NINJA = [
  "FAILED: hello ",
  ": && /usr/bin/c++ -g  CMakeFiles/hello.dir/src/main.cpp.o -o hello  -luvcpp && :",
  "/usr/bin/ld: cannot find -luvcpp: No such file or directory",
  "collect2: error: ld returned 1 exit status",
  "ninja: build stopped: subcommand failed.",
].join("\n");

/**
 * ld.gold, from the same link line.
 *
 * A different linker with the same failure and a different spelling: gold says
 * `error:` and prints no errno text. One format covers both because it is one
 * failure with one message.
 */
const GOLD_CANNOT_FIND = [
  "/usr/bin/ld.gold: error: cannot find -luvcpp",
  "collect2: error: ld returned 1 exit status",
].join("\n");

/**
 * GNU ld 2.42, from a `Debug` build of a workspace that calls a symbol nothing
 * defines — the two lines the linker prints, the second of which carries the
 * caller's own source location.
 */
const LD_UNDEFINED_REFERENCE = [
  "/usr/bin/ld: CMakeFiles/hello.dir/src/main.cpp.o: in function `main':",
  "/tmp/uvp-link-probe/src/main.cpp:2:(.text+0xe): undefined reference to `uvp_missing_symbol(int)'",
  "collect2: error: ld returned 1 exit status",
].join("\n");

/**
 * The same failure from a `Release` build, which passes no `-g`.
 *
 * With no debug information there is no source line to name, and the location
 * falls back to the name the object's own symbol table records — the basename,
 * as `readelf -s` shows it — with the section offset as the only other locator.
 */
const LD_UNDEFINED_REFERENCE_RELEASE = [
  "/usr/bin/ld: CMakeFiles/hello.dir/src/main.cpp.o: in function `main':",
  "main.cpp:(.text.startup+0xa): undefined reference to `uvp_missing_symbol(int)'",
  "collect2: error: ld returned 1 exit status",
].join("\n");

/**
 * ld.gold reporting the same undefined reference in **GCC's own shape**, with a
 * source location and an `error:` marker.
 *
 * The compiler format reads this line correctly and always did; what it could not
 * know is that the line is a link failure. Only the phase was wrong, and the phase
 * is what tells a caller whether to go and read their code or to go and look at
 * what they linked against.
 */
const GOLD_UNDEFINED_REFERENCE = [
  "/tmp/uvp-link-probe/src/main.cpp:2: error: undefined reference to 'uvp_missing_symbol(int)'",
  "collect2: error: ld returned 1 exit status",
].join("\n");

/** GNU ld 2.42, from a workspace whose two translation units define one symbol. */
const LD_MULTIPLE_DEFINITION = [
  "/usr/bin/ld: CMakeFiles/hello.dir/src/other.cpp.o: in function `uvp_duplicate()':",
  "/tmp/uvp-link-probe/src/other.cpp:1: multiple definition of `uvp_duplicate()'; CMakeFiles/hello.dir/src/main.cpp.o:/tmp/uvp-link-probe/src/main.cpp:1: first defined here",
  "collect2: error: ld returned 1 exit status",
].join("\n");

/** The same, without debug information: one location, and it is a section. */
const LD_MULTIPLE_DEFINITION_RELEASE = [
  "/usr/bin/ld: CMakeFiles/hello.dir/src/other.cpp.o: in function `uvp_duplicate()':",
  "other.cpp:(.text+0x0): multiple definition of `uvp_duplicate()'; CMakeFiles/hello.dir/src/main.cpp.o:main.cpp:(.text+0x0): first defined here",
  "collect2: error: ld returned 1 exit status",
].join("\n");

/**
 * A real link failure whose linker line is **not** a format here: ld 2.42 given an
 * option it does not know.
 *
 * This is the case the driver's summary exists for. Nothing above `collect2:`
 * matches, so without it the failure would be a non-zero exit code and an empty
 * diagnostic list — which reads exactly like a build that failed for no reason.
 */
const LD_UNRECOGNISED_OPTION = [
  "/usr/bin/ld: unrecognized option '--bogus-option'",
  "/usr/bin/ld: use the --help option for usage information",
  "collect2: error: ld returned 1 exit status",
].join("\n");

describe("compiler diagnostics", () => {
  it("reads a GCC error with its file, line, and column", () => {
    // The source line and the caret line under it are the compiler illustrating
    // its own message. They are not diagnostics and must not become entries: a
    // caller that acted on `    2 |   this is not c++;` would be told to look at a
    // line of its own file for a reason that is not there.
    expect(parseDiagnostics("", GCC_COMPILE_FAILURE, "compile")).toEqual([
      {
        severity: "error",
        file: "main.cpp",
        line: 2,
        column: 3,
        message: "invalid use of ‘this’ in non-member function",
        phase: "compile",
      },
    ]);
  });

  it("calls a GCC fatal error an error", () => {
    // GCC's fourth severity. The contract has three, and a fatal error is the
    // one that stopped the build — reading it as anything else would understate
    // it.
    const said = parseDiagnostics(
      "",
      "main.cpp:1:10: fatal error: nope.h: No such file or directory",
      "compile",
    );
    expect(said).toHaveLength(1);
    expect(said[0]?.severity).toBe("error");
    expect(said[0]?.message).toContain("No such file or directory");
  });

  it("reads the MSVC format, which spells the same facts differently", () => {
    // The documented MSVC shape, not a capture: there is no MSVC on this host, and
    // a lane that skipped would leave the format untested. Writ large in the file
    // header, because a reader is entitled to know which fixtures were observed.
    const said = parseDiagnostics(
      "",
      "C:\\ws\\main.cpp(2,3): error C2065: 'this': undeclared identifier",
      "compile",
    );
    expect(said).toEqual([
      {
        severity: "error",
        file: "C:\\ws\\main.cpp",
        line: 2,
        column: 3,
        message: "'this': undeclared identifier",
        phase: "compile",
      },
    ]);
  });

  it("keeps a diagnostic that arrived on stdout, since a wrapper may put it there", () => {
    // A missing diagnostic is worse than a duplicate, so both streams are read.
    const said = parseDiagnostics("main.cpp:7:1: warning: unused variable ‘x’", "", "compile");
    expect(said).toHaveLength(1);
    expect(said[0]?.severity).toBe("warning");
  });

  it("reports the same line twice only once", () => {
    // CMake retries a failed configure and prints the same error again; a
    // duplicate is noise in a list a caller reads to decide what to fix.
    const said = parseDiagnostics("", `${GCC_COMPILE_FAILURE}\n${GCC_COMPILE_FAILURE}`, "compile");
    expect(said).toHaveLength(1);
  });
});

describe("CMake's own diagnostics", () => {
  it("reads a located configure error, which is not a compiler diagnostic", () => {
    // The regression in one assertion. Before this, the header matched nothing and
    // the message line below it matched nothing either, so a configure failure
    // reported no diagnostic at all.
    const said = parseDiagnostics("", CMAKE_LOCATED_ERROR, "configure");
    expect(said).toEqual([
      {
        severity: "error",
        file: "CMakeLists.txt",
        line: 4,
        // The command CMake was running leads the message: "the library was not
        // found" and "the compiler was not found" are acted on differently, and
        // CMake states which one it was in a part of the header nothing else reads.
        message: 'not_a_real_cmake_command: Unknown CMake command "not_a_real_cmake_command".',
        phase: "configure",
      },
    ]);
  });

  it("keeps a message that continues past a blank line, and stops before the call stack", () => {
    const said = parseDiagnostics("", CMAKE_MODULE_ERROR, "configure");
    // One diagnostic, not four: the call stack's frames are indented like the
    // message and name files and lines, so a parser that did not stop at `Call
    // Stack` would report a CMake module as the thing the caller has to fix.
    expect(said).toHaveLength(1);
    const [only] = said;
    expect(only?.phase).toBe("configure");
    expect(only?.file).toBe("/usr/share/cmake-3.28/Modules/FindPkgConfig.cmake");
    expect(only?.line).toBe(619);
    // The missing package by name: the sentence alone says something is missing
    // without saying what.
    expect(only?.message).toContain("The following required packages were not found:");
    expect(only?.message).toContain("- uvcpp-absent");
    expect(only?.message).not.toContain("Call Stack");
  });

  it("reads the location-less form, which is one diagnostic on one line", () => {
    // `CMake Error: <message>` has no location and is not followed by an indented
    // block. The help line beneath it is CMake's advice, not a second diagnostic,
    // and the entry carries no file — absent, rather than an empty string that
    // would read as "in the current directory".
    const said = parseDiagnostics("", CMAKE_LOCATIONLESS_ERROR, "configure");
    expect(said).toEqual([
      {
        severity: "error",
        message: 'The source directory "/tmp/nope" does not exist.',
        phase: "configure",
      },
    ]);
    expect("file" in (said[0] ?? {})).toBe(false);
  });

  it("reads a warning on a configure that succeeded", () => {
    // A warning is not a failure and must survive one: this configure exits 0, and
    // dropping the warning would leave a caller with a green build and a
    // CMakeLists nobody can explain.
    const said = parseDiagnostics(CMAKE_WARNING_STDOUT, CMAKE_WARNING, "configure");
    expect(said).toEqual([
      {
        severity: "warning",
        file: "CMakeLists.txt",
        line: 2,
        message:
          "project: VERSION keyword not followed by a value or was followed by a value that expanded to nothing.",
        phase: "configure",
      },
    ]);
  });
});

describe("output that holds no diagnostic", () => {
  it("yields an empty list, which does not mean nothing was wrong", () => {
    // The other half of the contract: this is what a *successful* configure says,
    // and it must produce no entries. Whether an empty list means "nothing was
    // wrong" or "nothing was recognised" is not decidable here — that is the
    // caller's business, and `uvp build` decides it from the exit code.
    const said = parseDiagnostics(CMAKE_WARNING_STDOUT, "", "configure");
    expect(said).toEqual([]);
  });

  it("does not mistake a progress line for a diagnostic", () => {
    // `-- Detecting CXX compile features - done` is flush-left, indented, has
    // colons, and reports no problem. The formats are matched, not the shapes.
    const progress = [
      "-- The CXX compiler identification is GNU 13.3.0",
      "-- Configuring done",
    ].join("\n");
    expect(parseDiagnostics(progress, "", "configure")).toEqual([]);
  });
});

describe("the linker's diagnostics", () => {
  /**
   * Every case here is called with phase `compile`, because that is the phase the
   * providers ask for: `cmake --build` compiles *and* links, and one call covers
   * both. A diagnostic that says "link" is therefore the format overriding the
   * caller — the field exists so that a caller can tell the two apart, and nothing
   * else in the output says which of them a failure was.
   */
  it("reports the library it could not find, with the linker's own words", () => {
    // The regression in one assertion: `uvp build` on a workspace with no libuvcpp
    // to link against reported `succeeded: false` and an empty diagnostic list. A
    // link failure that names the missing library is the whole difference between
    // "install libuvcpp" and "your code does not compile".
    expect(parseDiagnostics("", LD_CANNOT_FIND, "compile")).toEqual([
      {
        severity: "error",
        message: "cannot find -luvcpp: No such file or directory",
        phase: "link",
      },
    ]);
  });

  it("reads the same failure out of a Ninja build, whose other lines are not diagnostics", () => {
    // `FAILED: hello` names the output file Ninja was building and says nothing
    // about why, and `ninja: build stopped: subcommand failed.` is its summary of
    // the same nothing. Neither is a diagnostic and neither is reported: a list
    // that named the generator's edge for every failure in it would bury the one
    // line that says what to fix. The generator decides nothing about the linker's
    // line, which is why this case and the Make one above agree.
    expect(parseDiagnostics("", LD_CANNOT_FIND_NINJA, "compile")).toEqual([
      {
        severity: "error",
        message: "cannot find -luvcpp: No such file or directory",
        phase: "link",
      },
    ]);
  });

  it("reads gold's spelling of the same failure, which carries an `error:` of its own", () => {
    expect(parseDiagnostics("", GOLD_CANNOT_FIND, "compile")).toEqual([
      { severity: "error", message: "cannot find -luvcpp", phase: "link" },
    ]);
  });

  it("reports an undefined reference at the source line that made it", () => {
    // From the *second* line of the pair the linker prints. The first names the
    // object and the function, which the source location says better, so it is
    // left unmatched rather than folded in. The section is kept in the message
    // because the contract has no field for it — see the next case for when it is
    // the only locator there is.
    expect(parseDiagnostics("", LD_UNDEFINED_REFERENCE, "compile")).toEqual([
      {
        severity: "error",
        file: "/tmp/uvp-link-probe/src/main.cpp",
        line: 2,
        message: "undefined reference to `uvp_missing_symbol(int)' (.text+0xe)",
        phase: "link",
      },
    ]);
  });

  it("names the object's own file when the build has no debug information", () => {
    // A `Release` build passes no `-g`, so there is no line to name and ld falls
    // back to the name in the object's symbol table — a basename, as `readelf -s`
    // shows it. The section offset is then the only locator, which is why it is in
    // the message and not dropped. A parser that required a line number would
    // report nothing at all for every release build.
    expect(parseDiagnostics("", LD_UNDEFINED_REFERENCE_RELEASE, "compile")).toEqual([
      {
        severity: "error",
        file: "main.cpp",
        message: "undefined reference to `uvp_missing_symbol(int)' (.text.startup+0xa)",
        phase: "link",
      },
    ]);
  });

  it("calls gold's GCC-shaped undefined reference a link failure", () => {
    // The compiler format reads this line and always did — file, line and message
    // are all correct. What it could not know is which tool printed it: gold
    // announces a link failure in GCC's own shape, and a caller who read the phase
    // would go and look at their code for a symbol they never defined. The phrase
    // is the linker's, which is what identifies it.
    expect(parseDiagnostics("", GOLD_UNDEFINED_REFERENCE, "compile")).toEqual([
      {
        severity: "error",
        file: "/tmp/uvp-link-probe/src/main.cpp",
        line: 2,
        message: "undefined reference to 'uvp_missing_symbol(int)'",
        phase: "link",
      },
    ]);
  });

  it("reports a symbol that two objects define, naming the first definition too", () => {
    // The duplicate is the location and the trail after the semicolon names the
    // first definition — the half a caller acts on, since the fix is at whichever
    // of the two is the mistake.
    expect(parseDiagnostics("", LD_MULTIPLE_DEFINITION, "compile")).toEqual([
      {
        severity: "error",
        file: "/tmp/uvp-link-probe/src/other.cpp",
        line: 1,
        message:
          "multiple definition of `uvp_duplicate()'; CMakeFiles/hello.dir/src/main.cpp.o:" +
          "/tmp/uvp-link-probe/src/main.cpp:1: first defined here",
        phase: "link",
      },
    ]);
  });

  it("reads the no-debug form of a multiple definition, which has one location and not two", () => {
    // The defect this case caught: the undefined-reference format prints *both* a
    // line and a section, and this one prints one or the other, so a pattern
    // written for the first silently matched none of the second. The captures were
    // run through the parser before this was believed.
    expect(parseDiagnostics("", LD_MULTIPLE_DEFINITION_RELEASE, "compile")).toEqual([
      {
        severity: "error",
        file: "other.cpp",
        message:
          "multiple definition of `uvp_duplicate()'; CMakeFiles/hello.dir/src/main.cpp.o:" +
          "main.cpp:(.text+0x0): first defined here (.text+0x0)",
        phase: "link",
      },
    ]);
  });

  it("keeps the driver's summary when the linker's own message is one it does not know", () => {
    // The case that makes the summary worth reporting at all. ld 2.42 given an
    // option it does not know prints a line in no format here, so without
    // `collect2:` the caller would get a non-zero exit code and nothing else —
    // and "the link step failed" is a different next step from "your code does not
    // compile", which is what an empty list next to a compile-phase step implies.
    expect(parseDiagnostics("", LD_UNRECOGNISED_OPTION, "compile")).toEqual([
      { severity: "error", message: "ld returned 1 exit status", phase: "link" },
    ]);
  });

  it("does not repeat the summary beside the linker's own complaint", () => {
    // One failure, one diagnostic. `ld returned 1 exit status` beside `cannot find
    // -luvcpp` describes the same event twice and adds nothing the caller can act
    // on; the two captures above are the same text with and without it.
    const withSummary = parseDiagnostics("", LD_CANNOT_FIND, "compile");
    const withoutSummary = parseDiagnostics(
      "",
      "/usr/bin/ld: cannot find -luvcpp: No such file or directory",
      "compile",
    );
    expect(withSummary).toEqual(withoutSummary);
  });
});
