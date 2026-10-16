import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { BuildRequest } from "../../application/ToolchainProvider.js";
import { toUvpError } from "../../domain/errors.js";
import type { UvpError } from "../../domain/errors.js";
import { installFakeTool } from "../../../tests/support/fakeExecutable.js";
import { CONFIG_HEADER_RELATIVE_PATHS } from "../libuvcppConfig.js";
import type { ProcessOutcome, RunProcessOptions } from "../processRunner.js";
import { ContainerToolchainProvider, RUNTIME_CANDIDATES } from "./ContainerToolchainProvider.js";
import type { RunSlot } from "./ContainerToolchainProvider.js";

/**
 * What the container provider runs, and what it says when it cannot run it.
 *
 * ## What this file can and cannot establish
 *
 * This host has no container runtime, so nothing here starts a container. Every
 * command the provider would issue is recorded instead, through the `run` seam,
 * and the assertions are about the recorded command line and the honest gap the
 * provider reports. That is enough to check the two things that are actually
 * checkable offline — the *construction* of the commands, and the *shape* of
 * each failure — and it is not evidence about docker, podman, or any image. A
 * test here that "passed" against a real runtime would be a different test.
 *
 * The runtime lookup is not scripted: `whichOnPath` and `versionOf` run against
 * a real executable placed on a real `PATH` for the duration of this file, so
 * the resolution path is the one a user hits, and only the container commands are
 * intercepted. That executable is installed by `tests/support/fakeExecutable.ts`
 * rather than written here, because a program this host will start is not a shell
 * script on every host — and the one assertion that depended on what the fake
 * *says* now measures it, for the reason given at `whatItAnnounces` below.
 *
 * ## Why the separator question cannot be settled here
 *
 * The provider joins the in-image config-header layouts with `/` rather than with
 * `path.join`, because a Windows host would otherwise search the image for
 * `\usr\local\include\uvcpp\uvcpp_config.h`. On Linux both joins produce the same
 * string, so no assertion in this file can tell them apart. The order and the set
 * of layouts *are* checked, against `CONFIG_HEADER_RELATIVE_PATHS` itself rather
 * than against a copy of it.
 */

const IMAGE = "uvp-test-image:1";
/** A command name that cannot collide with a runtime installed on the host. */
const SHIM = "uvp-container-shim";

/** A command this test's `PATH` deliberately does not contain. */
const ABSENT_RUNTIME = "uvp-container-absent";

/**
 * The runtime the tests below resolve, as the program it runs.
 *
 * A file rather than a banner in a shell script, because what this host will
 * start is a question with one owner — `tests/support/fakeExecutable.ts` — and
 * the answer is not a shell script on every host. The provider chooses this
 * command's arguments itself (`--version`, and nothing else), so the program is
 * baked into the fake rather than passed to it.
 */
const ANNOUNCES_ITSELF = fileURLToPath(
  new URL("../../../tests/support/fixtures/announcesItself.mjs", import.meta.url),
);

let root: string;
let savedPath: string | undefined;
let savedNodeOptions: string | undefined;

/**
 * What the shim says when it is asked who it is, measured rather than assumed.
 *
 * The assertion that uses this is a *relation* — the provider reports what the
 * runtime announced — and a literal string was only ever one way of writing it
 * down. It cannot be a literal, because on Windows this shim is a copy of Node,
 * and Node answers `--version` in its own bootstrap before any JavaScript runs:
 * the banner this file's fixture prints is reachable there only through the
 * preload, which `--version` never triggers. What the copy announces is therefore
 * a fact about the host, and asserting a fixed string would be asserting one.
 */
