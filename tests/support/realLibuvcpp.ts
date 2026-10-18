import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { EXE, isWindows } from "../../src/toolchains/host.js";

/**
 * The shared helper for the lanes that need a real compiler and a real libuvcpp:
 * find the install, generate a workspace, build it, run it, end it, clean up.
 *
 * Everything here talks to **uvp as a process** — the published `bin.uvp`, the
 * same file an installed uvp links — rather than to the modules behind it. That
 * is deliberate and it is what makes these lanes different from the source ones:
 * `services` proves what a workflow does with an injected toolchain, and
 * `composition` proves the wiring, but neither can say whether a *generated
 * project* builds against the libuvcpp on this machine and answers on a socket.
 * Only a real CMake and a real library can.
 *
 * Which lane needs which piece:
 *
 * | Piece | `toolchain` | `acceptance` |
 * | --- | --- | --- |
 * | Discovery (`realLibuvcpp`, `skipReason`) | yes | yes |
 * | `createWorkspace` | yes | yes |
 * | `startService` — the binary, direct | yes | no |
 * | `uvp run` / `uvp stop` — uvp supervising | no | yes |
 *
 * ## What is real here, and what is not
 *
 * | Piece | Where it comes from |
 * | --- | --- |
 * | libuvcpp | The install `uvp doctor` reports — no version is assumed |
 * | CMake, compiler | Whatever `uvp doctor` found, via `uvp build` |
 * | The workspace | `uvp init`, into a fresh temporary directory |
 * | The service | The built binary |
 *
 * `startService` exists so a lane can observe the **deliverable** directly: a
 * generated workspace is a plain CMake project, and a user who never runs uvp
 * again still has a program that serves traffic — so the process under
 * observation is started the way that user would start it, with uvp nowhere
 * between the binary and the wire. A lane whose subject is uvp's own
 * supervision uses `uvp run` instead, and `acceptance` does.
 *
 * ## Skipping instead of failing
 *
 * `realLibuvcpp` is `undefined` when no install could be found, and `skipReason`
 * says so in the words of the observation that produced it. A lane that reported
 * a failure for a missing library would be reporting uvp's health as a fact
 * about the host, and a lane that reported success would be claiming coverage it
 * never had. Neither is available, so it skips, loudly.
 */

const promisified = promisify(execFile);

const REPOSITORY = resolve(import.meta.dirname, "..", "..");

/** The published entry point — `bin.uvp` in package.json, what `npm i -g` links. */
const UVP = join(REPOSITORY, "scripts", "uvp.mjs");

/**
 * The same entry point, for a lane that has to *drive* the CLI rather than call it.
 *
 * `runCli` below waits for an exit code, and `uvp run --no-detach` does not have
 * one until the service it is holding has ended. A lane that tests that wait has
 * to spawn the CLI itself, in its own process group, and read the handle the
 * moment it is printed — which means it needs the file to spawn.
 */
export const uvpEntryPoint: string = UVP;

/**
 * How long one invocation may take.
 *
 * Generous on purpose. This lane compiles C++ against libuvcpp's headers, and a
 * cold configure plus five compiles on a loaded machine is minutes, not seconds.
 * A tighter bound would fire during the compile and report a timeout, which
 * reads as "uvp hung" when the truth is "the machine was busy" — the opposite of
 * what a lane like this exists to establish.
 */
const CLI_TIMEOUT_MS = 600_000;

/** Bounded, like every other capture: a build log is not unbounded input. */
const MAX_CLI_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface CliOutcome {
  readonly args: readonly string[];
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
  /** The result object when stdout held exactly one, otherwise absent. */
  readonly result: Record<string, unknown> | undefined;
}

/**
 * Exactly one JSON object, or nothing.
 *
 * `JSON.parse` is the check rather than a substring search: a banner line before
 * the result, or a trailing summary after it, must make this fail — "the result
 * object, verbatim, and then nothing" is the promise the CLI makes, and anything
 * else is a different promise.
 *
 * Exported because a lane that spawns the CLI itself reads the same promise out
 * of a pipe that never closes — `uvp run --no-detach` prints its result and then
 * waits, so there is no exit to read it after.
 */
