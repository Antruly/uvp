import type { UvpFeature } from "../domain/features.js";

/**
 * The toolchain port.
 *
 * This is uvp's provider abstraction, and it exists for the same reason REA's
 * does: the contract above it must not know whether the C++ is being compiled
 * by a local GCC, a local MSVC, a container, or a machine reached over SSH.
 *
 * A provider reports what it *can* do before it is asked to do anything
 * (`inspectAvailability`), and reports per-capability gaps rather than failing
 * as a monolith. Local MSVC has no Ninja; a container has no host filesystem;
 * an SSH target has no local digests. Each says so.
 */

export interface ToolchainIdentity {
  readonly id: string;
  readonly version?: string;
  readonly platform: string;
}

export interface CompilerDescriptor {
  readonly id: string;
  readonly path: string;
  readonly version?: string;
  readonly target?: string;
}

export interface BuildSystemDescriptor {
  readonly id: string;
  readonly path: string;
  readonly version?: string;
}

/** A prerequisite that is absent, and the capability it blocks. */
export interface MissingPrerequisite {
  readonly id: string;
  readonly requiredFor: string;
}

export interface ToolchainAvailability {
  readonly id: string;
  readonly available: boolean;
  readonly version?: string;
  readonly compilers: readonly CompilerDescriptor[];
  readonly buildSystems: readonly BuildSystemDescriptor[];
  readonly missing: readonly MissingPrerequisite[];
  readonly limitations: readonly string[];
  /**
   * The pkg-config executable, when this provider looked for one.
   *
   * Three states, because they are three different findings: the field is
   * absent when the provider did not look, `{}` when it looked and found
   * nothing, and `{ path }` when it found an executable. `pkgConfig: undefined`
   * cannot carry the middle state — an absent value and a missing property are
   * the same thing in JSON — and collapsing "not looked" into "not there" is
   * how a check that never ran becomes an instruction to install something.
   *
   * Only an executable image counts. CMake's `FindPkgConfig` uses
   * `find_program`, and a `.bat` wrapper that answers `pkg-config --version` in
   * a shell is not one — so a provider that accepted the wrapper would report a
   * host ready that configure then refuses.
   */
  readonly pkgConfig?: { readonly path?: string };
}

/**
 * What a particular libuvcpp build provides.
 *
 * `modules` is read from that build's generated header, not from the version
 * number: two 1.7.0 builds can differ in whether HTTP/3 was compiled in. A
 * capability claim drawn from the version alone would be a guess.
 */
export interface LibuvcppBuild {
  readonly found: boolean;
  readonly version?: string;
  /**
   * Which file the version was read from.
   *
   * Carried because the sources can disagree — a prefix holding both a
   * source-built CMake package and an unpacked prebuilt archive will answer with
   * whichever is checked first — and because an install with no CMake package at
   * all is a normal prebuilt release, not a broken one.
   */
  readonly versionSource?: "cmake_package" | "pkgconfig" | "version_file";
  readonly installPrefix?: string;
  readonly modules: readonly string[];
  /**
   * Whether `modules` is an observation or an unread list.
   *
   * An install whose config header could not be read reports `modules: []`
   * because the field is required, but that empty list is not a fact about the
   * build. Without this flag the two states are indistinguishable, and a consumer
   * comparing requirements against the empty list reports every switch-gated
   * feature as absent — a check that never ran turned into a no.
   */
  readonly modulesUnknown?: boolean;
  /**
   * Whether `find_package(uvcpp CONFIG)` can find this install.
   *
   * The generated project tries the CMake package first and falls back to
   * pkg-config, so this is the fact that decides whether pkg-config is a
   * prerequisite at all. `undefined` means the install was found but its
   * package files were not examined — a different state from `false`, which is
   * the observation that the fallback is the route that will run.
   */
  readonly cmakePackage?: boolean;
  readonly note?: string;
}

export type BuildPhase = "configure" | "compile" | "link" | "post";

/**
 * A remedy for a diagnostic, in the same shape a `UvpFailure` carries one.
 *
 * A build that fails during configure is data — a successful tool call with
 * diagnostics — so its remedy lives on the diagnostic rather than in the error
 * envelope. `docs` is a repository-relative path, as in `uvpRemediationSchema`.
 */
export interface BuildRemediation {
  readonly action: string;
  readonly docs?: string;
}

