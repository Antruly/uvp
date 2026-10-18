import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { removeTree } from "../../../tests/support/temporaryTree.js";
import { isWindows } from "../host.js";
import {
  chooseMsvcToolset,
  locateMsvcToolset,
  vsWhereCandidates,
} from "./LocalToolchainProvider.js";

/**
 * How uvp finds an MSVC that is installed but not on `PATH`.
 *
 * `cl.exe` is only on `PATH` inside a Developer Command Prompt, so a `PATH` probe
 * reports no compiler on a host whose CMake builds happily with Visual Studio's
 * generator. [#224](https://github.com/Antruly/uvp/issues/224) is that report:
 * the doctor said "missing: compiler" about a compiler that was installed.
 *
 * The parts that can be wrong are the candidate locations, the ranking when an
 * install holds several toolsets, and what a locator failure means. All three
 * are pure decisions here, pinned on a host that has no `vswhere`, so the rule is
 * covered even though the Windows-only spawn at the end of the chain is not.
 */

const line = (version: string, host: string, target: string): string =>
  `C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\VC\\Tools\\MSVC\\${version}\\bin\\${host}\\${target}\\cl.exe`;

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => removeTree(root)));
});

/** A file a spawned locator could be, so `access(..., X_OK)` answers yes. */
const executableAt = (path: string): string => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
  chmodSync(path, 0o755);
  return path;
};

const temporaryRoot = (): string => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "uvp-vswhere-"));
  roots.push(root);
  return root;
};

describe("where the Visual Studio locator is looked for", () => {
  it("tries Program Files (x86) first, then Program Files", () => {
    const candidates = vsWhereCandidates({
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      ProgramFiles: "C:\\Program Files",
    });

    expect(candidates).toEqual([
      join("C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe"),
      join("C:\\Program Files", "Microsoft Visual Studio", "Installer", "vswhere.exe"),
    ]);
  });

  it("names only the roots the environment actually has", () => {
    expect(vsWhereCandidates({})).toEqual([]);
    expect(vsWhereCandidates({ "ProgramFiles(x86)": "" })).toEqual([]);
    expect(vsWhereCandidates({ ProgramFiles: "D:\\Apps" })).toHaveLength(1);
  });

  it("does not name the same locator twice", () => {
    const candidates = vsWhereCandidates({ "ProgramFiles(x86)": "C:\\PF", ProgramFiles: "C:\\PF" });
    expect(candidates).toHaveLength(1);
  });
});

describe("which toolset wins when the locator names several", () => {
  it("prefers the host-x64 compiler that produces x64 code", () => {
    const stdout = [
      "Visual Studio Locator version 3.1.7",
      "",
      line("14.44.35207", "Hostx86", "x86"),
      line("14.44.35207", "Hostx64", "x86"),
      line("14.44.35207", "Hostx64", "x64"),
    ].join("\r\n");

    expect(chooseMsvcToolset(stdout)).toBe(line("14.44.35207", "Hostx64", "x64"));
  });

  it("compares versions by number, not by string order", () => {
    // 14.9.1 sorts after 14.44.35207 as text and before it as a version.
    const stdout = [line("14.9.1", "Hostx64", "x64"), line("14.44.35207", "Hostx64", "x64")].join(
      "\n",
    );

    expect(chooseMsvcToolset(stdout)).toBe(line("14.44.35207", "Hostx64", "x64"));
  });

  it("breaks a tie by path, so the answer does not depend on output order", () => {
    const community = line("14.44.35207", "Hostx64", "x64");
    const buildTools = community.replace("2022\\Community", "2022\\BuildTools");

    expect(chooseMsvcToolset([community, buildTools].join("\n"))).toBe(buildTools);
    expect(chooseMsvcToolset([buildTools, community].join("\n"))).toBe(buildTools);
  });

  it("answers nothing for output that names no toolset", () => {
    expect(chooseMsvcToolset("")).toBeUndefined();
    expect(chooseMsvcToolset("Visual Studio Locator version 3.1.7\n")).toBeUndefined();
    expect(chooseMsvcToolset("C:\\VS\\VC\\Tools\\MSVC\\14.44\\bin\\Hostx64\\x64\\clang.exe")).toBe(
      undefined,
    );
  });
});