export const resultOf = (stdout: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

/**
 * Run the CLI the way a caller does.
 *
 * Both streams are kept and the exit code is returned rather than thrown: an
 * exit code is an outcome here, exactly as it is for `uvp build`'s callers. Only
 * an invocation that never exited — a signal or the deadline — throws, because
 * that is a different kind of fact from "it said no".
 */
export const runCli = async (
  args: readonly string[],
  options: { readonly env?: Readonly<Record<string, string>> } = {},
): Promise<CliOutcome> => {
  const invoke = promisified(process.execPath, [UVP, ...args], {
    cwd: REPOSITORY,
    timeout: CLI_TIMEOUT_MS,
    maxBuffer: MAX_CLI_OUTPUT_BYTES,
    ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
  });
  try {
    const { stdout, stderr } = await invoke;
    return { args, exit: 0, stdout, stderr, result: resultOf(stdout) };
  } catch (cause) {
    const failure = cause as { code?: unknown; stdout?: string; stderr?: string; message: string };
    if (typeof failure.code !== "number") {
      throw new Error(`uvp ${args.join(" ")} did not exit: ${failure.message}`);
    }
    const stdout = failure.stdout ?? "";
    return {
      args,
      exit: failure.code,
      stdout,
      stderr: failure.stderr ?? "",
      result: resultOf(stdout),
    };
  }
};

/** The result object, or a failure that quotes what arrived instead. */
export const resultOrThrow = (outcome: CliOutcome): Record<string, unknown> => {
  if (outcome.result === undefined) {
    throw new Error(
      `uvp ${outcome.args.join(" ")} printed no result (exit ${String(outcome.exit)})\n` +
        `stdout: ${outcome.stdout.slice(0, 500)}\n` +
        `stderr: ${outcome.stderr.slice(0, 500)}`,
    );
  }
  return outcome.result;
};

export interface RealLibuvcpp {
  /** The install prefix every build in this lane is pointed at. */
  readonly prefix: string;
  readonly version: string;
  /** The `UVCPP_*` symbols that build defines as `1`, as it reported them. */
  readonly modules: readonly string[];
}

/** `uvp doctor --json`, run once at import: the facts the whole lane rests on. */
const discovery: CliOutcome = await runCli(["doctor", "--json"]);

const asLibuvcpp = (outcome: CliOutcome): RealLibuvcpp | undefined => {
  const report = outcome.result;
  if (report === undefined) return undefined;
  const lib: unknown = report["libuvcpp"];
  if (typeof lib !== "object" || lib === null) return undefined;
  const {
    found,
    install_prefix: prefix,
    version,
    modules,
  } = lib as {
    readonly found?: unknown;
    readonly install_prefix?: unknown;
    readonly version?: unknown;
    readonly modules?: unknown;
  };
  if (found !== true || typeof prefix !== "string" || typeof version !== "string") return undefined;
  return {
    prefix,
    version,
    modules: Array.isArray(modules)
      ? modules.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
};

/** Why doctor found nothing, in doctor's own words where it had any. */
const reasonNoLibuvcpp = (outcome: CliOutcome): string => {
  if (outcome.result === undefined) {
    const first = `${outcome.stderr}\n${outcome.stdout}`
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "");
    return `uvp doctor did not answer (exit ${String(outcome.exit)})${first === undefined ? "" : `: ${first}`}`;
  }
  const lib: unknown = outcome.result["libuvcpp"];
  const note =
    typeof lib === "object" &&
    lib !== null &&
    typeof (lib as { readonly note?: unknown }).note === "string"
      ? String((lib as { readonly note: unknown }).note)
      : "";
  return note === ""
    ? "uvp doctor found no libuvcpp on this host"
    : `uvp doctor found no libuvcpp: ${note}`;
};

/**
 * The install this lane is about, or `undefined` when there is none.
 *
 * Taken from doctor rather than from a `.pc` file found by this file: the
 * version, the prefix, and the module set are the owning boundary's parsed facts
 * (`LocalToolchainProvider`), and a second reader here would be a second opinion
 * that could disagree with the one a build is guided by.
 */
export const realLibuvcpp: RealLibuvcpp | undefined = asLibuvcpp(discovery);

/** The reason a skipped lane prints. Empty when there is an install to test. */
export const skipReason: string = realLibuvcpp === undefined ? reasonNoLibuvcpp(discovery) : "";

let scratchRoot: string | undefined;

/**
 * The directory every workspace in this lane is generated into.
 *
 * A fresh `mkdtemp` per run rather than a fixed name. A leftover `build/`
 * directory holding a `CMakeCache.txt` that records a different source directory
 * is a configure failure with a message about the source dir, which reads as a
 * uvp bug and is not one — and it is exactly what a re-used path produces when
 * `/tmp` is a symlink and one run spells it differently.
 *
 * Created on demand, so a run that skips creates nothing at all.
 */
export const scratch = (): string =>
  (scratchRoot ??= mkdtempSync(join(realpathSync(tmpdir()), "uvp-toolchain-")));

export interface Workspace {
  readonly name: string;
  readonly template: string;
  readonly port: number;
  readonly root: string;
  readonly buildDir: string;
  readonly binary: string;
}

/** The name uvp writes into the generated project, its CMake target and binary. */
const WORKSPACE_NAME = "svc";

/**
 * How many workspaces this run has made, so two of the same template do not land
 * in one directory.
 *
 * `uvp init` refuses a directory that already has content, which is the right
 * behaviour and a confusing failure to meet from inside a lane: the second
 * `createWorkspace("hello-http")` would fail as "refusing to write into …", which
 * reads as a problem with the template rather than with the caller. A counter
 * rather than the port, because the port is the caller's choice and two callers
 * may legitimately want the same template on the same port at different times.
 */
let made = 0;

/** Generate a workspace from a template, the way a person would. */
export const createWorkspace = async (
  template: string,
  port: number,
  features: readonly string[] = [],
  modules?: readonly string[],
): Promise<Workspace> => {
  const root = join(scratch(), `${template}-${String((made += 1))}`);
  const init = await runCli([
    "init",
    root,
    "--name",
    WORKSPACE_NAME,
    "--template",
    template,
    "--port",
    String(port),
    // Omitted rather than passed empty, so `uvp init`'s own default — the module
    // set a plain web service needs — is what applies. A lane that passed `""`
    // would be testing a workspace no caller can produce.
    ...(features.length === 0 ? [] : ["--features", features.join(",")]),
    // Given rather than omitted when the caller names a selection, including an
    // empty one: `--modules ""` is an explicit "none", which the command
    // preserves on purpose.
    ...(modules === undefined ? [] : ["--modules", modules.join(",")]),
    "--json",
  ]);
  if (init.exit !== 0) {
    throw new Error(
      `uvp init ${template} exited ${String(init.exit)}:\n${init.stderr || init.stdout}`.slice(
        0,
        2_000,
      ),
    );
  }
  const buildDir = join(root, "build");
  return {
    name: WORKSPACE_NAME,
    template,
    port,
    root,
    buildDir,
    // The host names the executable, not the CMake target: on Windows the build
    // writes `svc.exe`, and `existsSync` does not apply `CreateProcess`'s `.exe`
    // suffix the way a spawn does. `EXE` is the product's own answer to how this
    // host names an executable, and it is empty off Windows.
    binary: join(buildDir, WORKSPACE_NAME + EXE),
  };
};

/**
 * Build a generated workspace through uvp. The caller judges the result.
 *
 * On Windows the lane builds Release against the archive. The archive is a
 * release build with the release CRT, and a Debug build against it mixes CRTs.
 * `UVP_WINDOWS_GENERATOR` selects the route: `ninja` names Ninja, and `default`
 * omits `--generator` so CMake chooses the installed Visual Studio — the
 * multi-configuration generator the `--config` selector exists for. The default
 * is Ninja for a local run that does not set the variable.
 */
export const buildWorkspace = async (workspace: Workspace): Promise<CliOutcome> => {
  const windowsGenerator = process.env["UVP_WINDOWS_GENERATOR"] ?? "ninja";
  return await runCli([
    "build",
    workspace.root,
    ...(isWindows
      ? [
          ...(windowsGenerator === "default" ? [] : ["--generator", windowsGenerator]),
          "--build-type",
          "Release",
        ]
      : []),
    "--json",
  ]);
};

const sleep = async (ms: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether the port refuses connections.
 *
 * Used both ways: a port that refuses is free to be taken, and a port that
 * answers is where the service is. A bound is passed on both sides, so a port
 * that neither refuses nor answers — a firewall dropping packets — reports a
 * deadline rather than hanging until the test runner's own timeout.
 */
const refusesConnections = async (port: number, timeoutMs: number): Promise<boolean> =>
  await new Promise<boolean>((resolve) => {
    const probe = createConnection({ host: "127.0.0.1", port });
    const settle = (refused: boolean): void => {
      probe.destroy();
      resolve(refused);
    };
    probe.setTimeout(timeoutMs, () => {
      settle(false);
    });
    probe.once("connect", () => {
      settle(false);
    });
    probe.once("error", () => {
      settle(true);
    });
  });

const waitForPort = async (port: number, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await refusesConnections(port, 1_000))) return true;
    await sleep(50);
  }
  return false;
};

