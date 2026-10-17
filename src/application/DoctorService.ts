import { stat } from "node:fs/promises";
import { join } from "node:path";

import { UvpFailure, isUvpFailure } from "../domain/errors.js";
import { assessFeatures } from "./ToolchainProvider.js";
import type {
  HeaderProbe,
  LibuvcppBuild,
  ToolchainIdentity,
  ToolchainProvider,
} from "./ToolchainProvider.js";
import type { UvpFeature } from "../domain/features.js";
import type { ToolchainSelection } from "../domain/toolchain.js";
import type { VerdictStatus } from "../domain/verdict.js";
import { selectToolchain } from "./toolchainSelection.js";
import { readWorkspaceManifest } from "./workspaceManifest.js";
import type { WorkspaceManifest } from "./workspaceManifest.js";
import type { EvidenceRecorder } from "./evidenceHelpers.js";
import {
  commandSource,
  coverageComplete,
  coveragePartial,
  fileSource,
  record,
  recordUnknown,
} from "./evidenceHelpers.js";

/**
 * Readiness.
 *
 * This service answers one question — what can this host actually do — and it
 * answers it without trying anything. No configure, no compile, no install: a
 * caller asking "can I build a WebSocket service here" gets an answer in
 * milliseconds, and gets it before spending a minute on a build that was going
 * to fail at the link step.
 *
 * The distinction that carries the whole design is between *absent* and
 * *unknown*. A compiler that is not on PATH is absent, and uvp says so. A
 * libuvcpp build whose feature set cannot be read is unknown, and uvp says that
 * too rather than reporting the feature as missing. Every remaining decision in
 * this file follows from keeping those two apart.
 *
 * A workspace can name the toolchain it is built with, and that is the third
 * thing this service has to keep straight. `selectToolchain` is asked the same
 * question `uvp build` asks, so a host without a container runtime learns it
 * from a report rather than from a build that was never going to start — and
 * what the report says about libuvcpp is about the toolchain the workspace
 * named, not about whichever one happened to be registered first.
 */

export interface DoctorInput {
  readonly workspace?: string | undefined;
  readonly providers?: readonly string[] | undefined;
  /** Assess these features instead of the ones a workspace pins. */
  readonly features?: readonly UvpFeature[] | undefined;
}

export interface DoctorOptions {
  /** Providers by id. The first is the default when the caller names none. */
  readonly providers: readonly ToolchainProvider[];
  /**
   * The provider a workspace's own declaration names.
   *
   * Required, and not defaulted to the first registered provider. A workspace
   * that names a container is asking about a toolchain this list does not hold,
   * and a default here would answer with this host's facts under a workspace
   * that said it must not be built here. Composition passes
   * `UvpServices.toolchainFor`, the same function `uvp build` resolves its
   * provider through, so both surfaces agree about where a workspace builds.
   */
  readonly toolchainFor: (selection: ToolchainSelection) => ToolchainProvider;
  /** The provider whose identity stamps the envelope when nothing else names one. */
  readonly headerProbe?: HeaderProbe | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly now?: (() => Date) | undefined;
}

const listIds = (providers: readonly ToolchainProvider[]): string =>
  providers.map((provider) => provider.identity().id).join(", ");

/**
 * Resolve the providers a caller asked for.
 *
 * An unknown id is an error, not a filter that quietly matches nothing. A caller
 * that typed `--provider dockr` and got back an empty report would conclude that
 * no toolchain works on this host, which is the opposite of what happened.
 */
const selectProviders = (
  available: readonly ToolchainProvider[],
  requested: readonly string[] | undefined,
): readonly ToolchainProvider[] => {
  if (requested === undefined || requested.length === 0) return available;
  const byId = new Map(available.map((provider) => [provider.identity().id, provider]));
  const unknown = requested.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new UvpFailure({
      code: "invalid_request",
      message: `Unknown toolchain provider ${unknown.map((id) => `"${id}"`).join(", ")}.`,
      remediation: {
        action: `Pass one of: ${listIds(available)}.`,
      },
      details: { requested: [...requested], available: [...byId.keys()] },
    });
  }
  return requested.map((id) => {
    const provider = byId.get(id);
    if (provider === undefined) throw new Error("unreachable: filtered above");
    return provider;
  });
};

