import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { UvpFailure, cancelledFailure } from "../domain/errors.js";
import {
  FRONTEND_APP_DIRECTORY,
  UVP_FRONTEND_APP_DEFINITIONS,
  selectedFrontendApps,
  type UvpFrontendApp,
} from "../domain/frontends.js";
import type { CommandOutcome, CommandRunner } from "./CommandRunner.js";
import { tailWithin } from "./evidenceHelpers.js";
import {
  manifestOf,
  manifestProblemFailure,
  manifestProblemOf,
  readWorkspaceManifest,
} from "./workspaceManifest.js";
import { workspaceIdOf } from "./workspaceIdentity.js";

/**
 * The Node frontend build, as one observed sequence of commands.
 *
 * `uvp build` never runs this. A generated workspace is a CMake project whose
 * service starts whether or not `frontend/dist` exists; this is the separate,
 * explicit step that produces the files the service serves. It is a separate
 * tool because its effects are different: it spawns Node, it may contact the
 * package registry, and it writes `node_modules` — none of which a caller
 * asking for a C++ build agreed to.
 *
 * The build never guesses. A workspace that does not record an app, a
 * `frontend/` directory without its committed lockfile, or a host without Node
 * is a named refusal before the first command, not a fallback that quietly
 * installs something else or skips the step.
 */

/** Captured step output is bounded; the tails below are the last units. */
const STEP_TAIL_UNITS = 4_096;
/** A version probe has no reason to take longer than this. */
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_MAX_OUTPUT_BYTES = 64 * 1024;

export interface FrontendBuildOptions {
  /**
   * How this host spells its executables.
   *
   * Injected with a host default, like the environment in `TemplateStore`: the
   * `.cmd` suffix is a Windows fact, and a lane that is about the build's
   * sequencing should not have to run on Windows to say what it does there.
   */
  readonly platform?: NodeJS.Platform;
}

export interface FrontendBuildInput {
  readonly path: string;
  /** Overall budget for both commands. */
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

export interface FrontendBuildStep {
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly durationMs: number;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  /** Exit 0 and not stopped by the timeout. */
  readonly succeeded: boolean;
}

export interface FrontendBuildOutcome {
  readonly workspaceId: string;
  readonly frontend: UvpFrontendApp;
  readonly frontendDir: string;
  readonly outputDir: string;
  /**
   * `frontend/dist/index.html`, the file the generated service checks for.
   *
   * Reported because "the build succeeded" is a claim about a command's exit
   * code, while "the service will serve a page" is a claim about this file.
   * They can disagree when a framework's output directory was changed.
   */
  readonly entry: string;
  /** True when the entry exists now, whether or not this run wrote it. */
  readonly built: boolean;
  /** True when every command that was started exited 0. */
  readonly stepsSucceeded: boolean;
  readonly nodeVersion: string;
  readonly npmVersion: string;
  readonly steps: readonly FrontendBuildStep[];
}

const stepOf = (
  outcome: CommandOutcome,
  request: { command: string; args: readonly string[] },
) => ({
  command: request.command,
  args: [...request.args],
  exitCode: outcome.exitCode,
  signal: outcome.signal,
  timedOut: outcome.timedOut,
  aborted: outcome.aborted,
  durationMs: outcome.durationMs,
  stdoutTail: tailWithin(outcome.stdout, STEP_TAIL_UNITS),
  stderrTail: tailWithin(outcome.stderr, STEP_TAIL_UNITS),
  stdoutBytes: outcome.stdoutBytes,
  stderrBytes: outcome.stderrBytes,
  stdoutTruncated: outcome.stdoutTruncated,
  stderrTruncated: outcome.stderrTruncated,
  succeeded: outcome.exitCode === 0 && !outcome.timedOut && !outcome.aborted,
});

const firstLine = (text: string): string => text.trim().split(/\r?\n/u)[0]?.trim() ?? "";

/** The file's content, or the refusal a caller must act on. */
const readRequired = async (path: string, remedy: string): Promise<void> => {
  try {
    await readFile(path);
  } catch (cause) {
    throw new UvpFailure({
      code: "invalid_request",
      message: `${path} could not be read: ${cause instanceof Error ? cause.message : String(cause)}.`,
      remediation: { action: remedy },
    });
  }
};

const missingNode = (command: string, cause: unknown): UvpFailure =>
  new UvpFailure({
    code: "missing_requirement",
    message:
      `The frontend build needs ${command}, and it could not be started: ` +
      `${cause instanceof Error ? cause.message : String(cause)}.`,
    remediation: {
      action:
        "Install Node.js with npm and put both on PATH, then re-run. The C++ build and the " +
        "service do not need Node; only this explicit frontend build does.",
      docs: "docs/installation.md",
    },
  });

export class FrontendBuildService {
  readonly #run: CommandRunner;
  readonly #platform: NodeJS.Platform;

