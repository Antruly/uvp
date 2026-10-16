import { stat } from "node:fs/promises";
import { join } from "node:path";

import { UvpFailure } from "../domain/errors.js";
import { assessFeatures } from "./ToolchainProvider.js";
import type { HeaderProbe, LibuvcppBuild, ToolchainProvider } from "./ToolchainProvider.js";
import type { UvpFeature } from "../domain/features.js";
import type { VerdictStatus } from "../domain/verdict.js";
import { readWorkspaceManifest } from "./workspaceManifest.js";
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
        // The first two layouts not existing is the ordinary case; only an
        // unreadable-but-present path is genuinely undecidable.
        if (code === "EACCES" || code === "EPERM") return undefined;
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
 */
const requestedFeatures = async (
  workspace: string | undefined,
  override: readonly UvpFeature[] | undefined,
): Promise<RequestedFeatures> => {
  if (override !== undefined && override.length > 0) {
    return { features: override, manifestPath: undefined };
  }
  if (workspace === undefined) return { features: [], manifestPath: undefined };
  const manifest = await readWorkspaceManifest(workspace);
  return manifest === undefined
    ? { features: [], manifestPath: undefined }
    : { features: manifest.features, manifestPath: workspace };
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
    const providers = selectProviders(this.options.providers, input.providers);

    if (providers.length === 0) {
      throw new UvpFailure({
        code: "unsupported_toolchain",
        message: "No toolchain providers are configured.",
        remediation: { action: "This build of uvp has no providers registered." },
      });
    }

    const toolchains: DoctorToolchain[] = [];
    const limitations: string[] = [];

    for (const provider of providers) {
      const identityOfProvider = provider.identity();
      const availability = await provider.inspectAvailability(signal);

      for (const missing of availability.missing) {
        recordUnknown(
          recorder,
          `Is ${missing.id} available on ${identityOfProvider.id}?`,
          "toolchain_missing",
          { blockedBy: `Install ${missing.id}, then re-run uvp_doctor.` },
        );
      }

      record(recorder, {
        kind: "toolchain",
        subject: { provider: identityOfProvider.id, platform: identityOfProvider.platform },
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
          commandSource(`${identityOfProvider.id}:compiler --version`),
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

    const firstProvider = providers[0];
    if (firstProvider === undefined) throw new Error("unreachable: length checked above");
    const build = await firstProvider.findLibuvcpp(input.workspace, signal);

    const probe = this.options.headerProbe ?? headerProbeAt(build.installPrefix);
    const wanted = await requestedFeatures(input.workspace, input.features);

    if (!build.found) {
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
      const assessment = await this.#assess(wanted, build, probe, recorder, limitations);
      return { toolchains, libuvcpp, features: assessment, limitations };
    }

    return { toolchains, libuvcpp, features: [], limitations };
  }

  /**
   * Decide each requested feature and record why.
   *
   * A missing libuvcpp makes every feature `undetermined`, not `unmet`. "This
   * build does not provide TLS" and "there is no build here to ask" are different
   * findings with different remedies, and reporting the first when the second is
   * true sends the caller to rebuild a library they do not have.
   */
  async #assess(
    wanted: RequestedFeatures,
    build: LibuvcppBuild,
    probe: HeaderProbe,
    recorder: EvidenceRecorder,
    limitations: string[],
  ): Promise<DoctorFeature[]> {
    if (!build.found) {
      const note = "libuvcpp was not found, so no build could be inspected for this feature";
      for (const feature of wanted.features) {
        recordUnknown(
          recorder,
          `Can this libuvcpp build provide ${feature}?`,
          "toolchain_missing",
          {
            blockedBy: note,
          },
        );
      }
      return wanted.features.map((feature) => ({ feature, status: "undetermined" as const, note }));
    }

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