const whatItAnnounces = (): string => {
  const printed = execFileSync(SHIM, ["--version"], { encoding: "utf8" });
  const first = printed
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (first === undefined) throw new Error(`${SHIM} announced nothing`);
  return first;
};

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "uvp-container-")));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });

  savedPath = process.env["PATH"];
  savedNodeOptions = process.env["NODE_OPTIONS"];
  const shim = await installFakeTool(bin, SHIM, { module: ANNOUNCES_ITSELF });
  // The provider resolves and runs this the way a user's runtime would be resolved
  // and run — through this file's real `PATH`, with this process's environment —
  // so whatever the fake needs in order to answer has to be there before the first
  // provider call, not passed to it.
  if (shim.env["NODE_OPTIONS"] !== undefined) {
    process.env["NODE_OPTIONS"] = shim.env["NODE_OPTIONS"];
  }
  process.env["PATH"] = [bin, savedPath ?? ""].join(delimiter);
});

afterAll(() => {
  if (savedPath === undefined) delete process.env["PATH"];
  else process.env["PATH"] = savedPath;
  if (savedNodeOptions === undefined) delete process.env["NODE_OPTIONS"];
  else process.env["NODE_OPTIONS"] = savedNodeOptions;
  rmSync(root, { recursive: true, force: true });
});

/** The command line a recorded call amounts to, in the form a caller reads. */
const lineOf = (options: RunProcessOptions): string =>
  [options.command, ...options.args].map((part) => part.replaceAll("\n", " ")).join(" ");

const outcomeFor = (
  options: RunProcessOptions,
  overrides: Partial<ProcessOutcome>,
): ProcessOutcome => ({
  command: lineOf(options),
  exitCode: 0,
  signal: null,
  timedOut: false,
  aborted: false,
  durationMs: 1,
  stdout: "",
  stderr: "",
  stdoutBytes: 0,
  stderrBytes: 0,
  stdoutTruncated: false,
  stderrTruncated: false,
  ...overrides,
});

type Answer = Partial<ProcessOutcome> | ((options: RunProcessOptions) => Partial<ProcessOutcome>);

/**
 * A `run` slot that answers from a list, in order, and refuses to be asked more
 * than it was given.
 *
 * The refusal is the point rather than a safety net: a provider that started one
 * command more than the scenario describes has done something the scenario does
 * not claim, and answering it with a default would hide exactly that.
 */
const scripted = (
  answers: readonly Answer[],
): { readonly run: RunSlot; readonly calls: readonly RunProcessOptions[] } => {
  const calls: RunProcessOptions[] = [];
  const run: RunSlot = async (options) => {
    const answer = answers[calls.length];
    calls.push(options);
    if (answer === undefined) {
      throw new Error(
        `the provider started a command the scenario does not describe (${String(answers.length)} given): ${lineOf(options)}`,
      );
    }
    return outcomeFor(options, typeof answer === "function" ? answer(options) : answer);
  };
  return { run, calls };
};

/** A provider whose runtime is the real shim on this file's `PATH`. */
const providerWith = (
  answers: readonly Answer[],
  extra: Partial<ConstructorParameters<typeof ContainerToolchainProvider>[0]> = {},
): {
  readonly provider: ContainerToolchainProvider;
  readonly calls: readonly RunProcessOptions[];
} => {
  const { run, calls } = scripted(answers);
  const provider = new ContainerToolchainProvider({ ...extra, image: IMAGE, runtime: SHIM, run });
  return { provider, calls };
};

/** The image-inspection call the provider makes before it dares touch the image. */
const INSPECT_OK: Answer = { exitCode: 0 };

const requestFor = (signal: AbortSignal, overrides: Partial<BuildRequest> = {}): BuildRequest => ({
  workspacePath: join(root, "workspace"),
  buildDir: join(root, "workspace", "build"),
  buildType: "Debug",
  clean: false,
  timeoutMs: 60_000,
  configureOnly: false,
  signal,
  ...overrides,
});

const live = (): AbortSignal => new AbortController().signal;

/**
 * The failure a call reported, or `undefined` when it answered instead.
 *
 * Through `toUvpError` rather than `rejects.toMatchObject`, because a
 * `UvpFailure` keeps its fields on a `detail` object and `code` is not an own
 * enumerable property of the error — an assertion written against the error's
 * visible shape compares against `undefined`, and `rejects` would then pass for
 * a failure of any kind, including one with no code at all.
 */
