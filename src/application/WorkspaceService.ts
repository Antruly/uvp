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
import {
  renderTemplate,
  templateFeatureProblem,
  templateRoutes,
  type TemplateId,
} from "./templates.js";
import {
  UVP_EVENT_PAYLOAD_POLICIES,
  isUvpEventPayloadPolicy,
} from "../domain/eventPayloadPolicy.js";
import type { UvpFeature } from "../domain/features.js";
import {
  UVP_FRONTEND_SELECTIONS,
  duplicateFrontendSelections,
  frontendSelectionNames,
  resolveFrontendSelection,
  selectedFrontendApps,
  unknownFrontendSelections,
  type UvpFrontendSelection,
} from "../domain/frontends.js";
import {
  UVP_MODULES,
  defaultModules,
  duplicateModules,
  isUvpModule,
  moduleDependencyProblem,
  moduleFeatureProblem,
  moduleRouteConflictProblem,
  resolveModules,
  unknownModules,
  type UvpModule,
} from "../domain/modules.js";
import { renderTemplatePackageWorkspace } from "./TemplatePackageRender.js";
import type { StoredTemplatePackageSource } from "./TemplateStore.js";
import { describeStop } from "./ProcessSupervisor.js";
import { tailWithin } from "./evidenceHelpers.js";
import type { ProcessSupervisor } from "./ProcessSupervisor.js";
import { performRequest } from "./httpClient.js";
import { manifestOf, manifestProblemFailure, readWorkspaceManifest } from "./workspaceManifest.js";
import { workspaceIdOf } from "./workspaceIdentity.js";

export interface CreatedFile {
  readonly path: string;
  readonly bytes: number;
  readonly digest: string;
}

