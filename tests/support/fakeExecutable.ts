import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { EXE, isWindows } from "../../src/toolchains/host.js";

/**
 * Executables that stand in for the things uvp would otherwise start.
 *
 * A good half of this repository's lanes work by starting a real process: a
 * built service that answers HTTP, a `cmake` that configures a workspace, a
 * container runtime that is only ever asked for its version. None of them can be
 * the real thing — the point of those lanes is that they run with no toolchain
 * installed — so each one is a file a test writes and a process the *operating
 * system* starts.
 *
 * That last part is where a POSIX-shaped fixture stops being portable, and it is
 * what #18 is. A `#!/bin/sh` script with no extension is a program on Unix and is
 * not one on Windows: `CreateProcess` starts images rather than scripts, and the
 * product's own lookup asks for `name.exe` (`whichOnPath`, `src/toolchains/host.ts`).
 * Forty-five tests failed on the Windows lane because of it, and every one of them
 * failed on the fixture rather than on the code it was written about. This module
 * is the single owner of "install something a foreign process will start", so the
 * host difference is spelled once instead of in nine fixtures.
 *
 * ## The two ways a fake gets its program
 *
 * Who chooses the fake's arguments decides which mechanism works, and the two are
 * not interchangeable — this is measured, not assumed (see the analysis on #18):
 *
 * - **The launcher does.** `uvp_run` is handed `args`, `uvp_verify` is handed
 *   `run.args`, and both pass them straight to the child. So the program travels
 *   in the arguments, and the fake itself is only a way to start this Node:
 *   a shell script that `exec`s it on Unix, a copy of `process.execPath` on
 *   Windows. `installFakeExecutable` is this case.
 * - **The fake's caller does.** A provider runs `cmake -S … -B …` or
 *   `docker --version` with arguments no test supplies. There the program has to
 *   live inside the fake: baked into the shell script on Unix, and carried by a
 *   preload module on Windows — `NODE_OPTIONS`, which is the only lever a test
 *   has over a Node whose command line it does not choose. `installFakeTool` is
 *   this case, and it is the more expensive one: the copy is still Node, so it
 *   can only be handed a command line Node would accept (below).
 *
 * ## What a copied Node cannot say, and what to do instead
 *
 * A preload does not run for `--version`: Node answers that in its own bootstrap
 * before any JavaScript, so a copy of Node handed `--version` reports Node's
 * version and there is no way to tell it otherwise. Where a test asserted a
 * banner for that reason, the honest repair is to *measure* what the tool says
 * and assert that the caller reported it — the relation is the claim, and the
 * string was only ever a way of writing it down.
 *
 * ## What a copied Node cannot be handed, which is the larger limit
 *
 * The copy is Node, so Node parses the arguments before the preload can run, and
 * the arguments of the second case above are the *tool's*, not Node's. Measured
 * on the lane that tried it:
 *
 *     node -S /tmp/ws -B /tmp/ws/build -DCMAKE_BUILD_TYPE=Debug
 *     node: bad option: -S                       → exit 9, nothing imported
 *     node --build /tmp/ws/build
 *     node: bad option: --build                  → exit 9, nothing imported
 *
 * So `installFakeTool` stands in for a tool whose command line happens to be
 * Node's — a `--version` probe is the one this suite relies on, and it does so
 * with the measurement above rather than an assertion — but it cannot stand in
 * for one that is handed its own flags. The launcher-chosen case has no such
 * limit: there the program is the first argument, so Node finds a script before
 * it finds an option. Two tests in `LocalToolchainProvider.test.ts` are skipped on
 * Windows for this reason, named in their own titles, and the wall is filed as
 * #22 rather than worked around here.
 *
 * ## What this module does not own
 *
 * Not the shell quoting of a recorded command line: that is
 * `src/toolchains/processRunner.ts`'s `shellQuote`, which renders an environment
 * for a *reader* in the POSIX dialect. This one builds a script the host will
 * actually run, which is the same character in a different job.
 */

/** The program a fake runs. */
export interface FakeProgram {
  /** Absolute path to the module the fake runs. */
  readonly module: string;
  /** Arguments the program is given before any the launcher adds. */
  readonly args?: readonly string[];
}

/** An installed fake, and what starting it takes. */
export interface FakeExecutable {
  /** The path to hand to whatever will start it. */
  readonly path: string;
  /** Arguments the launcher must pass, when the launcher is the one choosing them. */
  readonly args: readonly string[];
  /**
   * What has to be in the environment of whoever starts it — a preload, or
   * nothing. `uvp_run` takes this as its `env`; a test whose launcher is a
   * provider puts it on `process.env` for the duration, which is the only place
   * a provider's children inherit from.
   */
  readonly env: Readonly<Record<string, string>>;
}