const failureFrom = async (call: () => Promise<unknown>): Promise<UvpError | undefined> => {
  try {
    await call();
  } catch (cause) {
    return toUvpError(cause);
  }
  return undefined;
};

describe("the container provider, finding something to run in", () => {
  it("starts nothing and names the gap when no runtime is on PATH", async () => {
    const { run, calls } = scripted([]);
    const provider = new ContainerToolchainProvider({
      image: IMAGE,
      run,
      runtimes: [{ id: ABSENT_RUNTIME, command: ABSENT_RUNTIME }],
    });

    const availability = await provider.inspectAvailability(live());
    expect(availability.available).toBe(false);
    expect(availability.missing.map((gap) => gap.id)).toEqual(["container_runtime"]);
    expect(availability.missing[0]?.requiredFor).not.toBe("");
    // The reason has to say what was looked for, or a caller with podman
    // installed somewhere strange has nothing to act on.
    expect(availability.limitations.join(" ")).toContain(ABSENT_RUNTIME);
    expect(calls).toEqual([]);
  });

  it("lists the runtimes it will drive, most common first, and not the one that cannot run an image", () => {
    expect(RUNTIME_CANDIDATES.map((candidate) => candidate.id)).toEqual([
      "docker",
      "podman",
      "nerdctl",
    ]);
    // `buildah` builds images and does not run them, so listing it would offer a
    // capability the rest of this provider cannot use.
    expect(RUNTIME_CANDIDATES.map((candidate) => candidate.id)).not.toContain("buildah");
  });

  it("resolves a runtime that is there, and reports how it announced itself", async () => {
    const { provider, calls } = providerWith([{ exitCode: 1 }]);
    const availability = await provider.inspectAvailability(live());

    // The relation, not the string: the provider reports what the runtime said,
    // and what the runtime says is read from the runtime itself above.
    const announced = whatItAnnounces();
    expect(announced).not.toBe("");
    expect(availability.version).toBe(announced);
    expect(availability.limitations.join(" ")).toContain(`Runtime is ${SHIM}.`);
    // Resolving a runtime is a host lookup, not a container start: the first
    // thing this provider runs in a container is the image inspection.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["image", "inspect", IMAGE]);
  });
});

describe("the container provider, and the image it will not fetch", () => {
  it("reports an absent image as a gap and asks the caller to fetch it", async () => {
    const { provider, calls } = providerWith([{ exitCode: 1, stderr: "No such image" }]);
    const availability = await provider.inspectAvailability(live());

    expect(availability.available).toBe(false);
    expect(availability.missing.map((gap) => gap.id)).toEqual([`image:${IMAGE}`]);
    expect(availability.missing[0]?.requiredFor).not.toBe("");
    expect(availability.limitations.join(" ")).toContain("does not pull images");
    // The claim "uvp never pulls an image" is only true if nothing else about the
    // image is attempted either, so the probe must not have run.
    expect(calls).toHaveLength(1);
  });

  it("reports an image that will not run as unexamined rather than as empty", async () => {
    const { provider, calls } = providerWith([
      INSPECT_OK,
      { exitCode: 125, stderr: "exec format error" },
    ]);
    const availability = await provider.inspectAvailability(live());

    expect(availability.available).toBe(false);
    expect(availability.missing.map((gap) => gap.id)).toEqual(["image_runnable"]);
    // The distinction this pins: a container that failed to start says nothing
    // about whether a compiler is in it, and a `compiler` gap here would send a
    // caller looking for something that may well be present.
    expect(availability.missing.map((gap) => gap.id)).not.toContain("compiler");
    expect(availability.limitations.join(" ")).toContain("did not run to completion");
    expect(calls).toHaveLength(2);
  });
});