/**
 * A header probe rooted at one install prefix.
 *
 * Returning `undefined` for an unreadable path is the entire point of the type:
 * a permission error and a missing directory are not evidence that the header is
 * absent, and reporting either as absence would turn "I could not look" into a
 * finding.
 */
export const headerProbeAt = (installPrefix: string | undefined): HeaderProbe => {
  if (installPrefix === undefined) return async () => undefined;
  return async (header: string): Promise<boolean | undefined> => {
    const candidates = [
      join(installPrefix, "include", "uvcpp", header),
      join(installPrefix, "include", header),
      join(installPrefix, header),
    ];
    for (const candidate of candidates) {
      try {
        await stat(candidate);
        return true;
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code;
        // ENOENT and ENOTDIR are the two ways a path is simply not there. Any
        // other failure — a permission error, a symlink loop, an I/O error — is
        // a look that did not happen, and "could not look" is not absence. The
        // first two layouts not existing is the ordinary case; everything else
        // makes the candidate walk end undecided rather than negative.
        if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
      }
    }
    return false;
  };
};

interface RequestedFeatures {
  readonly features: readonly UvpFeature[];
  /** The manifest the set came from, when it came from one rather than from the caller. */
  readonly manifestPath: string | undefined;
}

/**
 * The features to assess.
 *
 * An explicit request wins over a workspace's manifest. That is what lets a
 * caller ask "can this libuvcpp build do TLS?" before any project exists, which
 * is the question that decides whether creating one is worth doing.
 *
 * The manifest arrives already read rather than being read here. Both this
 * function and the toolchain selection need it, and a file read twice is two
 * answers about a workspace that can change between them — with the second read
 * silently deciding where a build goes.
 */
const requestedFeatures = (
  workspace: string | undefined,
  manifest: WorkspaceManifest | undefined,
  override: readonly UvpFeature[] | undefined,
): RequestedFeatures => {
  if (override !== undefined && override.length > 0) {
    return { features: override, manifestPath: undefined };
  }
  if (workspace === undefined || manifest === undefined) {
    return { features: [], manifestPath: undefined };
  }
  return { features: manifest.features, manifestPath: workspace };
};

/**
 * Why the toolchain this workspace named could not be asked about libuvcpp.
 *
 * Both halves come from the provider that refused — its sentence and its remedy
 * — because the reason a container cannot be examined is a fact about that
 * provider's host, and a second wording of it here would be a second owner.
 */
interface Unexamined {
  /** The image that could not be examined. */
  readonly image: string;
  /** The provider's own sentence about why. */
  readonly reason: string;
  /** The provider's own remedy. */
  readonly blockedBy: string;
}

/**
 * What the feature question is asked of.
 *
 * One record rather than five parameters, and the reason is not the count:
 * `build` and `unexamined` come out of `#libuvcppOf` as one answer, so a state
 * carrying one without the other is not a state this pair can be in.
 */
interface FeatureQuestion {
  readonly wanted: RequestedFeatures;
  readonly build: LibuvcppBuild;
  readonly probe: HeaderProbe;
  readonly unexamined: Unexamined | undefined;
}

/** Said of a host with no libuvcpp at all, where a missing install is the reason. */
const NO_BUILD = "libuvcpp was not found, so no build could be inspected for this feature";

/**
 * Whether anything at all can be decided about these features.
 *
 * Two states with one shape: the toolchain the workspace named could not be
 * examined, so this host's install is not the subject — or the selected toolchain
 * has no libuvcpp. Neither is a finding about a feature, and both are owed to the
 * caller as the reason rather than as a verdict.
 */
