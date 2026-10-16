import { SessionStore } from "../application/sessionStore.js";
import { WorkspaceService } from "../application/WorkspaceService.js";
import { WebService } from "../application/WebService.js";
import { CaptureService } from "../application/CaptureService.js";
import { DoctorService } from "../application/DoctorService.js";
import { LocalToolchainProvider } from "../toolchains/local/LocalToolchainProvider.js";
import { ContainerToolchainProvider } from "../toolchains/container/ContainerToolchainProvider.js";
import { startSupervised } from "../toolchains/processRunner.js";
import type { ToolchainSelection } from "../domain/toolchain.js";
import { NativeProbeRunner } from "../toolchains/native/NativeProbeRunner.js";
import { NativeHttp3ProbeRunner } from "../toolchains/native/NativeHttp3ProbeRunner.js";
import type { NativeWebSocketProbe } from "../application/NativeWebSocketProbe.js";
import type { NativeHttp3Probe } from "../application/NativeHttp3Probe.js";
import type { ToolchainProvider } from "../application/ToolchainProvider.js";

/**
 * The object graph, assembled once.
 *
 * Everything above this file takes its collaborators as constructor arguments;
 * nothing above it constructs one. That is what makes the service layer
 * testable without a process, a socket, or a compiler, and it is the reason
 * `LocalToolchainProvider` is the only concrete provider named anywhere — a
 * second provider is a change to this file and to nothing else.
 *
 * The clock is injected here and threaded through. A service that read
 * `new Date()` for itself would be untestable at exactly the points that matter:
 * ordering evidence, expiring exchanges, and measuring a duration.
 */

export interface UvpServiceOptions {
  readonly now?: (() => Date) | undefined;
  /** Providers by id; the first is the default. Defaults to the local toolchain. */
  readonly providers?: readonly ToolchainProvider[] | undefined;
  /**
   * How a container toolchain is built, given the image a workspace named.
   *
   * Injected for the reason every collaborator here is: the lane that is about
   * *which* toolchain a call selects is not about podman, and a lane that had to
   * have a container runtime to ask that question would skip on this host rather
   * than answer it. The lane that *is* about the real provider names this
   * explicitly, so its coverage is a statement rather than an inference.
   */
  readonly containerToolchain?: ((image: string) => ToolchainProvider) | undefined;
  /**
   * The libuvcpp stack's WebSocket probe. Defaults to the supervised process.
   *
   * Injected for the same reason the providers are: a lane that is about what uvp
   * does with a probe's report should not need a C++ toolchain to say it, and the
   * lane that *is* about the real probe names this explicitly so its coverage is
   * a statement rather than an inference.
   */
  readonly nativeProbe?: NativeWebSocketProbe | undefined;
  /**
   * The same binary's HTTP/3 exchange, as a separate collaborator.
   *
   * Separate rather than one object with two methods, because the two are not
   * interchangeable even though one process answers both: they disagree about what
   * a usable build is (an older probe speaks WebSocket and not h3), and a lane that
   * wants to script one exchange's report should not have to satisfy the other's.
   */
  readonly nativeHttp3Probe?: NativeHttp3Probe | undefined;
}

export interface UvpServices {
  readonly now: () => Date;
  readonly store: SessionStore;
  readonly providers: readonly ToolchainProvider[];
  /** The provider whose identity stamps results and whose client builds. */
  readonly primary: ToolchainProvider;
  /**
   * The provider a selection names.
   *
   * `local` answers with `primary` rather than with a freshly constructed
   * `LocalToolchainProvider`, which is what keeps a lane that hands this graph a
   * fake toolchain able to stand in for the host. A container image gets a
   * provider of its own, constructed once per image and kept: a provider holds
   * the runtime it resolved, and re-resolving it per call would be a second
   * answer to a question the first one already answered.
   */
  readonly toolchainFor: (selection: ToolchainSelection) => ToolchainProvider;
  /**
   * A build service bound to one provider.
   *
   * A service per provider rather than one service that takes a provider per
   * call, because the port's rule is that a client is bound to its toolchain for
   * its lifetime — `identity()` is stamped onto every result the service
   * produces, and a client that could change hands mid-session would make that
   * stamp a claim about the last call rather than about the build.
   */
  readonly workspaceFor: (provider: ToolchainProvider) => WorkspaceService;
  readonly workspace: WorkspaceService;
  readonly web: WebService;
  readonly capture: CaptureService;
  readonly doctor: DoctorService;
}

export const createUvpServices = (options: UvpServiceOptions = {}): UvpServices => {
  const now = options.now ?? ((): Date => new Date());
  const providers = options.providers ?? [new LocalToolchainProvider()];
  const primary = providers[0];
  if (primary === undefined) {
    throw new Error("uvp needs at least one toolchain provider; got an empty list.");
  }

  const store = new SessionStore(now);

  const buildContainer =
    options.containerToolchain ??
    ((image: string): ToolchainProvider => new ContainerToolchainProvider({ image }));
  const containers = new Map<string, ToolchainProvider>();
  const toolchainFor = (selection: ToolchainSelection): ToolchainProvider => {
    if (selection.kind === "local") return primary;
    const existing = containers.get(selection.image);
    if (existing !== undefined) return existing;
    const created = buildContainer(selection.image);
    containers.set(selection.image, created);
    return created;
  };

  const workspaces = new Map<ToolchainProvider, WorkspaceService>();
  const workspaceFor = (provider: ToolchainProvider): WorkspaceService => {
    const existing = workspaces.get(provider);
    if (existing !== undefined) return existing;
    const created = new WorkspaceService(store, provider.createClient(), startSupervised, now);
    workspaces.set(provider, created);
    return created;
  };

  return {
    now,
    store,
    providers,
    primary,
    toolchainFor,
    workspaceFor,
    workspace: workspaceFor(primary),
    web: new WebService({
      store,
      now,
      nativeProbe: options.nativeProbe ?? new NativeProbeRunner(),
      nativeHttp3Probe: options.nativeHttp3Probe ?? new NativeHttp3ProbeRunner(),
    }),
    capture: new CaptureService(store, now),
    // No `headerProbe` is passed. The doctor builds one rooted at the install
    // prefix it just discovered, which is the only prefix that describes the
    // build being reported on. A probe pinned here — to `UVCPP_ROOT`, say —
    // would answer "absent" for every feature whenever that variable is unset,
    // turning an unknown into a wrong answer.
    doctor: new DoctorService({ providers, now }),
  };
};