describe("the container provider, reading the toolchain out of an image", () => {
  const probe = (stdout: string, exitCode = 0): readonly Answer[] => [
    INSPECT_OK,
    { exitCode, stdout },
  ];

  const probed = (stdout: string) => providerWith(probe(stdout));

  it("orders the compilers by its own preference, not by the order the image listed them", async () => {
    // Deliberately ascending-alphabetical, which is neither this provider's
    // preference order nor `local`'s, so a provider that echoed the probe back
    // would produce a different list from the one asserted here.
    const { provider } = probed(
      [
        "c++\t/usr/bin/c++\tc++ 13.2.0",
        "cc\t/usr/bin/cc\tcc 13.2.0",
        "clang\t/usr/bin/clang\tclang 18.1.3",
        "clang++\t/usr/bin/clang++\tclang 18.1.3",
        "cmake\t/usr/bin/cmake\tcmake 3.28.3",
        "g++\t/usr/bin/g++\tg++ 13.2.0",
        "gcc\t/usr/bin/gcc\tgcc 13.2.0",
        "make\t/usr/bin/make\tGNU Make 4.3",
      ].join("\n"),
    );
    const availability = await provider.inspectAvailability(live());

    expect(availability.compilers.map((compiler) => compiler.id)).toEqual(["clang", "gcc", "cc"]);
    expect(availability.buildSystems.map((system) => system.id)).toEqual(["cmake", "make"]);
    expect(availability.compilers[0]?.path).toBe("/usr/bin/clang++");
    expect(availability.compilers[0]?.version).toBe("clang 18.1.3");
    expect(availability.available).toBe(true);
  });

  it("takes the first spelling of a candidate the image has, once", async () => {
    const { provider } = probed(
      [
        "gcc\t/usr/bin/gcc\tgcc 13.2.0",
        "g++\t/usr/bin/g++\tg++ 13.2.0",
        "cmake\t/usr/bin/cmake\t3.28.3",
      ].join("\n"),
    );
    const availability = await provider.inspectAvailability(live());

    // One entry for gcc, and it is the C++ driver: a list holding both spellings
    // would report one compiler twice and let a caller pick the wrong one.
    expect(availability.compilers).toHaveLength(1);
    expect(availability.compilers[0]?.id).toBe("gcc");
    expect(availability.compilers[0]?.path).toBe("/usr/bin/g++");
  });

  it("names the gaps that follow from what the image has", async () => {
    const { provider } = probed("cmake\t/usr/bin/cmake\tcmake version 3.28.3");
    const availability = await provider.inspectAvailability(live());

    expect(availability.missing.map((gap) => gap.id)).toEqual(["compiler", "ninja"]);
    for (const gap of availability.missing) expect(gap.requiredFor).not.toBe("");
    expect(availability.available).toBe(false);
    expect(availability.version).toBe("cmake version 3.28.3");
  });

  it("says the paths it reports are inside the image", async () => {
    const { provider } = probed("cmake\t/usr/bin/cmake\t3.28.3");
    const availability = await provider.inspectAvailability(live());

    // A caller who took `/usr/bin/cmake` for a path on this machine would get a
    // confusing failure rather than a surprising one, so the report says so.
    expect(availability.limitations.join(" ")).toContain("inside the image");
  });

  it("ignores probe output that is not a name, a path, and a version", async () => {
    const { provider } = probed(
      [
        "warning: something",
        "",
        "cmake\t\t",
        "cmake\t/usr/bin/cmake\t3.28.3",
        "extra\tfields\there\tagain",
      ].join("\n"),
    );
    const availability = await provider.inspectAvailability(live());

    expect(availability.buildSystems.map((system) => system.id)).toEqual(["cmake"]);
  });
});

