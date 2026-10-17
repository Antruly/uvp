import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Buffer } from "node:buffer";

import { UvpFailure, cancelledFailure } from "../domain/errors.js";
import type {
  BuildArtifact,
  BuildDiagnostic,
  BuildOutcome,
  ToolchainClient,
} from "./ToolchainProvider.js";
import { newId, sha256 } from "../domain/identity.js";
import type { SupervisedRun } from "./sessionStore.js";
import { SessionStore } from "./sessionStore.js";
import { renderTemplate, templateFeatureProblem, type TemplateId } from "./templates.js";
import type { UvpFeature } from "../domain/features.js";
import { describeStop } from "./ProcessSupervisor.js";
import type { ProcessSupervisor } from "./ProcessSupervisor.js";
import { performRequest } from "./httpClient.js";
import { readWorkspaceManifest } from "./workspaceManifest.js";

export interface CreatedFile {
  readonly path: string;
  readonly bytes: number;
  readonly digest: string;
}

export interface CreateWorkspaceResult {
  readonly workspaceId: string;
  readonly path: string;
  readonly template: string;
  readonly files: readonly CreatedFile[];
  readonly nextSteps: readonly string[];
}

export interface RunResult {
  readonly runId: string;
  readonly workspaceId: string;
  /**
   * The executable that was started, as it was invoked.
   *
   * Reported because it is what a launch claim rests on. The pid alone does not
   * survive the session — it is reused by the next process the kernel starts —
   * so evidence that named only a pid would be unreproducible a minute later,
   * and a reader could not tell which binary had been run.
   */
  readonly command: string;
  readonly args: readonly string[];
  readonly pid: number | undefined;
  readonly ready: boolean;
  readonly endpoint: string | undefined;
  readonly startupMs: number | undefined;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly stillRunning: boolean;
  /**
   * True when the process was released rather than kept under observation.
   *
   * The distinction reaches the caller because it changes what can be promised:
   * a released service is running but no longer watched, so `uvp_run_stop` can
   * signal it within this session and nothing can after the session ends.
   */
  readonly detached: boolean;
}

export interface StopResult {
  readonly stopped: readonly {
    runId: string;
    pid: number | undefined;
    exitCode: number | undefined;
    signal: string | undefined;
    killed: boolean;
    outcome: "exited" | "already_gone" | "unresponsive";
  }[];
  readonly cleanupComplete: boolean;
}

/**
 * The grace a cancelled run gives the service it had just started.
 *
 * The same three seconds `uvp stop` defaults to, and then force: the caller
 * withdrew, so a service that ignores the signal must not be the reason this call
 * stays alive.
 */
const CANCELLED_RUN_GRACE_MS = 3_000;

const workspaceIdOf = (path: string): string => {
  // Derived, not random: re-opening the same directory must yield the same id,
  // so an evidence record from an earlier call still refers to this workspace.
  const digest = sha256(resolve(path));
  return `wsp_${digest.slice(0, 22)}`;
};

/** Why a directory could not be listed, in terms a caller can act on. */
const describeListFailure = (cause: unknown): string => {
  const code = (cause as NodeJS.ErrnoException | null)?.code;
  if (code === "EACCES" || code === "EPERM") return "this process may not read it";
  if (code === "ELOOP") return "it is a symlink loop";
  if (code === "ENAMETOOLONG") return "the path is too long";
  return cause instanceof Error ? cause.message : String(cause);
};

/**
 * The entries in `path`, or a refusal when the question could not be answered.
 *
 * The guard in `create` asks this to decide whether `uvp init` may write into a
 * directory at all. Answering `[]` for a listing that failed turned "I could not
 * look" into "there is nothing here": a directory this process may write to but
 * not read (mode `0333`) was reported as empty, and the create wrote its
 * template beside a file it never saw — without the `--force` that is the
 * caller's statement that writing beside existing files is intended.
 *
 * Only `ENOENT` means there is nothing to list: that is the ordinary case of a
 * directory `init` is about to create. Every other failure is the guard's own
 * failure, and it refuses the create rather than becoming a yes.
 */
const directoryEntries = async (path: string): Promise<readonly string[]> => {
  try {
    return await readdir(path);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return [];
    if (code === "ENOTDIR") {
      // The look happened and the answer is "this is not a directory", so
      // `--force` is not a remedy: the create would fail on its first file.
      throw new UvpFailure({
        code: "invalid_request",
        message: `Refusing to write into ${path}: that path is not a directory.`,
        remediation: {
          action: "Choose a path that is a directory, or one that does not exist yet.",
        },
      });
    }
    throw new UvpFailure({
      code: "invalid_request",
      message:
        `Refusing to write into ${path}: it could not be checked for existing files ` +
        `(${describeListFailure(cause)}).`,
      remediation: {
        action:
          "Make the directory readable by this process or choose another one, or pass force=true " +
          "to write without the check.",
      },
      details: { code: code ?? "unknown" },
    });
  }
};