export interface BuildDiagnostic {
  readonly severity: "error" | "warning" | "note";
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly message: string;
  readonly phase: BuildPhase;
  /**
   * What to do about it, when the producer knows a concrete next step.
   *
   * Present only when the raw tool output names a failure whose remedy is
   * known; the message is never rewritten to carry it, so a caller that wants
   * CMake's own words still has them.
   */
  readonly remediation?: BuildRemediation;
}

export interface BuildArtifact {
  readonly path: string;
  readonly bytes: number;
  readonly digest: string;
}

export interface BuildRequest {
  readonly workspacePath: string;
  readonly buildDir: string;
  readonly buildType: "Debug" | "RelWithDebInfo" | "Release";
  readonly generator?: "ninja" | "unix-makefiles" | "msbuild";
  readonly target?: string;
  readonly clean: boolean;
  readonly jobs?: number;
  readonly timeoutMs: number;
  readonly configureOnly: boolean;
  /**
   * The libuvcpp install to build against, when the caller already knows one.
   *
   * A caller that names a prefix is taken at its word. A caller that names none
   * gets the install the toolchain found for itself — the same one `uvp doctor`
   * reports — because the alternative is worse than it looks: uvp would describe
   * one install and then invoke CMake with no pointer to it, so a workspace would
   * configure against a different libuvcpp than the one uvp described, or, for a
   * prebuilt archive outside every search path, against none at all. Discovery
   * therefore lives in the toolchain rather than with the caller, so no caller
   * can omit it by forgetting.
   */
  readonly libuvcppPrefix?: string;
  readonly signal: AbortSignal;
}

/**
 * A completed build attempt.
 *
 * `exitCode !== 0` is a normal outcome carrying diagnostics, not an exception.
 * Only the inability to run the toolchain at all is an error, and that is
 * reported by the caller as a `UvpFailure`.
 */
export interface BuildOutcome {
  readonly buildDir: string;
  readonly exitCode: number;
  readonly succeeded: boolean;
  readonly configureDurationMs: number;
  readonly compileDurationMs: number;
  readonly fromCache: boolean;
  readonly diagnostics: readonly BuildDiagnostic[];
  readonly artifacts: readonly BuildArtifact[];
  readonly commands: readonly string[];
}

/** A provider that can also build. Split from `ToolchainProvider` so that
 *  inspection-only providers (a text report, a remote probe) stay possible. */
export interface ToolchainClient {
  readonly identity: ToolchainIdentity;
  build(request: BuildRequest): Promise<BuildOutcome>;
}

/**
 * What a provider must do when the call it was asked for is cancelled.
 *
 * Every method that can take time takes the caller's `AbortSignal`, and what a
 * provider does with it is part of the port rather than up to the provider:
 *
 * **A cancellation is not a finding.** An interrupted call has established
 * nothing about its subject, and the shapes below this port can all express one
 * as an answer instead — an empty compiler list reads as "this host has no
 * compiler", `found: false` reads as "there is no libuvcpp here", and an outcome
 * built from a killed compile reads as "this workspace does not build". A caller
 * cannot tell any of those from a run stopped one step earlier, and the
 * difference decides whether they go and install something. So a provider
 * rejects with the `cancelled` failure (`cancelledFailure` in `domain/errors.ts`)
 * rather than returning what it had collected, and it checks the signal *before*
 * it starts the work as well as during — a signal already aborted at entry means
 * nothing is started.
 */
export interface ToolchainProvider {
  identity(): ToolchainIdentity;
  inspectAvailability(signal: AbortSignal): Promise<ToolchainAvailability>;
  findLibuvcpp(workspacePath: string | undefined, signal: AbortSignal): Promise<LibuvcppBuild>;
  createClient(): ToolchainClient;
}

/**
 * What each feature actually demands of a libuvcpp build.
 *
 * These names are taken from libuvcpp's own `option()` declarations and
 * `cmake/uvcpp_config.h.in`, not from documentation, because a wrong switch name
 * fails silently: CMake warns about an unused `-D` and builds a library without
 * the module, and the generated service then fails to compile against headers
 * that were never installed.
 *
 * Two facts make this table less uniform than it looks:
 *
 *   - The WebSocket server lives in the **web** layer and is routed in the
 *     **webapp** layer, so `websocket` needs both `UVCPP_BUILD_WEB` and
 *     `UVCPP_BUILD_WEBAPP`. There is no standalone `UVCPP_ENABLE_WEBSOCKET`.
 *   - **grpc has no option at all.** Its headers are installed whenever they are
 *     present in the source tree, so the only honest check is whether
 *     `include/grpc/` exists. An empty `cmakeOptions` here means "nothing to
 *     turn on", not "nothing needed".
 */