const undecidable = (
  build: LibuvcppBuild,
  unexamined: Unexamined | undefined,
): { reason: string; blockedBy: string } | undefined => {
  if (unexamined !== undefined) {
    return { reason: unexamined.reason, blockedBy: unexamined.blockedBy };
  }
  return build.found ? undefined : { reason: NO_BUILD, blockedBy: NO_BUILD };
};

/**
 * Every feature undetermined for the same reason, each recorded against it.
 *
 * Undetermined rather than unmet, always: a caller sent to rebuild libuvcpp for
 * a build nobody looked at is the one outcome this state exists to prevent.
 */
const allUndetermined = (
  features: readonly UvpFeature[],
  block: { reason: string; blockedBy: string },
  recorder: EvidenceRecorder,
): DoctorFeature[] => {
  for (const feature of features) {
    recordUnknown(recorder, `Can this libuvcpp build provide ${feature}?`, "toolchain_missing", {
      blockedBy: block.blockedBy,
    });
  }
  return features.map((feature) => ({
    feature,
    status: "undetermined" as const,
    note: block.reason,
  }));
};

export class DoctorService {
  constructor(private readonly options: DoctorOptions) {}

  /**
   * Inspect the host.
   *
   * The recorder is passed in rather than created here because the envelope — and
   * therefore the unknowns — belongs to the caller that will return it. A service
   * that sealed its own envelope would make the tool handler's own limitations
   * impossible to merge in without a second, competing envelope.
   */
  async doctor(
    input: DoctorInput,
    recorder: EvidenceRecorder,
    signal: AbortSignal,
  ): Promise<DoctorReport> {
    // One read of `uvp.json`, two things out of it. The feature set and the
    // toolchain declaration come from the same bytes, so a report cannot
    // describe the features of one revision of a file and the build target of
    // another.
    const manifest =
      input.workspace === undefined ? undefined : await readWorkspaceManifest(input.workspace);

    // The same rule `uvp build` applies, and deliberately the same function: a
    // declaration that cannot be read is refused rather than degraded, including
    // when the caller passed `--features` and believes the manifest is beside the
    // point of the question they asked.
    const selection = selectToolchain({ manifest });
    const selected = this.options.toolchainFor(selection);

    // The toolchain the workspace named is added to the ones a caller can name,
    // so `--provider container` reaches the image the manifest declares. It is
    // not added twice when it is the host's own provider, which is what keeps
    // `--provider local` reporting one row rather than two identical ones.
    const available = this.options.providers.includes(selected)
      ? this.options.providers
      : [...this.options.providers, selected];
    const providers = selectProviders(available, input.providers);

    if (providers.length === 0) {
      throw new UvpFailure({
        code: "unsupported_toolchain",
        message: "No toolchain providers are configured.",
        remediation: { action: "This build of uvp has no providers registered." },
      });
    }

    const { toolchains, limitations } = await this.#inspect(providers, recorder, signal);

    // A caller's restriction is honoured as a restriction on what is reported,
    // and it does not move the subject of the sections below: those answer what
    // this workspace will build against, which the workspace decides and a flag
    // does not. Saying so is what keeps a one-row report from reading as "and
    // the container is not involved".
    if (!providers.includes(selected)) {
      limitations.push(
        `This report was restricted to ${listIds(providers)}, and this workspace builds with ` +
          `${selected.identity().id}, which is not among them. The libuvcpp and feature sections ` +
          "below are still about the toolchain this workspace named.",
      );
    }

    // Asked of the toolchain the workspace named, not of the first provider a
    // caller listed. A container's build links against the libuvcpp inside the
    // image, so this host's install is not an answer to the question the report
    // is asked — and reporting it as one is how a workspace gets built against a
    // library nobody described.
    const { build, unexamined } = await this.#libuvcppOf(
      selected,
      selection,
      input.workspace,
      signal,
    );