/**
 * Poll an endpoint until it answers, the deadline passes, or the caller stops us.
 *
 * Three outcomes rather than two, because a deadline and a withdrawal are
 * different facts about the same non-answer: the first is the machine's bound and
 * the second is the caller's decision. Returning `ready: false` for both is how
 * an interrupt became "the probe did not answer within 8000 ms" — a finding about
 * a service nobody was waiting for any more. The signal is read between attempts
 * rather than during one, so the abort lands within a single poll request; those
 * are capped at two seconds each for exactly this kind of reason.
 */
const waitForReadiness = async (
  endpoint: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<{ ready: boolean; elapsedMs: number; cancelled: boolean }> => {
  const started = Date.now();
  const deadline = started + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted === true) {
      return { ready: false, elapsedMs: Date.now() - started, cancelled: true };
    }
    try {
      const exchange = await performRequest({
        url: endpoint,
        method: "GET",
        headers: { "user-agent": "uvp/0.1 readiness" },
        body: undefined,
        httpVersion: "auto",
        followRedirects: false,
        maxRedirects: 0,
        // Unchecked, because readiness is a liveness question and not a trust
        // question. Whether the service's certificate is one this client accepts
        // is asked by the caller's own request and answered there, with
        // OpenSSL's reason. A probe that refused to call a service up because
        // its development certificate is self-signed would hide the service
        // behind a question nobody put to it.
        verifyTls: false,
        timeoutMs: Math.min(2_000, Math.max(200, deadline - Date.now())),
      });
      // Any HTTP status means the service is accepting and answering. A 404 on
      // the readiness path is still readiness; only a transport failure is not.
      if (exchange.status > 0)
        return { ready: true, elapsedMs: Date.now() - started, cancelled: false };
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { ready: false, elapsedMs: Date.now() - started, cancelled: false };
};

/**
 * Workspace lifecycle: create, build, run, stop.
 *
 * The service owns no policy about what "success" means beyond the mechanical
 * facts (exit code, readiness probe result). Interpretation belongs to the
 * caller, because the same build that fails for one goal is fine for another.
 */
export class WorkspaceService {
  constructor(
    private readonly store: SessionStore,
    private readonly client: ToolchainClient,
    /**
     * Required, with no default, and that is deliberate.
     *
     * This class starts a service and can stop it, which only the host's process
     * table can do. Reaching into `toolchains/local` for it made "run this
     * service" a workflow that only ever meant "on this machine". Through the
     * port it means whatever supervisor the composition root wired.
     *
     * A default would have read as convenience and behaved as a trap: a wiring
     * mistake would compile, and surface later as a service that cannot start
     * while the code that forgot the argument looks correct. `now` can default,
     * because a clock's default is the real clock; there is no such thing for a
     * supervisor.
     */
    private readonly supervisor: ProcessSupervisor,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(input: {
    path: string;
    name: string;
    template: TemplateId;
    features: readonly UvpFeature[];
    port: number;
    force: boolean;
  }): Promise<CreateWorkspaceResult> {
    const root = resolve(input.path);

    if (!input.force) {
      const entries = await directoryEntries(root);
      const meaningful = entries.filter((entry) => entry !== "." && entry !== "..");
      if (meaningful.length > 0) {
        throw new UvpFailure({
          code: "invalid_request",
          message: `Refusing to write into ${root}: it already contains ${String(meaningful.length)} entries.`,
          remediation: {
            action:
              "Choose an empty directory, or pass force=true to write alongside the existing files.",
          },
          details: { entries: meaningful.slice(0, 20) },
        });
      }
    }

    const featureProblem = templateFeatureProblem(input.template, input.features);
    if (featureProblem !== undefined) {
      // `missing_requirement` rather than `invalid_request`, which is what this
      // was first written as. Both are `invalid_input` and both exit 2, so the
      // category does not decide it; the code does, because a caller switches on
      // the code. This request is well formed and the template exists — what is
      // missing is a feature, and that is the same shape as a workspace asking
      // for a module the installed libuvcpp was not built with.
      throw new UvpFailure({
        code: "missing_requirement",
        message: `The ${input.template} template cannot be generated with the requested features: ${featureProblem}.`,
        remediation: {
          action:
            "Re-run with a feature list this template can honour. `uvp doctor --features` reports " +
            "which of them the installed libuvcpp provides.",
        },
        details: { template: input.template, features: [...input.features] },
      });
    }

    const files = renderTemplate(input.template, {
      name: input.name,
      port: input.port,
      features: input.features,
    });

    const created: CreatedFile[] = [];
    for (const file of files) {
      const target = join(root, file.path);
      await mkdir(dirname(target), { recursive: true });
      const bytes = Buffer.from(file.content, "utf8");
      await writeFile(target, bytes);
      created.push({ path: target, bytes: bytes.byteLength, digest: sha256(bytes) });
    }

    return {
      workspaceId: workspaceIdOf(root),
      path: root,
      template: input.template,
      files: created,
      nextSteps: [
        `cmake -S ${root} -B ${join(root, "build")} -DCMAKE_BUILD_TYPE=Debug`,
        `cmake --build ${join(root, "build")}`,
        `${join(root, "build", input.name)}`,
      ],
    };
  }

  async build(input: {
    path: string;
    buildDir?: string | undefined;
    buildType: "Debug" | "RelWithDebInfo" | "Release";
    generator?: "ninja" | "unix-makefiles" | "msbuild" | undefined;
    target?: string | undefined;
    clean: boolean;
    jobs?: number | undefined;
    timeoutMs: number;
    configureOnly: boolean;
    /** The libuvcpp install to build against, when the caller discovered one. */
    libuvcppPrefix?: string | undefined;
    signal: AbortSignal;
  }): Promise<{ workspaceId: string; outcome: BuildOutcome }> {
    const root = resolve(input.path);
    await this.#requireWorkspace(root);
    const buildDir = resolve(input.buildDir ?? join(root, "build"));

    const outcome = await this.client.build({
      workspacePath: root,
      buildDir,
      buildType: input.buildType,
      ...(input.generator === undefined ? {} : { generator: input.generator }),
      ...(input.target === undefined ? {} : { target: input.target }),
      clean: input.clean,
      ...(input.jobs === undefined ? {} : { jobs: input.jobs }),
      timeoutMs: input.timeoutMs,
      configureOnly: input.configureOnly,
      ...(input.libuvcppPrefix === undefined ? {} : { libuvcppPrefix: input.libuvcppPrefix }),
      signal: input.signal,
    });

    return { workspaceId: workspaceIdOf(root), outcome };
  }

  async run(input: {
    path: string;
    buildDir?: string | undefined;
    binary?: string | undefined;
    args: readonly string[];
    env: Readonly<Record<string, string>>;
    ready?: { port: number; path: string; timeoutMs: number } | undefined;
    detach: boolean;
    signal?: AbortSignal | undefined;
  }): Promise<RunResult> {
    const root = resolve(input.path);
    const manifest = await readWorkspaceManifest(root);
    const buildDir = resolve(input.buildDir ?? join(root, "build"));
    const binaryName = input.binary ?? manifest?.binary ?? manifest?.name ?? "app";
    const binaryPath = join(buildDir, binaryName);

    // Nothing is started for a call that was already cancelled. The same rule the
    // provider port states for a build, and for the same reason: a run that
    // starts its service anyway has done something the caller had just decided
    // not to wait for, and every field of its result — the pid, the readiness
    // answer — would then be a claim about a process this call created by
    // ignoring them.
    if (input.signal?.aborted === true) {
      throw cancelledFailure(
        `The run was cancelled before ${binaryPath} was started, so nothing was launched and nothing ` +
          `was observed about the workspace.`,
      );
    }

    // The scheme comes from the workspace's own declaration rather than from a
    // constant here. It was `http://` in this string, which is the same defect as
    // a wrong port written in a comment: a workspace generated with the tls
    // module serves HTTPS, and the endpoint this reports is what a caller hands
    // to `uvp http` next.
    const endpoint =
      input.ready === undefined
        ? undefined
        : `${manifest?.scheme ?? "http"}://127.0.0.1:${String(input.ready.port)}${input.ready.path}`;

    const process_ = this.supervisor({
      command: binaryPath,
      args: input.args,
      cwd: root,
      env: input.env,
    });

    // The kernel's answer, not an assumption. A binary that is missing or not
    // executable never becomes a process, and every field below — the pid, the
    // readiness probe, `still_running` — is a claim about a process. Waiting for
    // the spawn outcome is what keeps a workspace that was never built from being
    // reported as a service that is up.
    try {
      await process_.whenStarted();
    } catch (cause) {
      throw new UvpFailure({
        code: "launch_failed",
        message: `${binaryPath} could not be started: ${cause instanceof Error ? cause.message : String(cause)}`,
        remediation: {
          action: `Build it first (\`uvp build ${root}\`), or pass --binary with a path that exists and is executable.`,
        },
        details: { command: binaryPath, cwd: root },
      });
    }

    let ready = false;
    let startupMs: number | undefined;
    if (endpoint !== undefined && input.ready !== undefined) {
      const probe = await waitForReadiness(endpoint, input.ready.timeoutMs, input.signal);
      if (probe.cancelled) {
        // The service is running and nothing else knows about it yet: it reaches
        // the run registry only once this call has a result to return, so a
        // cancellation here has exactly one owner, and it is this frame. Two
        // alternatives are worse. Reporting `ready: false` would answer a
        // withdrawal with a bound the caller never waited for, and returning the
        // run as stoppable would leave a listener on a port nobody is waiting on.
        const stopped = await process_.stop(CANCELLED_RUN_GRACE_MS, true);
        throw cancelledFailure(
          `The run was cancelled while waiting for ${endpoint} to answer, so nothing was observed ` +
            `about the service. The process this call started (pid ${String(process_.pid)}): ` +
            `${describeStop(stopped)}.`,
        );
      }
      ready = probe.ready;
      startupMs = probe.elapsedMs;
    }

    const runId = newId("run");
    // Registered whenever the service is still running — `detach` says whether
    // this call lets go of the pipes, not whether the process stops being uvp's
    // to stop. Registering only the detached ones made the result's own advice
    // false: a `--no-detach` run was reported as stoppable with `uvp_run_stop`
    // and was in no registry, so a foreground service could be left listening
    // with nothing but a pid to kill it by.
    if (process_.isRunning()) {
      const record: SupervisedRun = {
        runId,
        workspaceId: workspaceIdOf(root),
        workspacePath: root,
        endpoint,
        startedAt: this.now().toISOString(),
        process: process_,
      };
      this.store.addRun(record);
    }

    // Snapshot before releasing: `release()` detaches the pipes, so a tail read
    // afterwards would return whatever happened to be buffered and never grow —
    // a startup error printed a millisecond later would vanish from the report.
    const stdoutTail = process_.stdoutTail().slice(-4_096);
    const stderrTail = process_.stderrTail().slice(-4_096);
    const stillRunning = process_.isRunning();
    const detached = input.detach && stillRunning;
    if (detached) process_.release();

    return {
      runId,
      workspaceId: workspaceIdOf(root),
      command: binaryPath,
      args: [...input.args],
      pid: process_.pid,
      ready,
      endpoint,
      startupMs,
      stdoutTail,
      stderrTail,
      stillRunning,
      detached,
    };
  }

  async stop(input: {
    runId?: string | undefined;
    all: boolean;
    graceMs: number;
    force: boolean;
  }): Promise<StopResult> {
    const targets =
      input.all || input.runId === undefined
        ? this.store.runs()
        : this.store.runs().filter((run) => run.runId === input.runId);

    if (targets.length === 0) {
      return { stopped: [], cleanupComplete: true };
    }

    const stopped: StopResult["stopped"][number][] = [];
    let cleanupComplete = true;
    for (const run of targets) {
      const outcome = await run.process.stop(input.graceMs, input.force);
      if (outcome.outcome !== "exited" && outcome.outcome !== "already_gone")
        cleanupComplete = false;
      stopped.push({
        runId: run.runId,
        pid: run.process.pid,
        exitCode: outcome.code,
        signal: outcome.signal,
        killed: outcome.killed,
        outcome: outcome.outcome,
      });
      if (outcome.outcome !== "unresponsive") this.store.forgetRun(run.runId);
    }
    return { stopped, cleanupComplete };
  }

  artifactsOf(outcome: BuildOutcome): readonly BuildArtifact[] {
    return outcome.artifacts;
  }

  diagnosticsOf(outcome: BuildOutcome): readonly BuildDiagnostic[] {
    return outcome.diagnostics;
  }

  async #requireWorkspace(root: string): Promise<void> {
    try {
      await readFile(join(root, "CMakeLists.txt"), "utf8");
    } catch {
      throw new UvpFailure({
        code: "workspace_not_found",
        message: `${root} is not a uvp workspace: no CMakeLists.txt found.`,
        remediation: {
          action:
            "Create one with uvp_workspace_create, or pass the path to an existing CMake project.",
        },
      });
    }
  }
}