export interface UvpFeatureRequirement {
  /** CMake `-D` switches that must be set when building libuvcpp from source. */
  readonly cmakeOptions: readonly string[];
  /** `uvcpp_config.h` macros that must be defined non-zero in the installed build. */
  readonly configSymbols: readonly string[];
  /** Header, relative to the libuvcpp include root, that proves the module ships. */
  readonly header: string;
}

export const FEATURE_REQUIREMENTS: Record<UvpFeature, UvpFeatureRequirement> = {
  tls: {
    cmakeOptions: ["UVCPP_ENABLE_OPENSSL"],
    configSymbols: ["UVCPP_OPENSSL_ENABLE"],
    header: "ssl/uvcpp_ssl_context.h",
  },
  http2: {
    cmakeOptions: ["UVCPP_ENABLE_NGHTTP2"],
    configSymbols: ["UVCPP_NGHTTP2_ENABLE"],
    header: "http2/uvcpp_h2_common.h",
  },
  http3: {
    // HTTP/3 is dialect-over-QUIC; enabling one without the other yields a build
    // with the header present and no transport under it.
    //
    // `UVCPP_BUILD_WEB` is here because the *serving* half of h3 is
    // `uvcpp_http_server`, which lives in the web layer behind
    // `#if UVCPP_WEB_ENABLE`. Without it the h3 headers still install — the
    // client half is in `http3/` — so a config-symbol check that stopped at
    // HTTP3/QUIC would call the feature satisfied and then hand the caller a
    // template that cannot compile. The client-only build is a real build; it is
    // just not one that can serve what this feature's generated code serves.
    cmakeOptions: ["UVCPP_ENABLE_HTTP3", "UVCPP_ENABLE_QUIC", "UVCPP_BUILD_WEB"],
    configSymbols: ["UVCPP_HTTP3_ENABLE", "UVCPP_QUIC_ENABLE", "UVCPP_WEB_ENABLE"],
    header: "http3/uvcpp_h3_common.h",
  },
  grpc: {
    cmakeOptions: [],
    configSymbols: [],
    header: "grpc",
  },
  websocket: {
    cmakeOptions: ["UVCPP_BUILD_WEB", "UVCPP_BUILD_WEBAPP"],
    configSymbols: ["UVCPP_WEB_ENABLE", "UVCPP_WEBAPP_ENABLE"],
    header: "web/uvcpp_ws_server.h",
  },
  soap: {
    // SOAP is XML over the ordinary HTTP stack. The WSDL module generates and
    // parses service descriptions, which a hand-written envelope does not need —
    // so it is not a prerequisite here.
    cmakeOptions: ["UVCPP_BUILD_WEB", "UVCPP_BUILD_WEBAPP"],
    configSymbols: ["UVCPP_WEB_ENABLE", "UVCPP_WEBAPP_ENABLE"],
    header: "webapp/uvcpp_web_app.h",
  },
  db: {
    cmakeOptions: ["UVCPP_ENABLE_DB"],
    configSymbols: ["UVCPP_DB_ENABLE"],
    header: "db",
  },
};

/** A feature the installed libuvcpp build does not provide. */
export interface FeatureGap {
  readonly feature: UvpFeature;
  /** How the absence was established. */
  readonly detection: "config_symbol" | "header";
  /** Non-zero macros the build is missing. Empty when the header is the evidence. */
  readonly absentSymbols: readonly string[];
  /** CMake switches that would have enabled them; empty when no switch governs this. */
  readonly cmakeOptions: readonly string[];
}

export interface FeatureAssessment {
  readonly satisfied: readonly UvpFeature[];
  readonly unmet: readonly FeatureGap[];
  /**
   * Features that cannot be decided from the config header alone. Kept as its
   * own bucket rather than folded into either side: a module whose presence is
   * checked by looking for headers has not been proven absent, and reporting it
   * as missing would be a guess dressed up as a finding.
   */
  readonly undetermined: readonly UndecidedFeature[];
}