    // A container's install prefix is a path inside the image. Rooting a probe
    // at it would `stat` this host, where nothing is there, and answer `false`
    // for every header-only feature — turning "this host cannot look" into "that
    // build does not have it", which is the one inference `assessFeatures` keeps
    // an `undetermined` state for.
    const probe =
      selection.kind === "container"
        ? headerProbeAt(undefined)
        : (this.options.headerProbe ?? headerProbeAt(build.installPrefix));
    const wanted = requestedFeatures(input.workspace, manifest, input.features);

    if (unexamined !== undefined) {
      limitations.push(unexamined.reason);
      // Said in the report's own voice as well as the provider's, because the
      // section below is the one a reader checks first and it is not about the
      // toolchain this workspace builds with.
      limitations.push(
        `Nothing here describes ${unexamined.image}: the libuvcpp below is this host's own install, ` +
          "and this workspace does not build with it.",
      );
    } else if (!build.found) {
      recordUnknown(
        recorder,
        "Which libuvcpp modules does the installed build provide?",
        "toolchain_missing",
        { blockedBy: "Install libuvcpp, or set UVCPP_ROOT to an unpacked release." },
      );
      if (build.note !== undefined) limitations.push(build.note);
    }

    const libuvcpp: DoctorLibuvcpp = {
      found: build.found,
      ...(build.version === undefined ? {} : { version: build.version }),
      ...(build.versionSource === undefined ? {} : { version_source: build.versionSource }),
      ...(build.installPrefix === undefined ? {} : { install_prefix: build.installPrefix }),
      modules: [...build.modules],
      ...(build.note === undefined ? {} : { note: build.note }),
    };