/** `value` as one POSIX word, for a script this host will run. */
const asShellWord = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * A file the operating system will start, holding a program that runs this Node.
 *
 * The two hosts are not two spellings of one thing and the comments say so at
 * each: on Unix the file is a script, and on Windows it is a copy of the Node
 * binary itself. `EXE` comes from `src/toolchains/host.ts` rather than being
 * spelled again here, so the name this installs under is the name the product's
 * own lookup will find.
 */
const installNodeBackedFile = async (
  dir: string,
  name: string,
  posixScript: () => string,
): Promise<string> => {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name + EXE);
  if (isWindows) {
    // A copy, not a link. `fs.linkSync` is the cheap path and it is not
    // portable: it fails across volumes, and a Windows runner keeps Node on `C:`
    // while its temporary directory is elsewhere. The copy is 126 MB, so an
    // existing one is reused when its size still matches — tests install the same
    // name into the same workspace repeatedly, and that would otherwise be a
    // copy per test.
    const source = process.execPath;
    const { size } = await stat(source);
    const present =
      existsSync(path) &&
      (await stat(path).then(
        (existing) => existing.size === size,
        () => false,
      ));
    if (!present) await copyFile(source, path);
    return path;
  }
  await writeFile(path, posixScript(), { mode: 0o755 });
  // `writeFile`'s mode is masked by the umask, and a fake that is not executable
  // is indistinguishable from a missing one at every point of use.
  await chmod(path, 0o755);
  return path;
};

/**
 * A fake the launcher starts, with the program as the first argument.
 *
 * The program is not part of the file: the caller passes `args` to whatever
 * starts the fake — `uvp_run`'s `args`, `uvp_verify`'s `run.args` — and the fake
 * runs its first argument as a Node module. That is why the same installation
 * can serve a hundred tests, and why nothing here needs a preload.
 */
export const installFakeExecutable = async (
  dir: string,
  name: string,
  program: FakeProgram,
): Promise<FakeExecutable> => {
  const path = await installNodeBackedFile(
    dir,
    name,
    // `"$@"` rather than the module's path: the arguments are the caller's, and
    // they are already exactly Node's command line.
    () =>
      [
        "#!/bin/sh",
        "# Written by tests/support/fakeExecutable.ts, not by uvp.",
        `exec ${asShellWord(process.execPath)} "$@"`,
        "",
      ].join("\n"),
  );
  return {
    path,
    args: [program.module, ...(program.args ?? [])],
    env: {},
  };
};

/**
 * A fake whose own program is baked in, for a caller that chooses the arguments.
 *
 * On Unix the script `exec`s this Node with the module, so the fake's arguments
 * arrive after it — which is what a provider's `cmake -S … -B …` expects to be
 * the tool's own. On Windows the copy of Node is told to load a preload module
 * through `NODE_OPTIONS`, because the command line belongs to the provider and
 * there is nothing else a test can put a program in.
 *
 * The returned `env` is not optional: a caller that drops it gets a copy of Node
 * that does not know what it is standing in for.
 *
 * On Windows the caller must also be one whose arguments this fake could have been
 * given itself — the copy parses them as Node's, and exits 9 on anything else.
 * See "What a copied Node cannot be handed" above.
 */
export const installFakeTool = async (
  dir: string,
  name: string,
  program: FakeProgram,
): Promise<FakeExecutable> => {
  const words = [program.module, ...(program.args ?? [])].map(asShellWord).join(" ");
  const script = [
    "#!/bin/sh",
    "# Written by tests/support/fakeExecutable.ts, not by uvp.",
    `exec ${asShellWord(process.execPath)} ${words} "$@"`,
    "",
  ].join("\n");

  // The preload has to decide whether it is the fake answering or an unrelated
  // Node that happened to inherit `NODE_OPTIONS`. The condition is the one thing
  // that distinguishes them: a Node standing in for another tool is handed that
  // tool's arguments, and a Node running a script is handed the script.
  //
  // `node -e '…'` is the one command line this mistakes for a fake — Node leaves
  // `argv[1]` unset for it. Nothing in this repository spawns one from a test
  // that installs a tool with this function, and a fixture that did would have to
  // give the fake its own marker rather than rely on argument shape alone.
  const preload = [
    "// Written by tests/support/fakeExecutable.ts, not by uvp.",
    'import { existsSync } from "node:fs";',
    "",
    "const asked = process.argv[1];",
    "if (asked === undefined || !existsSync(asked)) {",
    `  await import(${JSON.stringify(pathToFileURL(program.module).href)});`,
    "}",
    "",
  ].join("\n");

  const preloadPath = join(dir, `${name}.preload.mjs`);
  const path = await installNodeBackedFile(dir, name, () => script);
  if (isWindows) await writeFile(preloadPath, preload);
  return {
    path,
    args: [],
    env: isWindows ? { NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}` } : {},
  };
};
