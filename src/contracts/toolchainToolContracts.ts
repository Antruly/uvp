import { z } from "zod";

import { UVP_FEATURES } from "../domain/features.js";
import { verdictStatusSchema } from "../domain/verdict.js";
import { defineTool } from "./toolContractTypes.js";
import { toolEnvelopeShape } from "./toolOutputSchemaPrimitives.js";

/**
 * One feature's verdict.
 *
 * `undetermined` is a first-class outcome, not a soft "unmet". A feature whose
 * build has no configuration switch to read cannot be decided from headers, and
 * folding it into either side would be a claim the inspection does not support.
 */
const featureAssessmentSchema = z.object({
  feature: z.enum(UVP_FEATURES),
  status: verdictStatusSchema,
  /** Why the feature is not satisfied, when it is not. */
  note: z.string().optional(),
});

/**
 * Toolchain readiness.
 *
 * This is uvp's equivalent of REA's provider availability: it reports what the
 * host can actually do before anything is attempted. A missing compiler is not
 * a failed build — it is a missing prerequisite, and the caller should learn
 * that from one cheap call rather than from a build that dies halfway.
 */
export const doctorContract = defineTool({
  name: "uvp_doctor",
  title: "Inspect toolchain readiness",
  description:
    "Report which C++ toolchains, build systems, and libuvcpp builds are available on this host, " +
    "including per-build feature modules. Given a workspace, it also reports the toolchain that " +
    "workspace's uvp.json names — a container image's toolchain and the prerequisites this host " +
    "is missing, before any build is attempted — and describes the libuvcpp and features that " +
    "workspace will build against. Read-only: it inspects and never installs, and it never " +
    "starts a build. Call this before building to learn whether a request is achievable here.",
  kind: "toolchain",
  inputSchema: z.object({
    workspace: z
      .string()
      .optional()
      .describe(
        "Workspace path to inspect: its pinned libuvcpp requirement, and the toolchain its " +
          "uvp.json names, which the libuvcpp and feature sections then describe.",
      ),
    providers: z
      .array(z.string())
      .optional()
      .describe("Restrict the report to these toolchain provider ids."),
    features: z
      .array(z.enum(UVP_FEATURES))
      .optional()
      .describe(
        "Assess these features against the installed libuvcpp build, overriding the feature set a " +
          "workspace pins. Lets a caller ask whether a build can do TLS before any project exists.",
      ),
  }),
  outputSchema: z.object({
    ...toolEnvelopeShape,
    toolchains: z.array(
      z.object({
        id: z.string(),
        available: z.boolean(),
        version: z.string().optional(),
        compilers: z.array(
          z.object({
            id: z.string(),
            path: z.string(),
            version: z.string().optional(),
            target: z.string().optional(),
            on_path: z
              .boolean()
              .optional()
              .describe(
                "Whether this compiler was found on this host's PATH. False means it was " +
                  "located elsewhere — on Windows, an installed MSVC that Visual Studio only " +
                  "puts on PATH inside a Developer Command Prompt — and `limitations` says what " +
                  "it needs. Absent when the provider did not ask: a container's compilers are " +
                  "not on this host's PATH at all.",
              ),
          }),
        ),
        build_systems: z.array(
          z.object({ id: z.string(), path: z.string(), version: z.string().optional() }),
        ),
        /** Prerequisites that are absent, each with the reason it was looked for. */
        missing: z.array(z.object({ id: z.string(), required_for: z.string() })),
        limitations: z.array(z.string()),
      }),
    ),
    libuvcpp: z.object({
      found: z.boolean(),
      version: z.string().optional(),
      /**
       * Which file the version came from: `cmake_package`, `pkgconfig`, or
       * `version_file`.
       *
       * Reported because a prebuilt release archive ships only a `.pc` file, so
       * `pkgconfig` here is the normal answer for a downloaded library rather
       * than a fallback that fired — and because two installs under one prefix
       * can disagree about the number.
       */
      version_source: z.enum(["cmake_package", "pkgconfig", "version_file"]).optional(),
      install_prefix: z.string().optional(),
      /** Module switches as recorded by that build's uvcpp_config.h. */
      modules: z.array(z.string()),
      note: z.string().optional(),
    }),
    /**
     * The feature verdicts, stated rather than left to be inferred.
     *
     * Without this, "is websocket available here?" would be answered by an empty
     * `unknowns` array — an absence standing in for a yes, which is exactly the
     * inference the evidence model exists to prevent. The gaps also appear in
     * `unknowns`, where every unestablished fact belongs; this array is the
     * complete picture, including the features that were checked and passed.
     */
    features: z.array(featureAssessmentSchema),
  }),
  effects: {
    readsFilesystem: true,
    writesFilesystem: false,
    network: false,
    spawnsProcess: true,
    mutatesTarget: false,
  },
  examples: [
    {
      description: "Check this host before starting a new project",
      input: {},
    },
    {
      description: "Check a workspace that pins a libuvcpp requirement",
      input: { workspace: "/home/dev/services/orders" },
    },
    {
      description: "Check whether a container-declared workspace can be built on this host",
      input: { workspace: "/home/dev/services/orders", features: ["tls"] },
    },
    {
      description: "Ask whether this libuvcpp build can do TLS and WebSocket",
      input: { features: ["tls", "websocket"] },
    },
  ],
});