describe("asking the locator without running anything", () => {
  it("does not run a locator off Windows", async () => {
    let ran = false;
    const located = await locateMsvcToolset(false, { ProgramFiles: temporaryRoot() }, async () => {
      ran = true;
      return { problem: "could-not-start" };
    });

    expect(located).toEqual({ problem: "no-locator" });
    expect(ran).toBe(false);
  });

  it("runs the locator that exists and returns the toolset it named", async () => {
    const root = temporaryRoot();
    const locator = executableAt(
      join(root, "PF", "Microsoft Visual Studio", "Installer", "vswhere.exe"),
    );
    const toolset = line("14.44.35207", "Hostx64", "x64");
    const calls: { executable: string; args: readonly string[] }[] = [];

    const located = await locateMsvcToolset(
      true,
      { "ProgramFiles(x86)": join(root, "absent"), ProgramFiles: join(root, "PF") },
      async (executable, args) => {
        calls.push({ executable, args });
        return { stdout: `Visual Studio Locator version 3.1.7\n${toolset}\n` };
      },
    );

    expect(located).toEqual({ path: toolset });
    // The first root was tried and was not there, so the second one is the run.
    expect(calls.map((call) => call.executable)).toEqual([locator]);
    expect(calls[0]?.args ?? []).toContain("-find");
  });

  it("says no locator is installed without running anything", async () => {
    let ran = false;
    const located = await locateMsvcToolset(true, { ProgramFiles: temporaryRoot() }, async () => {
      ran = true;
      return { problem: "could-not-start" };
    });

    expect(located).toEqual({ problem: "no-locator" });
    expect(ran).toBe(false);
  });

  it("separates a locator that could not answer from one that named no toolset", async () => {
    const root = temporaryRoot();
    executableAt(join(root, "PF", "Microsoft Visual Studio", "Installer", "vswhere.exe"));
    const env = { ProgramFiles: join(root, "PF") };

    await expect(
      locateMsvcToolset(true, env, async () => ({ problem: "could-not-start" })),
    ).resolves.toEqual({ problem: "could-not-start" });
    await expect(
      locateMsvcToolset(true, env, async () => ({ problem: "timed-out" })),
    ).resolves.toEqual({ problem: "timed-out" });
    await expect(
      locateMsvcToolset(true, env, async () => ({ problem: "failed" })),
    ).resolves.toEqual({ problem: "failed" });
    // A locator that answered and named nothing is an observation of absence,
    // which is a different answer from any of the three above.
    await expect(
      locateMsvcToolset(true, env, async () => ({
        stdout: "Visual Studio Locator version 3.1.7\n",
      })),
    ).resolves.toEqual({ problem: "named-nothing" });
  });
});

/**
 * The one step that needs the Windows program itself.
 *
 * It runs on the Windows lane, where the answer is a real observation; here the
 * title says what the skip means rather than the suite implying it passed. The
 * assertion is deliberately weak — *a* toolset, anywhere the locator says — because
 * the Windows image's Visual Studio edition and toolset version are not this
 * repository's to pin.
 */
describe("the locator on the host that has one", () => {
  it.skipIf(!isWindows)(
    `finds the installed MSVC by asking vswhere${isWindows ? "" : " — skipped: not a Windows host, where vswhere does not exist"}`,
    async () => {
      const located = await locateMsvcToolset(true);

      // The reason is in the message: a timeout and a locator that answered
      // "nothing installed" would otherwise fail with the same undefined.
      expect("path" in located, `the locator answered ${JSON.stringify(located)}`).toBe(true);
      if ("path" in located) expect(located.path.toLowerCase()).toContain("cl.exe");
    },
  );
});