export interface UndecidedFeature {
  readonly feature: UvpFeature;
  readonly reason: string;
  /**
   * True when the reason is that the module list could not be read, rather
   * than a missing or undecidable probe. Consumers record the two with
   * different unknown reasons: one is an absent toolchain, the other is a
   * finding about the build's feature set.
   */
  readonly modulesUnknown?: boolean;
}

/**
 * Answers whether a header exists under a libuvcpp install's include root.
 *
 * It returns `undefined` when it cannot tell — an unreadable install, a probe
 * that was not wired up. That third state is the point: "I could not look" and
 * "I looked and it was not there" are different findings, and collapsing them
 * would turn every missing probe into a fabricated absence.
 */
export type HeaderProbe = (header: string) => Promise<boolean | undefined>;

/**
 * Compare the feature set a caller wants against what a build actually has.
 *
 * `modules` is the `UVCPP_*` symbols the build defines as exactly `1`, as read
 * out of its generated `uvcpp_config.h`. Not the `*_ENABLE` flags, which is what
 * this said until the installed 1.7.0 header was read: that header also carries
 * `UVCPP_ENABLE_MEMORY_POOL` and `UVCPP_DB_RUNTIME_LOAD`, which are defined as `1`
 * and do not end in `_ENABLE`. The list is the symbols, so it is a superset of
 * the flags. The feature table below looks up specific symbols and does not care;
 * a provider reporting `modules` does, which is why the obligation in
 * `tests/conformance/providerContract.ts` checks the `UVCPP_` prefix rather than
 * a suffix. The header's `UVCPP_HTTP_COMPRESS_ENABLE (1||1)` is left out by the
 * reader, which admits only a value spelled exactly `1`.
 *
 * Two kinds of feature meet two kinds of evidence. When libuvcpp has a switch
 * for a module, the config header decides it outright. When it has none — grpc,
 * whose headers install whenever they are present — the installed headers are
 * the only evidence there is, and a feature that cannot be checked lands in
 * `undetermined` rather than being guessed into `satisfied` or `unmet`.
 *
 * `options.modulesUnknownReason` says the header could not be read at all, so
 * `modules` is not an observation of the build. Every switch-gated feature is
 * then `undetermined` for that reason — the macro was never looked for, which is
 * not the same as having been looked for and found absent. Header-probed
 * features are unaffected: their evidence does not come from the module list.
 */
export const assessFeatures = async (
  wanted: readonly UvpFeature[],
  modules: readonly string[],
  probe?: HeaderProbe,
  options?: { readonly modulesUnknownReason: string },
): Promise<FeatureAssessment> => {
  const defined = new Set(modules);
  const satisfied: UvpFeature[] = [];
  const unmet: FeatureGap[] = [];
  const undetermined: UndecidedFeature[] = [];

  for (const feature of new Set(wanted)) {
    const requirement = FEATURE_REQUIREMENTS[feature];

    if (requirement.configSymbols.length > 0) {
      if (options !== undefined) {
        undetermined.push({
          feature,
          reason: options.modulesUnknownReason,
          modulesUnknown: true,
        });
        continue;
      }
      const absent = requirement.configSymbols.filter((symbol) => !defined.has(symbol));
      if (absent.length === 0) {
        satisfied.push(feature);
        continue;
      }
      unmet.push({
        feature,
        detection: "config_symbol",
        absentSymbols: absent,
        cmakeOptions: requirement.cmakeOptions,
      });
      continue;
    }

    if (probe === undefined) {
      undetermined.push({
        feature,
        reason: `libuvcpp has no configuration switch for ${feature}, and no header probe was supplied to check for ${requirement.header}.`,
      });
      continue;
    }

    const present = await probe(requirement.header);
    if (present === undefined) {
      undetermined.push({
        feature,
        reason: `libuvcpp has no configuration switch for ${feature}, and ${requirement.header} could not be inspected under the install root.`,
      });
      continue;
    }
    if (present) {
      satisfied.push(feature);
      continue;
    }
    unmet.push({
      feature,
      detection: "header",
      absentSymbols: [],
      cmakeOptions: [],
    });
  }

  return { satisfied, unmet, undetermined };
};
