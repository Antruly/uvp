import { asList, asString, parseCsv } from "../args.js";
import type { CommandSpec } from "../commandSpec.js";
import { EXIT_NO } from "../exitCodes.js";
import { bool, list, obj } from "../readOutput.js";

/**
 * `uvp doctor`.
 *
 * Read-only, and the first command anyone should run. A report that finds a
 * missing prerequisite answers "no" — it ran, and the answer is that this host
 * cannot do what was asked — so it exits 1 rather than 2. Exit 2 is for the case
 * where uvp could not look at all.
 */
export const doctorCommand: CommandSpec = {
  path: ["doctor"],
  tool: "uvp_doctor",
  summary: "Report the compiler, CMake, and libuvcpp build uvp found.",
  usage: "uvp doctor [--json] [--workspace PATH] [--features tls,websocket] [--provider ID]",
  flags: [
    {
      name: "workspace",
      type: "string",
      value: "PATH",
      description: "Also assess the feature set this workspace pins in uvp.json.",
    },
    {
      name: "features",
      type: "list",
      value: "LIST",
      description:
        "Assess these features instead of a workspace's: tls, http2, http3, grpc, websocket, soap, db.",
    },
    {
      name: "provider",
      type: "list",
      value: "ID",
      description: "Inspect only this toolchain provider. Repeat for several.",
    },
  ],
  notes: [
    "Every requested feature is reported with a verdict. `undetermined` means the build has no",
    "configuration switch for that feature, so it could not be decided from headers — that is an",
    "answer, not a missing one.",
  ],
  input: (parsed) => {
    const workspace = asString(parsed, "workspace");
    // `--features tls,websocket` and `--features tls --features websocket` are the
    // same request; the docs promise the comma form and the flag is repeatable.
    const features = parseCsv(asList(parsed, "features"));
    const providers = asList(parsed, "provider");
    return {
      ...(workspace === undefined ? {} : { workspace }),
      ...(features.length === 0 ? {} : { features }),
      ...(providers.length === 0 ? {} : { providers }),
    };
  },
  verdict: (output) => {
    const unavailable = list(output["toolchains"]).some(
      (entry) => bool(obj(entry)["available"]) !== true,
    );
    const noLibuvcpp = bool(obj(output["libuvcpp"])["found"]) !== true;
    const unmet = list(output["features"]).some((entry) => obj(entry)["status"] === "unmet");
    return unavailable || noLibuvcpp || unmet ? EXIT_NO : undefined;
  },
};