  constructor(run: CommandRunner, options: FrontendBuildOptions = {}) {
    this.#run = run;
    this.#platform = options.platform ?? process.platform;
  }

  /** `npm` is a `.cmd` on Windows; a bare spawn of it cannot be executed there. */
  get #npm(): { command: string; shell: boolean } {
    return this.#platform === "win32"
      ? { command: "npm.cmd", shell: true }
      : { command: "npm", shell: false };
  }

  async build(input: FrontendBuildInput): Promise<FrontendBuildOutcome> {
    const root = resolve(input.path);
    const workspaceId = workspaceIdOf(root);

    // The same boundary check the workspace service makes. Without it, a path
    // that is not a workspace at all would be refused as a workspace that
    // "records no app", which is a different fact.
    await readFile(join(root, "CMakeLists.txt"), "utf8").catch(() => {
      throw new UvpFailure({
        code: "workspace_not_found",
        message: `${root} is not a uvp workspace: no CMakeLists.txt found.`,
        remediation: {
          action:
            "Create one with `uvp init` or uvp_workspace_create, or pass the path to an " +
            "existing uvp workspace.",
        },
      });
    });

    // The manifest owns the declaration. `frontend/` on disk without a recorded
    // app is a workspace whose author removed or truncated `uvp.json`, and
    // treating the directory as evidence would be inferring a capability claim
    // from files that the workspace does not say it has.
    const read = await readWorkspaceManifest(root);
    const problem = manifestProblemOf(read);
    if (problem !== undefined) throw manifestProblemFailure(problem);
    const manifest = manifestOf(read);
    const apps = selectedFrontendApps(manifest?.frontends ?? []);
    const frontend = apps[0];
    if (frontend === undefined) {
      throw new UvpFailure({
        code: "invalid_request",
        message: `${root} records no Node frontend app in uvp.json.`,
        remediation: {
          action:
            "Generate the workspace with `uvp init --frontend vue3`, `--frontend react`, or " +
            "`--frontend svelte`; the frontend project is written when the workspace is created.",
        },
      });
    }

    const frontendDir = join(root, FRONTEND_APP_DIRECTORY);
    await readRequired(
      join(frontendDir, "package.json"),
      "Restore frontend/package.json from version control, or regenerate the workspace.",
    );
    // `npm ci` requires a lockfile and is the only install this tool runs. Saying
    // so before spawning is what keeps "uvp fell back to npm install" from
    // becoming a plausible reading of a run that never happened.
    await readRequired(
      join(frontendDir, "package-lock.json"),
      "Restore frontend/package-lock.json from version control. uvp runs `npm ci`, which " +
        "installs exactly the lockfile and does not create one.",
    );

    const deadline = Date.now() + input.timeoutMs;
    const nodeVersion = await this.#probe("node", ["--version"], frontendDir, deadline, input);
    const npm = this.#npm;
    const npmVersion = await this.#probe(npm.command, ["--version"], frontendDir, deadline, input);

    const steps: FrontendBuildStep[] = [];
    const installArgs = ["ci", "--no-audit", "--no-fund"] as const;
    const buildArgs = ["run", "build"] as const;

    const install = await this.#step(
      { command: npm.command, args: installArgs, shell: npm.shell },
      frontendDir,
      deadline,
      input,
    );
    steps.push(install);
    if (install.succeeded) {
      steps.push(
        await this.#step(
          { command: npm.command, args: buildArgs, shell: npm.shell },
          frontendDir,
          deadline,
          input,
        ),
      );
    }

    const entry = join(root, UVP_FRONTEND_APP_DEFINITIONS[frontend].output, "index.html");
    return {
      workspaceId,
      frontend,
      frontendDir,
      outputDir: join(root, UVP_FRONTEND_APP_DEFINITIONS[frontend].output),
      entry,
      built: await entryExists(entry),
      stepsSucceeded: steps.every((step) => step.succeeded),
      nodeVersion,
      npmVersion,
      steps,
    };
  }

  /**
   * A version probe, or the missing prerequisite it establishes.
   *
   * A rejection means the executable never started. A non-zero exit or an empty
   * answer means it started and could not answer, which is the same prerequisite
   * missing for the build; neither is folded into a version.
   */
  async #probe(
    command: string,
    args: readonly string[],
    cwd: string,
    deadline: number,
    input: FrontendBuildInput,
  ): Promise<string> {
    const outcome = await this.#run({
      command,
      args: [...args],
      cwd,
      timeoutMs: Math.min(PROBE_TIMEOUT_MS, remaining(deadline)),
      maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
      signal: input.signal,
      ...(this.#platform === "win32" ? { shell: true } : {}),
    }).catch((cause: unknown) => {
      throw missingNode(command, cause);
    });
    const version = firstLine(outcome.stdout);
    if (outcome.exitCode !== 0 || version === "") {
      throw new UvpFailure({
        code: "missing_requirement",
        message:
          `\`${command} ${args.join(" ")}\` did not report a version ` +
          `(exit ${String(outcome.exitCode)}${outcome.timedOut ? ", timed out" : ""}).`,
        remediation: {
          action:
            `Repair the ${command} installation so that \`${command} ${args.join(" ")}\` ` +
            "prints a version, then re-run.",
          docs: "docs/installation.md",
        },
      });
    }
    return version;
  }

  async #step(
    request: { command: string; args: readonly string[]; shell: boolean },
    cwd: string,
    deadline: number,
    input: FrontendBuildInput,
  ): Promise<FrontendBuildStep> {
    const budget = remaining(deadline);
    if (budget <= 0) {
      throw new UvpFailure({
        code: "timeout",
        message:
          `The frontend build budget (${String(input.timeoutMs)} ms) was exhausted before ` +
          `\`${request.command} ${request.args.join(" ")}\` started.`,
        remediation: {
          action:
            "Raise timeout_ms, or run the install once by hand and re-run with a smaller step to go.",
        },
      });
    }
    const outcome = await this.#run({
      command: request.command,
      args: [...request.args],
      cwd,
      timeoutMs: budget,
      signal: input.signal,
      ...(request.shell ? { shell: true } : {}),
    }).catch((cause: unknown) => {
      throw missingNode(request.command, cause);
    });
    // The caller's withdrawal is not a finding about the workspace.
    if (outcome.aborted) throw cancelledFailure("The frontend build was cancelled.");
    return stepOf(outcome, request);
  }
}

const remaining = (deadline: number): number => deadline - Date.now();

const entryExists = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch (cause) {
    // Absent is the expected state before the first build. Any other failure is
    // a question this call could not answer, and reporting it as "not built"
    // would turn "could not look" into a finding about the workspace.
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new UvpFailure({
      code: "execution_failure",
      message: `Could not check whether ${path} exists: ${
        cause instanceof Error ? cause.message : String(cause)
      }.`,
      remediation: {
        action: "Check the workspace's filesystem permissions and re-run the frontend build.",
      },
    });
  }
};
