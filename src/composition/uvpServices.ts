import { SessionStore } from "../application/sessionStore.js";
import { WorkspaceService } from "../application/WorkspaceService.js";
import { WebService } from "../application/WebService.js";
import { CaptureService } from "../application/CaptureService.js";
import { DoctorService } from "../application/DoctorService.js";
import { LocalToolchainProvider } from "../toolchains/local/LocalToolchainProvider.js";
import { startSupervised } from "../toolchains/local/processRunner.js";
import { NativeProbeRunner } from "../toolchains/native/NativeProbeRunner.js";
import type { NativeWebSocketProbe } from "../application/NativeWebSocketProbe.js";
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
   * The libuvcpp stack's WebSocket probe. Defaults to the supervised process.
   *
   * Injected for the same reason the providers are: a lane that is about what uvp
   * does with a probe's report should not need a C++ toolchain to say it, and the
   * lane that *is* about the real probe names this explicitly so its coverage is
   * a statement rather than an inference.
   */
  readonly nativeProbe?: NativeWebSocketProbe | undefined;
}

export interface UvpServices {
  readonly now: () => Date;
  readonly store: SessionStore;
  readonly providers: readonly ToolchainProvider[];
  /** The provider whose identity stamps results and whose client builds. */
  readonly primary: ToolchainProvider;
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
  const client = primary.createClient();

  return {
    now,
    store,
    providers,
    primary,
    workspace: new WorkspaceService(store, client, startSupervised, now),
    web: new WebService({
      store,
      now,
      nativeProbe: options.nativeProbe ?? new NativeProbeRunner(),
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