    if (wanted.features.length > 0) {
      const assessment = await this.#assess(
        { wanted, build, probe, unexamined },
        recorder,
        limitations,
      );
      return {
        toolchains,
        libuvcpp,
        features: assessment,
        limitations,
        provider: selected.identity(),
      };
    }

    return { toolchains, libuvcpp, features: [], limitations, provider: selected.identity() };
  }

  /**
   * Ask every provider a caller named, and record what each one answers.
   *
   * The one half of the report that is about this host; everything downstream is
   * about the toolchain the workspace named. Kept apart because that is also the
   * difference a `--provider` restriction makes: it moves which rows appear here
   * and it does not move the subject of what follows.
   */
  async #inspect(
    providers: readonly ToolchainProvider[],
    recorder: EvidenceRecorder,
    signal: AbortSignal,
  ): Promise<{ toolchains: DoctorToolchain[]; limitations: string[] }> {
    const toolchains: DoctorToolchain[] = [];
    const limitations: string[] = [];

    for (const provider of providers) {
      const identity = provider.identity();
      const availability = await provider.inspectAvailability(signal);

      for (const missing of availability.missing) {
        recordUnknown(
          recorder,
          `Is ${missing.id} available on ${identity.id}?`,
          "toolchain_missing",
          {
            blockedBy: `Install ${missing.id}, then re-run uvp_doctor.`,
          },
        );
      }

      record(recorder, {
        kind: "toolchain",
        subject: { provider: identity.id, platform: identity.platform },
        observed: {
          available: availability.available,
          compilers: availability.compilers.map((compiler) => compiler.id),
          build_systems: availability.buildSystems.map((system) => system.id),
          missing: availability.missing.map((missing) => missing.id),
        },
        // Availability is what was observed; the derived part is the verdict a
        // caller would otherwise have to compute from it.
        derived: {
          can_configure: availability.buildSystems.some((system) => system.id === "cmake"),
          can_compile: availability.compilers.length > 0,
        },
        coverage: coverageComplete("toolchain availability"),
        sources: [
          commandSource(`${identity.id}:compiler --version`),
          commandSource("cmake --version"),
        ],
        limitations: availability.limitations,
      });

      toolchains.push({
        id: availability.id,
        available: availability.available,
        ...(availability.version === undefined ? {} : { version: availability.version }),
        compilers: availability.compilers.map((compiler) => ({
          id: compiler.id,
          path: compiler.path,
          ...(compiler.version === undefined ? {} : { version: compiler.version }),
          ...(compiler.target === undefined ? {} : { target: compiler.target }),
        })),
        build_systems: availability.buildSystems.map((system) => ({
          id: system.id,
          path: system.path,
          ...(system.version === undefined ? {} : { version: system.version }),
        })),
        missing: availability.missing.map((missing) => ({
          id: missing.id,
          required_for: missing.requiredFor,
        })),
        limitations: [...availability.limitations],
      });
      limitations.push(...availability.limitations);
    }

    return { toolchains, limitations };
  }

  /**
   * The libuvcpp the selected toolchain builds against.
   *
   * A provider refuses rather than answers when it cannot run its toolchain at
   * all — the port says so, and `LibuvcppBuild` has no way to say "not looked",
   * because every caller reads `found: false` as a claim that there is nothing
   * there. So the refusal is caught here, and what the report does with it is
   * the doctor's own decision rather than a rewriting of the provider's:
   *
   *  - the refusal is kept in the provider's own words and returned, so the
   *    sections about the build can say why they could not be answered;
   *  - `libuvcpp` falls back to this host's install, which is a real
   *    observation and is reported as one. It is not an answer about the image,
   *    and the caller is told exactly that. The alternative — `found: false` —
   *    would claim the image has no libuvcpp when nothing looked in it.
   */
  async #libuvcppOf(
    selected: ToolchainProvider,
    selection: ToolchainSelection,
    workspace: string | undefined,
    signal: AbortSignal,
  ): Promise<{ build: LibuvcppBuild; unexamined?: Unexamined }> {
    try {
      return { build: await selected.findLibuvcpp(workspace, signal) };
    } catch (cause) {
      // Only the host's own provider is exempt: it cannot fail this way, and a
      // catch that swallowed its errors would hide a real defect behind a
      // "could not examine" sentence.
      if (
        selection.kind !== "container" ||
        !isUvpFailure(cause) ||
        cause.detail.code !== "toolchain_unavailable"
      ) {
        throw cause;
      }
      const host = this.options.providers[0];
      if (host === undefined) throw cause;
      return {
        build: await host.findLibuvcpp(workspace, signal),
        unexamined: {
          image: selection.image,
          reason: cause.message,
          blockedBy: cause.detail.remediation.action,
        },
      };
    }
  }

  /**
   * Decide each requested feature and record why.
   *
   * A missing libuvcpp makes every feature `undetermined`, not `unmet`. "This
   * build does not provide TLS" and "there is no build here to ask" are different
   * findings with different remedies, and reporting the first when the second is
   * true sends the caller to rebuild a library they do not have.
   *
   * A toolchain that could not be examined at all is the same third state one
   * step earlier, and it must not be decided against the install that happens to
   * be on this host: those modules describe a library the build will not use.
   */
  async #assess(
    question: FeatureQuestion,
    recorder: EvidenceRecorder,
    limitations: string[],
  ): Promise<DoctorFeature[]> {
    const block = undecidable(question.build, question.unexamined);
    if (block !== undefined) {
      return allUndetermined(question.wanted.features, block, recorder);
    }

    const { wanted, build, probe } = question;
    const assessment = await assessFeatures(wanted.features, build.modules, probe);
    const features: DoctorFeature[] = [];

    for (const feature of assessment.satisfied) {
      features.push({ feature, status: "satisfied" });
    }
    for (const gap of assessment.unmet) {
      const remedy =
        gap.cmakeOptions.length === 0
          ? `Rebuild libuvcpp with ${gap.feature} support and reinstall it.`
          : `Rebuild libuvcpp with ${gap.cmakeOptions.map((option) => `-D${option}=ON`).join(" ")}.`;
      features.push({
        feature: gap.feature,
        status: "unmet",
        note:
          gap.absentSymbols.length === 0
            ? remedy
            : `${remedy} Absent: ${gap.absentSymbols.slice(0, 3).join(", ")}.`,
      });
      recordUnknown(
        recorder,
        `Can this libuvcpp build provide ${gap.feature}?`,
        "unsupported_by_build",
        {
          blockedBy: remedy,
        },
      );
    }
    for (const entry of assessment.undetermined) {
      features.push({ feature: entry.feature, status: "undetermined", note: entry.reason });
      recordUnknown(
        recorder,
        `Can this libuvcpp build provide ${entry.feature}?`,
        "unsupported_by_build",
        {
          blockedBy: entry.reason,
        },
      );
    }

    limitations.push(...assessment.undetermined.map((entry) => entry.reason));

    record(recorder, {
      kind: "toolchain",
      subject: {
        requested: [...wanted.features],
        ...(wanted.manifestPath === undefined ? {} : { manifest: wanted.manifestPath }),
      },
      observed: {
        satisfied: [...assessment.satisfied],
        unmet: assessment.unmet.map((gap) => ({
          feature: gap.feature,
          detection: gap.detection,
          absent_symbols: [...gap.absentSymbols],
        })),
      },
      coverage:
        assessment.undetermined.length === 0
          ? coverageComplete("requested feature set")
          : coveragePartial(
              "requested feature set",
              `${String(assessment.undetermined.length)} feature(s) have no configuration switch and could not be decided from headers.`,
              wanted.features.length - assessment.undetermined.length,
              wanted.features.length,
            ),
      sources: [
        ...(build.installPrefix === undefined
          ? []
          : [fileSource(join(build.installPrefix, "include", "uvcpp", "uvcpp_config.h"))]),
        ...(wanted.manifestPath === undefined
          ? []
          : [fileSource(join(wanted.manifestPath, "uvp.json"))]),
      ],
      limitations: assessment.undetermined.map((entry) => entry.reason),
    });

    return features;
  }
}