export interface CreateWorkspaceResult {
  readonly workspaceId: string;
  readonly path: string;
  /** The built-in template, for a workspace generated from one. */
  readonly template?: string;
  /**
   * The stored package this workspace was rendered from, for a package
   * workspace. Exactly one of `template` and `templatePackage` is present.
   */
  readonly templatePackage?: {
    readonly id: string;
    readonly version: string;
    readonly digest: string;
  };
  /** Limitations the caller must report beside the result, if any. */
  readonly limitations?: readonly string[];
  /**
   * The application modules the workspace was born with, in canonical order.
   *
   * Reported because it is what the generated source and `uvp.json` agree on,
   * and because a caller that passed a subset should be able to see the set the
   * template's default expanded to.
   */
  readonly modules: readonly UvpModule[];
  /**
   * The static skins the workspace was born with, in canonical order.
   *
   * Reported because each one is a directory a caller reaches at `/<skin>/`;
   * the list is the same one recorded in `uvp.json`.
   */
  readonly frontends: readonly UvpFrontendSelection[];
  readonly files: readonly CreatedFile[];
  readonly routes: readonly string[];
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

/**
 * How much of each output stream a run result carries.
 *
 * The supervisor keeps a larger tail for its own use; this is the part a caller
 * reads, and it is cut by `tailWithin` rather than `slice` so the cut cannot leave
 * half a character in the evidence.
 */
const REPORT_TAIL_UNITS = 4_096;

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
 * Write generated files, accepting both text and bytes.
 *
 * The built-in templates render strings; a template package may carry a binary
 * asset, whose bytes must reach the workspace unchanged. One writer keeps the
 * digest in `CreatedFile` computed from the same bytes that were written.
 */
const writeGeneratedFiles = async (
  root: string,
  files: readonly { readonly path: string; readonly content: string | Uint8Array }[],
): Promise<CreatedFile[]> => {
  const created: CreatedFile[] = [];
  for (const file of files) {
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    const bytes =
      typeof file.content === "string"
        ? Buffer.from(file.content, "utf8")
        : Buffer.from(file.content);
    await writeFile(target, bytes);
    created.push({ path: target, bytes: bytes.byteLength, digest: sha256(bytes) });
  }
  return created;
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
    /**
     * The built-in template, for the generated-workspace path.
     *
     * Optional so a caller can name a package instead; absent with no
     * `templatePackage` means `hello-http`, the default the contract used to
     * apply. The contract cannot apply that default any more, because it has to
     * tell "omitted" from "explicitly hello-http" to refuse the two selectors
     * together.
     */
    template?: TemplateId | undefined;
    /**
     * A stored package to render, already read and verified against its
     * manifest. The composition edge owns the store read and its error
     * projection; this service owns the rendering and the writes.
     */
    templatePackage?: StoredTemplatePackageSource | undefined;
    /**
     * Transport features. Absent means the default (`websocket`) for a built-in
     * template, and is refused for a package: the package's `requires.features`
     * are the authority on what its source was written for.
     */
    features?: readonly UvpFeature[] | undefined;
    port: number;
    force: boolean;
    /**
     * The application modules to compose; absent means the template's default.
     *
     * Typed as strings rather than `UvpModule` on purpose: this method is the
     * boundary that refuses an unknown name, and a narrower type would move that
     * refusal to a cast somewhere upstream instead of a named error here.
     */
    modules?: readonly string[] | undefined;
    /**
     * What the evidence log keeps of a message payload.
     *
     * A string for the same reason `modules` is: this is where an unknown value
     * is refused with a named error, not left to a cast upstream.
     */
    eventPayloads?: string | undefined;
    /**
     * The static skins to generate; absent means no skin.
     *
     * Strings rather than `UvpFrontend` for the same reason `modules` is: this
     * method is the boundary that refuses an unknown name with a named error.
     */
    frontends?: readonly string[] | undefined;
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

    if (input.template !== undefined && input.templatePackage !== undefined) {
      throw new UvpFailure({
        code: "invalid_request",
        message:
          "A workspace is generated from one selector: a built-in template or a stored package, not both.",
        remediation: {
          action: "Pass one of --template and --template-package, not both.",
        },
        details: { template: input.template, template_package: input.templatePackage.package.id },
      });
    }

    if (input.templatePackage !== undefined) {
      // `features`, modules, skins, and the payload policy are all fragments of
      // the built-in generators. This workspace's source is the package's, so
      // accepting one would either change nothing or compose code the package
      // never declared; refusing names the option instead of silently ignoring
      // it.
      const builtInOnly = [
        input.features === undefined ? undefined : "features",
        input.modules === undefined ? undefined : "modules",
        input.eventPayloads === undefined ? undefined : "event_payloads",
        input.frontends === undefined ? undefined : "frontends",
      ].filter((name): name is string => name !== undefined);
      if (builtInOnly.length > 0) {
        throw new UvpFailure({
          code: "invalid_request",
          message:
            `A package workspace's source comes from the package, so ${builtInOnly.join(", ")} ` +
            "would compose code the package does not declare.",
          remediation: {
            action:
              "Drop the built-in-composition option, or use --template for a built-in template.",
          },
          details: {
            template_package: input.templatePackage.package.id,
            refused: builtInOnly,
          },
        });
      }
      const rendered = renderTemplatePackageWorkspace({
        source: input.templatePackage,
        name: input.name,
        port: input.port,
      });
      const createdFiles = await writeGeneratedFiles(root, rendered.files);
      return {
        workspaceId: workspaceIdOf(root),
        path: root,
        templatePackage: {
          id: input.templatePackage.package.id,
          version: input.templatePackage.package.version,
          digest: input.templatePackage.package.digest,
        },
        modules: [],
        frontends: [],
        files: createdFiles,
        routes: [...rendered.routes],
        nextSteps: [
          `cmake -S ${root} -B ${join(root, "build")} -DCMAKE_BUILD_TYPE=Debug`,
          `cmake --build ${join(root, "build")}`,
          join(root, "build", rendered.binary),
        ],
        ...(rendered.routesLimitation === undefined
          ? {}
          : { limitations: [rendered.routesLimitation] }),
      };
    }

    const template = input.template ?? "hello-http";
    const features = input.features ?? ["websocket"];

    const featureProblem = templateFeatureProblem(template, features);
    if (featureProblem !== undefined) {
      // `missing_requirement` rather than `invalid_request`, which is what this
      // was first written as. Both are `invalid_input` and both exit 2, so the
      // category does not decide it; the code does, because a caller switches on
      // the code. This request is well formed and the template exists — what is
      // missing is a feature, and that is the same shape as a workspace asking
      // for a module the installed libuvcpp was not built with.
      throw new UvpFailure({
        code: "missing_requirement",
        message: `The ${template} template cannot be generated with the requested features: ${featureProblem}.`,
        remediation: {
          action:
            "Re-run with a feature list this template can honour. `uvp doctor --features` reports " +
            "which of them the installed libuvcpp provides.",
        },
        details: { template: template, features: [...features] },
      });
    }

    // Every module refusal happens here, before the first file is written. A
    // workspace that exists with a manifest naming a module whose code is not in
    // it would be a claim the source does not support, and a half-written one is
    // worse than a refusal because the caller has to clean it up.
    const requested = input.modules ?? defaultModules(template);
    const unknown = unknownModules(requested);
    if (unknown.length > 0) {
      throw new UvpFailure({
        code: "invalid_request",
        message:
          `Unknown application module${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. ` +
          `Known modules: ${UVP_MODULES.join(", ")}.`,
        remediation: {
          action: "Re-run with module names from the list above; a module is a closed vocabulary.",
        },
        details: { unknown: [...unknown], known: [...UVP_MODULES] },
      });
    }
    const duplicated = duplicateModules(requested);
    if (duplicated.length > 0) {
      throw new UvpFailure({
        code: "invalid_request",
        message:
          `The module list names ${duplicated.join(", ")} more than once. ` +
          "A module is either selected or it is not.",
        remediation: { action: "Remove the repeated name from the module list." },
        details: { duplicated: [...duplicated] },
      });
    }
    const modules = resolveModules(requested.filter(isUvpModule));
    if (template === "http3-service" && modules.length > 0) {
      // Not a route conflict but a layering one: this template's routes are
      // registered on `uvcpp_http_server`, and every module is written against
      // `uvcpp_web_app`. Composing them would generate a file that does not
      // compile, so it is refused rather than attempted.
      throw new UvpFailure({
        code: "invalid_request",
        message:
          `The http3-service template cannot compose application modules (${modules.join(", ")}): ` +
          "its routes are registered on uvcpp_http_server, and the modules are written against " +
          "uvcpp_web_app.",
        remediation: {
          action:
            "Choose a web-app template for module composition, or generate http3-service without --modules.",
        },
        details: { template: template, modules: [...modules] },
      });
    }
    const moduleFeatureRefusal = moduleFeatureProblem(modules, features);
    if (moduleFeatureRefusal !== undefined) {
      throw new UvpFailure({
        code: "missing_requirement",
        message: `The requested modules cannot be composed with the requested features: ${moduleFeatureRefusal}.`,
        remediation: {
          action:
            "Re-run with the feature the module is written against; `uvp doctor --features` reports " +
            "which of them the installed libuvcpp provides.",
        },
        details: { modules: [...modules], features: [...features] },
      });
    }
    const dependencyRefusal = moduleDependencyProblem(modules);
    if (dependencyRefusal !== undefined) {
      throw new UvpFailure({
        code: "missing_requirement",
        message: `The requested modules do not compose: ${dependencyRefusal}.`,
        remediation: { action: "Select the modules the refusal names alongside this one." },
        details: { modules: [...modules] },
      });
    }
    // Against the template's own routes, not the composed list: the question is
    // whether the template already serves what the module would register.
    const conflict = moduleRouteConflictProblem(
      modules,
      template,
      templateRoutes(template, features, []),
    );
    if (conflict !== undefined) {
      throw new UvpFailure({
        code: "invalid_request",
        message: `The requested modules conflict with the template: ${conflict}.`,
        remediation: {
          action:
            "Drop the conflicting module, or choose a template that does not already serve that route.",
        },
        details: { template: template, modules: [...modules] },
      });
    }

    // The payload policy is a fact about the evidence log, so asking for it
    // without that module would either be ignored (a request the workspace does
    // not carry) or silently add the module (a selection the caller did not
    // make). It is refused instead, with the flag that would make it meaningful.
    if (input.eventPayloads !== undefined) {
      if (!isUvpEventPayloadPolicy(input.eventPayloads)) {
        throw new UvpFailure({
          code: "invalid_request",
          message:
            `Unknown event payload policy: ${input.eventPayloads}. ` +
            `Known policies: ${UVP_EVENT_PAYLOAD_POLICIES.join(", ")}.`,
          remediation: {
            action: `Pass --event-payloads ${UVP_EVENT_PAYLOAD_POLICIES.join(" or ")}.`,
          },
          details: { event_payloads: input.eventPayloads, known: [...UVP_EVENT_PAYLOAD_POLICIES] },
        });
      }
      if (!modules.includes("evidence-log")) {
        throw new UvpFailure({
          code: "invalid_request",
          message:
            `The event payload policy applies to the evidence-log module, which this request does ` +
            `not select: --event-payloads ${input.eventPayloads} would change nothing.`,
          remediation: {
            action: "Add evidence-log to --modules, or drop the event payload option.",
          },
          details: { modules: [...modules], event_payloads: input.eventPayloads },
        });
      }
    }

    // A skin is a closed vocabulary too, and the refusals are before the first
    // write for the same reason the module refusals are: a workspace that
    // exists with a directory missing what its manifest names is a half-written
    // claim, not a result the caller can use.
    const requestedFrontends = input.frontends ?? [];
    const unknownFrontendsFound = unknownFrontendSelections(requestedFrontends);
    if (unknownFrontendsFound.length > 0) {
      throw new UvpFailure({
        code: "invalid_request",
        message:
          `Unknown frontend${unknownFrontendsFound.length === 1 ? "" : "s"}: ` +
          `${unknownFrontendsFound.join(", ")}. Known frontends: ${UVP_FRONTEND_SELECTIONS.join(", ")}.`,
        remediation: {
          action: "Re-run with a name from the list above; the set is a closed vocabulary.",
        },
        details: { unknown: [...unknownFrontendsFound], known: [...UVP_FRONTEND_SELECTIONS] },
      });
    }
    const duplicatedFrontends = duplicateFrontendSelections(requestedFrontends);
    if (duplicatedFrontends.length > 0) {
      throw new UvpFailure({
        code: "invalid_request",
        message:
          `The frontend list names ${duplicatedFrontends.join(", ")} more than once. ` +
          "A frontend is either selected or it is not.",
        remediation: { action: "Remove the repeated name from the frontend list." },
        details: { duplicated: [...duplicatedFrontends] },
      });
    }
    const frontendApps = selectedFrontendApps(requestedFrontends);
    if (frontendApps.length > 1) {
      throw new UvpFailure({
        code: "invalid_request",
        message:
          `One workspace can select one frontend app, and this request names ${frontendApps.join(", ")}. ` +
          "Each app is a separate frontend/ project with its own build.",
        remediation: { action: "Keep one of the named apps and generate the others separately." },
        details: { apps: [...frontendApps] },
      });
    }
    // Every name passed the vocabulary check above, which throws on the first
    // unknown one; the cast records that, it does not assume it.
    const selection = resolveFrontendSelection(
      requestedFrontends as readonly UvpFrontendSelection[],
    );
    if (selection.app !== undefined && selection.pages.length > 0) {
      throw new UvpFailure({
        code: "invalid_request",
        message:
          `A frontend app and a static page set both own the document root: ` +
          `${selection.app} with ${selection.pages.join(", ")}. The app is served from ` +
          "frontend/dist and the page sets from public/, and both are mounted at /.",
        remediation: { action: "Select the app, or the static page sets, but not both." },
        details: { app: selection.app, pages: [...selection.pages] },
      });
    }
    // A selected app registers the document root itself, so a template (or a
    // module) that already registers one would produce a source with two
    // registrations fighting over `/`. Refused here rather than rendered with
    // one of them silently dropped.
    const ownsDocumentRoot =
      template === "static-files" ||
      template === "websocket-test" ||
      modules.includes("static-console");
    if (selection.app !== undefined && ownsDocumentRoot) {
      throw new UvpFailure({
        code: "invalid_request",
        message:
          `The ${template} template already serves a page at / ` +
          `(${template === "static-files" ? "its public/ document root" : "its test console"}), ` +
          `so the ${selection.app} frontend cannot own that document root too.`,
        remediation: {
          action: "Choose a backend template for a frontend app, or drop the app selection.",
        },
        details: { template: template, app: selection.app },
      });
    }
    if (template === "http3-service" && (selection.pages.length > 0 || selection.app)) {
      // Not a preference: this template's routes are registered on a plain
      // `uvcpp_http_server`, and the generated code never gives that server a
      // document root. Accepting the selection would write a frontend nothing serves.
      throw new UvpFailure({
        code: "invalid_request",
        message: `The http3-service template cannot serve a frontend (${frontendSelectionNames(
          selection,
        ).join(", ")}): its generated source registers no static document root.`,
        remediation: {
          action:
            "Choose a web-app template for a frontend, or generate http3-service without --frontend/--frontends.",
        },
        details: {
          template: template,
          frontends: frontendSelectionNames(selection),
        },
      });
    }
    const frontends = frontendSelectionNames(selection);

    const files = renderTemplate(template, {
      name: input.name,
      port: input.port,
      features: features,
      modules,
      frontends,
      ...(input.eventPayloads === undefined ? {} : { eventPayloads: input.eventPayloads }),
    });

    const created = await writeGeneratedFiles(root, files);

    return {
      workspaceId: workspaceIdOf(root),
      path: root,
      template: template,
      modules,
      frontends,
      files: created,
      routes: templateRoutes(template, features, modules, frontends),
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
    const manifestRead = await readWorkspaceManifest(root);
    // The binary name is the one field a run takes from the manifest, so a file
    // that could not be read is a name uvp would have to invent — and "app" for
    // a workspace whose file says `svc` gives "no such binary" instead of the
    // real reason. A directory with no manifest at all still runs on the
    // default; that is a workspace that declares nothing.
    if (manifestRead.state === "unreadable") throw manifestProblemFailure(manifestRead.problem);
    const manifest = manifestOf(manifestRead);
    const buildDir = resolve(input.buildDir ?? join(root, "build"));
    const binaryName = input.binary ?? manifest?.binary ?? manifest?.name ?? "app";
    // `resolve`, not `join`: a caller-supplied `binary` is a path (the CLI names
    // it `--binary PATH`), and `join` does not reset on an absolute segment, so
    // `/opt/svc/bin/svc` became `<buildDir>/opt/svc/bin/svc` — a path the caller
    // never named, reported as a launch failure for a binary that exists. A
    // manifest's `binary` and `name` are names and still resolve under the build
    // directory.
    const binaryPath = resolve(buildDir, binaryName);

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
    const stdoutTail = tailWithin(process_.stdoutTail(), REPORT_TAIL_UNITS);
    const stderrTail = tailWithin(process_.stderrTail(), REPORT_TAIL_UNITS);
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
    // "Did not say which" is not "said every one". The contract defaults `all` to
    // false and leaves `run_id` optional, so an MCP caller can send `{}`; reading
    // the absent id as the whole set would kill every service the session started
    // under an input that explicitly declined to ask for it. Refusing is the
    // third state the CLI already reports for the same call (it names --run-id
    // or --all), raised here so a caller of this service cannot reach the
    // destructive branch by omission either.
    if (!input.all && input.runId === undefined) {
      throw new UvpFailure({
        code: "invalid_request",
        message:
          "A stop call must name the run to stop or ask for every run; stopping everything is " +
          "never the default.",
        remediation: {
          action: "Pass the run's id, or set all to true to stop every run this session started.",
        },
        details: { all: false, run_id: null },
      });
    }

    const targets = input.all
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