export interface Service {
  readonly workspace: Workspace;
  readonly pid: number;
  /** The newest bytes the service wrote, bounded. Empty if it wrote none. */
  output(): string;
  /** End it politely, and say whether force was needed. */
  stop(): Promise<{ readonly escalated: boolean; readonly code: number | null }>;
}

/**
 * Wait for a service's captured output to match, up to a bound.
 *
 * `startService` resolves on a TCP **connection**, not on a line in the log.
 * The `http3-service` template prints its QUIC notice after `server.listen()`
 * returns (`src/application/templates.ts`), and a listening socket accepts a
 * connection as soon as `listen()` is called — so a probe can connect in the
 * window before the print runs, which is what made one lane run read the tail
 * before the notice existed ([#173](https://github.com/Antruly/uvp/issues/173)).
 *
 * The observation the lane needs is the line, so wait for the line rather than
 * sampling the tail at one instant. Returns the matched output, or `undefined`
 * when the bound expired; callers report the tail either way, so a service that
 * never wrote the line still fails with its own output beside the assertion.
 *
 * The pattern is tested as given, on a tail that can still grow: a `g` or `y`
 * pattern carries `lastIndex` between polls, so it is reset before every test
 * rather than letting every other poll miss.
 */
export const waitForOutput = async (
  service: Service,
  pattern: RegExp,
  timeoutMs = 5_000,
): Promise<string | undefined> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const output = service.output();
    pattern.lastIndex = 0;
    if (pattern.test(output)) return output;
    if (Date.now() >= deadline) return undefined;
    await sleep(20);
  }
};

