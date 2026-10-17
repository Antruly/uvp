import { describe, expect, it } from "vitest";

import {
  WORKSPACE_NAME_MESSAGE,
  WORKSPACE_NAME_PATTERN,
  workspaceNameProblem,
} from "./workspaceName.js";

/**
 * A workspace name is a CMake target and a file name at once.
 *
 * These cases are the two authorities read as one rule: CMP0037's target-name
 * pattern and the reserved names it names, and the Windows file-name rules that
 * the same string meets when it is the default binary (`build/<name>`). A name
 * accepted here but refused by CMake is the defect this module exists for, so
 * every refusal below is one that would otherwise reach the first build.
 */

describe("the workspace-name shape", () => {
  it("accepts the names CMake can use as a target and a file can hold", () => {
    for (const name of [
      "svc",
      "hello-http",
      "my.app+1-x",
      "_svc",
      "A1",
      "service_2",
      // Starts with the letters of a device name but is not one.
      "console",
      "alloy",
      "cleanup",
      // Windows reserves COM1–COM9 and LPT1–LPT9, not the zero or two-digit names.
      "com0",
      "lpt10",
      // `test` and `package` are reserved only when CTest/CPack is enabled, which
      // a generated project does not do.
      "test",
      "package",
      // The three internal target names are reserved in exactly this case; the
      // mixed-case spellings configure, so accepting them is correct.
      "Install",
      "All_Build",
      "Zero_Check",
    ]) {
      expect(WORKSPACE_NAME_PATTERN.test(name), name).toBe(true);
      expect(workspaceNameProblem(name), name).toBeUndefined();
    }
  });

  it("refuses anything CMake would refuse as a target", () => {
    for (const name of [
      // CMP0037: outside the allowed character set.
      "my app",
      "服务",
      "a/b",
      "a\\b",
      "a;b",
      "a:b",
      // Reserved target names, including the two cache targets the Makefile
      // generator adds.
      "all",
      "clean",
      "help",
      "install",
      "preinstall",
      "edit_cache",
      "rebuild_cache",
      // CMake reserves these three in exactly this case (verified with CMake
      // 3.28.3 and Unix Makefiles, the repository's own floor).
      "ALL_BUILD",
      "ZERO_CHECK",
      "INSTALL",
      // The names that are not safe as `build/<name>` even though CMake accepts
      // them: `.` and `..` name a directory, `-x` looks like an option.
      ".",
      "..",
      "-svc",
      "",
    ]) {
      expect(WORKSPACE_NAME_PATTERN.test(name), name).toBe(false);
      expect(workspaceNameProblem(name), name).toBe(WORKSPACE_NAME_MESSAGE);
    }
  });

  it("refuses the file names Windows reserves or rewrites", () => {
    for (const name of [
      "con",
      "CON",
      "Con",
      // A device name with an extension is the same device.
      "con.txt",
      "nul.log",
      "aux",
      "prn",
      "com1",
      "lpt9",
      // Windows strips a trailing dot, so the binary it runs is not the one the
      // manifest names.
      "svc.",
    ]) {
      expect(workspaceNameProblem(name), name).toBe(WORKSPACE_NAME_MESSAGE);
    }
  });
});