/** The doctor's own output fields, mirroring the tool contract. */
export interface DoctorToolchain {
  id: string;
  available: boolean;
  version?: string;
  compilers: { id: string; path: string; version?: string; target?: string }[];
  build_systems: { id: string; path: string; version?: string }[];
  missing: { id: string; required_for: string }[];
  limitations: string[];
}

/**
 * The tool contract's `libuvcpp` object, and nothing more.
 *
 * A workspace's pinned features are deliberately absent here even though this
 * service evaluates them: the contract does not have a field for them, and
 * adding one would put a second answer next to the one the `unmet` unknowns
 * already give. A caller reads the gaps from `unknowns`, where every other
 * unestablished fact lives.
 */
export interface DoctorLibuvcpp {
  found: boolean;
  version?: string;
  version_source?: "cmake_package" | "pkgconfig" | "version_file";
  install_prefix?: string;
  modules: string[];
  note?: string;
}

/** One feature's verdict, as the tool contract reports it. */
export interface DoctorFeature {
  feature: UvpFeature;
  status: VerdictStatus;
  note?: string;
}

export interface DoctorReport {
  /**
   * The toolchain the workspace's own declaration names, whose identity stamps
   * the envelope.
   *
   * Carried out of the service rather than read from a handler's first
   * registered provider, because a report about a container build stamped
   * `local` is a result that contradicts its own body.
   */
  provider: ToolchainIdentity;
  toolchains: DoctorToolchain[];
  libuvcpp: DoctorLibuvcpp;
  /**
   * The feature verdicts, stated rather than inferable.
   *
   * Empty when nothing was requested. Every requested feature appears exactly
   * once: a caller reads this array for "can I use TLS here" instead of reading
   * an empty `unknowns` array as a yes.
   */
  features: DoctorFeature[];
  /** Toolchain-level caveats, lifted into the envelope by the tool handler. */
  limitations: string[];
}