/** Services this lane started and has not yet seen exit. */
const started = new Set<ChildProcess>();

/**
 * How much of a service's output is kept.
 *
 * Bounded because a service is a program that may write for as long as it runs.
 * Enough to hold a startup banner and a crash message, which is what a caller
 * reads it for.
 */
const TAIL_BYTES = 8 * 1024;

/** How long a service is given to exit on `SIGTERM` before it is killed. */
const GRACE_MS = 5_000;

/**
 * Start a built service and wait until it accepts a connection.
 *
 * The kernel's answer, not an assumption: `spawn` reports a missing binary on a
 * later turn of the loop, so the launch is awaited before anything is claimed
 * about it. Readiness is a **connection**, not a response — the templates do not
 * agree on a health path (two of them have none), and conflating "listening"
 * with "answering" would let a service that accepts and never replies pass a
 * readiness check it should fail.
 *
 * The working directory is the workspace root, because one template resolves its
 * document root against the process's cwd rather than the executable's location.
 */
interface Launched {
  readonly child: ChildProcess;
  /** The newest bytes written, bounded. */
  readonly tail: () => string;
  readonly exited: Promise<{ code: number | null }>;
}

/**
 * Start the binary, with the environment the caller names on top of this process's.
 *
 * The environment is a parameter because a `tls` workspace has no other way to
 * be configured: it takes its certificate from `UVP_TLS_CERT` and `UVP_TLS_KEY`,
 * so a lane that could not set them could only ever observe the self-signed
 * fallback and would have no way to ask what happens when it is handed a real
 * certificate, or a broken one, or half of one.
 */