describe("the container provider, finding the libuvcpp inside the image", () => {
  const headerScript = (calls: readonly RunProcessOptions[]): string => {
    const script = calls[1]?.args.at(-1);
    if (typeof script !== "string") throw new Error("the provider ran no header search");
    return script;
  };

  const listPrefixes = (script: string): readonly string[] =>
    [...script.matchAll(/printf 'PREFIX\\t%s\\t%s\\n' '([^']*)'/gu)].map((match) => match[1] ?? "");

  /** Each `(prefix, directory, file)` attempt, in the order the script makes them. */
  const listAttempts = (script: string): readonly string[] =>
    [...script.matchAll(/printf 'PREFIX\\t%s\\t%s\\n' '([^']*)' '([^']*)'; cat '([^']*)'/gu)].map(
      (match) => `${match[1] ?? ""}|${match[2] ?? ""}|${match[3] ?? ""}`,
    );

  it("refuses to answer when it has no runtime with which to look", async () => {
    const { run } = scripted([]);
    const provider = new ContainerToolchainProvider({
      image: IMAGE,
      run,
      runtimes: [{ id: ABSENT_RUNTIME, command: ABSENT_RUNTIME }],
    });

    const failure = await failureFrom(() => provider.findLibuvcpp(undefined, live()));
    // Not `found: false`, which every caller reads as "there is no libuvcpp in
    // there" — a claim about the image that nothing here observed.
    expect(failure?.code).toBe("toolchain_unavailable");
    expect(failure?.message).toContain(IMAGE);
    expect(failure?.remediation.action).not.toBe("");
  });

  it("refuses to answer when the image is not present either", async () => {
    const { provider } = providerWith([{ exitCode: 1 }]);

    const failure = await failureFrom(() => provider.findLibuvcpp(undefined, live()));
    expect(failure?.code).toBe("toolchain_unavailable");
    expect(failure?.message).toContain(IMAGE);
  });

  it("searches the layouts the shared owner declares, in that order", async () => {
    const { provider, calls } = providerWith([INSPECT_OK, { exitCode: 1 }]);
    await provider.findLibuvcpp(undefined, live());

    // Written against the owner rather than a copy of it: a layout added there
    // has to reach the image and a layout dropped there has to stop being
    // searched. The joining is this file's own, and only because `/` is what a
    // shell inside the image can open.
    const expected = ["/usr/local", "/usr", "/opt/libuvcpp"].flatMap((prefix) =>
      CONFIG_HEADER_RELATIVE_PATHS.map((segments) => {
        const directory = [prefix, ...segments.slice(0, -1)].join("/");
        return `${prefix}|${directory}|${[prefix, ...segments].join("/")}`;
      }),
    );
    expect(listAttempts(headerScript(calls))).toEqual(expected);
  });

  it("reads the version from the directory the config header was found in", async () => {
    // The flattened layout, which is the case a fixed `include/uvcpp/` suffix
    // would get wrong: the search would find the install and then report no
    // version for it, which reads as "this install does not say".
    const { provider, calls } = providerWith([
      INSPECT_OK,
      {
        exitCode: 0,
        stdout: "PREFIX\t/opt/flat\t/opt/flat/include\n#define UVCPP_WEB_ENABLE 1\n",
      },
      {
        exitCode: 0,
        stdout:
          "#define UVCPP_VERSION_MAJOR 1\n#define UVCPP_VERSION_MINOR 4\n#define UVCPP_VERSION_PATCH 4\n",
      },
    ]);

    const found = await provider.findLibuvcpp(undefined, live());
    expect(found.installPrefix).toBe("/opt/flat");
    expect(found.version).toBe("1.4.4");
    expect(calls[2]?.args.at(-1)).toContain('cat "/opt/flat/include/uvcpp_version.h"');
  });

  it("searches a caller-named prefix before the conventional ones", async () => {
    const { provider, calls } = providerWith([INSPECT_OK, { exitCode: 1 }], {
      libuvcppPrefix: "/opt/mine",
    });
    await provider.findLibuvcpp(undefined, live());

    const prefixes = listPrefixes(headerScript(calls));
    expect(prefixes.at(0)).toBe("/opt/mine");
    expect(new Set(prefixes)).toEqual(
      new Set(["/opt/mine", "/usr/local", "/usr", "/opt/libuvcpp"]),
    );
  });

  it("reads the modules and the version out of the image", async () => {
    const { provider } = providerWith([
      INSPECT_OK,
      {
        exitCode: 0,
        stdout:
          "PREFIX\t/opt/libuvcpp\t/opt/libuvcpp/include/uvcpp\n" +
          "#  define UVCPP_WEB_ENABLE 1\n" +
          "#define UVCPP_TRY_WRITE_MIN_BYTES 32768\n",
      },
      {
        exitCode: 0,
        stdout:
          "#define UVCPP_VERSION_MAJOR 1\n#define UVCPP_VERSION_MINOR 7\n#define UVCPP_VERSION_PATCH 0\n",
      },
    ]);

    const found = await provider.findLibuvcpp(undefined, live());
    expect(found.found).toBe(true);
    expect(found.installPrefix).toBe("/opt/libuvcpp");
    expect(found.modules).toEqual(["UVCPP_WEB_ENABLE"]);
    expect(found.version).toBe("1.7.0");
    expect(found.versionSource).toBe("version_file");
  });

  it("says what it searched when the image has no header", async () => {
    const { provider } = providerWith([INSPECT_OK, { exitCode: 1 }]);
    const found = await provider.findLibuvcpp(undefined, live());

    expect(found.found).toBe(false);
    expect(found.modules).toEqual([]);
    expect(found.installPrefix).toBeUndefined();
    expect(found.version).toBeUndefined();
    expect(found.note).toContain("/opt/libuvcpp");
    expect(found.note).toContain(IMAGE);
  });
});

