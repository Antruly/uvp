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
 * written on — CMake 3.28, GCC 13 — rather than text invented to match the
 * parser. The distinction matters: a fixture written from the parser's shape
 * proves the parser agrees with itself, and it is exactly how the configure
 * failure stayed invisible.
 *
 * The four producers, one per block: GCC, MSVC (there is no MSVC on this host, so
 * that block is the documented format rather than a capture — it is marked as
 * such), CMake's located error, and CMake's location-less error.
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