const launch = async (
  workspace: Workspace,
  env: Readonly<Record<string, string>>,
): Promise<Launched> => {
  const child = spawn(workspace.binary, [], {
    cwd: workspace.root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  started.add(child);

  let tail = "";
  const append = (chunk: Buffer): void => {
    const combined = tail + chunk.toString("utf8");
    tail = combined.length > TAIL_BYTES ? combined.slice(combined.length - TAIL_BYTES) : combined;
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);

  const exited = new Promise<{ code: number | null }>((resolve) => {
    child.once("exit", (code) => resolve({ code }));
  });

  // `spawn` means the kernel accepted the child; `error` means it did not, and it
  // arrives on a later turn of the loop. A binary that was never created would
  // otherwise look started for as long as it takes the readiness probe to give
  // up, and report a service that never existed.
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (cause: Error) => reject(cause));
    });
  } catch (cause) {
    throw new Error(
      `${workspace.binary} could not be started: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  return { child, tail: () => tail, exited };
};

export const startService = async (
  workspace: Workspace,
  options: { readonly env?: Readonly<Record<string, string>> } = {},
): Promise<Service> => {
  if (!(await refusesConnections(workspace.port, 1_000))) {
    // A stranger on the port would answer the lane's requests and every
    // assertion below would pass for the wrong reason.
    throw new Error(
      `port ${String(workspace.port)} already has a listener; this lane cannot attribute responses on it to the generated service`,
    );
  }

  const { child, tail, exited } = await launch(workspace, options.env ?? {});
  const ready = await waitForPort(workspace.port, 15_000);
  if (!ready) {
    child.kill("SIGKILL");
    await exited;
    throw new Error(
      `the ${workspace.template} service never accepted a connection on ${String(workspace.port)}\n${tail}`,
    );
  }

  const pid = child.pid;
  if (pid === undefined) throw new Error(`${workspace.binary} started with no pid`);

  return {
    workspace,
    pid,
    output: tail,
    stop: async () => {
      child.kill("SIGTERM");
      const polite = await Promise.race([exited, sleep(GRACE_MS).then(() => undefined)]);
      if (polite !== undefined) return { escalated: false, code: polite.code };
      // Still there after the grace period. Kept owned rather than forgotten:
      // the caller is told force was needed, and the pid is not reported as
      // stopped until the kernel agrees it is gone.
      child.kill("SIGKILL");
      const forced = await exited;
      return { escalated: true, code: forced.code };
    },
  };
};

export interface ServiceExit {
  /** `null` when a signal ended it, which is a different fact from an exit code. */
  readonly code: number | null;
  /** Everything it wrote, bounded, stdout and stderr together. */
  readonly output: string;
}

/**
 * Run a service that is supposed to end by itself, and wait for it to.
 *
 * The refusal paths are the reason this exists, and they are the reason it is
 * not `startService`: a service that refuses to start never listens, so a
 * readiness probe would wait out its whole bound and then report "never accepted
 * a connection" — which is exactly what a *successful* refusal looks like from
 * the outside. The exit code and the message are the observation, so they are
 * what is returned, and the caller asserts on both.
 *
 * A service that is still running when the deadline passes is killed and
 * reported as a failure, because that is what it is: the case under test is a
 * process that was supposed to stop, and one that is still listening after the
 * deadline has failed to stop rather than taken a long time to.
 */
export const runToExit = async (
  workspace: Workspace,
  options: {
    readonly env?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
  } = {},
): Promise<ServiceExit> => {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const { child, tail, exited } = await launch(workspace, options.env ?? {});
  const outcome = await Promise.race([exited, sleep(timeoutMs).then(() => undefined)]);
  if (outcome === undefined) {
    child.kill("SIGKILL");
    await exited;
    throw new Error(
      `${workspace.binary} was still running after ${String(timeoutMs)} ms; this lane expected it to exit\n${tail()}`,
    );
  }
  return { code: outcome.code, output: tail() };
};

/** Whether the operating system still knows this pid. No signal is delivered. */
export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Whether anything is listening on the port any more. */
export const portIsFree = async (port: number): Promise<boolean> =>
  await refusesConnections(port, 1_000);

/** End anything still running and remove the scratch tree. Safe to call twice. */
export const cleanup = (): void => {
  for (const child of started) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  started.clear();
  if (scratchRoot !== undefined) {
    rmSync(scratchRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    scratchRoot = undefined;
  }
};