describe("the container provider, building in the image", () => {
  const mountPairs = (options: RunProcessOptions | undefined): readonly string[] =>
    (options?.args ?? []).filter((argument) => argument.startsWith("type=bind,"));

  const envPairs = (options: RunProcessOptions | undefined): readonly string[] => {
    const args = options?.args ?? [];
    return args.flatMap((argument, index) => (argument === "-e" ? [args[index + 1] ?? ""] : []));
  };

  it("mounts the workspace and the build directory where the caller named them", async () => {
    const { provider, calls } = providerWith([{ exitCode: 0 }]);
    const request = requestFor(live(), { configureOnly: true });
    await provider.createClient().build(request);

    const configure = calls[0];
    expect(mountPairs(configure)).toEqual([
      `type=bind,source=${request.workspacePath},target=${request.workspacePath}`,
      `type=bind,source=${request.buildDir},target=${request.buildDir}`,
    ]);
    // The same path on both sides is what keeps every path in the outcome valid
    // on the host, so `--workdir` and the `-S`/`-B` arguments are the same
    // strings the caller passed rather than anything translated.
    expect(configure?.args).toContain(request.workspacePath);
    expect(configure?.args.join(" ")).toContain(`--workdir ${request.workspacePath}`);
    expect(configure?.args.join(" ")).toContain(
      `cmake -S ${request.workspacePath} -B ${request.buildDir} -DCMAKE_BUILD_TYPE=Debug`,
    );
  });

  it("mounts a path once, even when the caller names it twice", async () => {
    const { provider, calls } = providerWith([{ exitCode: 0 }]);
    const request = requestFor(live(), { configureOnly: true });
    await provider.createClient().build({ ...request, buildDir: request.workspacePath });

    // Docker rejects a repeated bind target, so this is a refusal to start
    // rather than a cosmetic duplicate.
    expect(mountPairs(calls[0])).toHaveLength(1);
  });

  it("builds the container's prefix path from the prefix, not from this host's", async () => {
    const saved = process.env["CMAKE_PREFIX_PATH"];
    process.env["CMAKE_PREFIX_PATH"] = "/host/only/prefix";
    try {
      const { provider, calls } = providerWith([{ exitCode: 0 }], {
        libuvcppPrefix: "/opt/mine",
      });
      await provider.createClient().build(requestFor(live(), { configureOnly: true }));

      // The locale pair leads because it is spread in first, from the module that
      // owns the language the build's output is read in; the two prefix variables
      // are this provider's own addition. Asserted as the whole list rather than by
      // membership, so a variable that stopped being passed is a failure here and
      // not something a reader has to notice.
      expect(envPairs(calls[0])).toEqual([
        "LC_ALL=",
        "LC_MESSAGES=C",
        "CMAKE_PREFIX_PATH=/opt/mine",
        "PKG_CONFIG_PATH=/opt/mine/lib/pkgconfig:/opt/mine/lib64/pkgconfig",
      ]);
      // The image's filesystem is not this one, so a host prefix would name a
      // directory that does not exist in there.
      expect(calls[0]?.args.join(" ")).not.toContain("/host/only/prefix");
    } finally {
      if (saved === undefined) delete process.env["CMAKE_PREFIX_PATH"];
      else process.env["CMAKE_PREFIX_PATH"] = saved;
    }
  });

  it("passes no prefix at all when nobody named one", async () => {
    const { provider, calls } = providerWith([{ exitCode: 0 }]);
    await provider.createClient().build(requestFor(live(), { configureOnly: true }));

    // Not the host's, and not a guessed `/usr/local`: a workspace that needs a
    // prefix uvp invented would configure against a libuvcpp uvp never checked.
    // The locale pair is neither of those and is not conditional — it is the
    // language the output is read in, so leaving it out would let the image's
    // linker answer in its own locale while every format uvp parses is English.
    expect(envPairs(calls[0])).toEqual(["LC_ALL=", "LC_MESSAGES=C"]);
    expect(calls[0]?.args.join(" ")).not.toContain("CMAKE_PREFIX_PATH");
  });

  it("refuses the MSBuild generator rather than letting it fail inside the image", async () => {
    const { provider, calls } = providerWith([{ exitCode: 0 }]);
    const failure = await failureFrom(() =>
      provider
        .createClient()
        .build(requestFor(live(), { generator: "msbuild", configureOnly: true })),
    );

    expect(failure?.code).toBe("unsupported_toolchain");
    expect(calls).toEqual([]);
  });

  it("treats a build that arrived cancelled as cancelled, without starting anything", async () => {
    // Preceded by an inspection, so the runtime is already resolved. Without
    // that the check would be satisfied by the runtime lookup refusing the
    // withdrawn signal on its way past, and the build would never have been the
    // thing that noticed — which is a different code path, and not the one a
    // second build in a session takes. There the runtime is known, and the
    // withdrawal is the only thing left that can stop the container start.
    const { provider, calls } = providerWith([{ exitCode: 1 }]);
    await provider.inspectAvailability(live());
    const before = calls.length;

    const controller = new AbortController();
    controller.abort();
    const failure = await failureFrom(() =>
      provider.createClient().build(requestFor(controller.signal)),
    );

    // Not `toolchain_unavailable`, which is what a resolver asked first would
    // answer on a host with no runtime: a finding about this machine, drawn from
    // a search the caller had already stopped, for a build that never began.
    expect(failure?.code).toBe("cancelled");
    expect(failure?.retryable).toBe(false);
    expect(failure?.message).toContain("cancelled");
    expect(calls).toHaveLength(before);
  });

  it("answers a configure that failed with its outcome and its diagnostics", async () => {
    const { provider } = providerWith([
      {
        exitCode: 1,
        stderr: `${join(root, "workspace", "src", "main.cpp")}:3:5: error: expected ';'\n`,
      },
    ]);

    const outcome = await provider.createClient().build(requestFor(live()));
    expect(outcome.succeeded).toBe(false);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.diagnostics).toHaveLength(1);
    expect(outcome.diagnostics[0]?.severity).toBe("error");
    expect(outcome.diagnostics[0]?.phase).toBe("configure");
    expect(outcome.commands).toHaveLength(1);
  });
});
