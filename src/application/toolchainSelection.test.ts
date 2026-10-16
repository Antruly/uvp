import { describe, expect, it } from "vitest";

import { selectToolchain } from "./toolchainSelection.js";
import type { WorkspaceManifest } from "./workspaceManifest.js";
import { toUvpError } from "../domain/errors.js";

/**
 * The rule that decides where a build happens, tested where it is written.
 *
 * Every case here is one a caller can reach through either adapter, and the
 * interesting ones are the refusals rather than the selections: a rule that
 * answers "local" whenever it is unsure is a rule that starts a compiler on
 * somebody's host after they said not to, and that is a plausible-looking
 * implementation rather than an obviously wrong one.
 */

/** A manifest with everything this rule reads, and nothing else. */
const base = {
  name: "svc",
  scheme: "http",
  features: [],
  unrecognisedFeatures: [],
  path: "/w/svc/uvp.json",
} as const satisfies Omit<WorkspaceManifest, "toolchain" | "toolchainProblem">;

const manifestDeclaring = (toolchain: WorkspaceManifest["toolchain"]): WorkspaceManifest => ({
  ...base,
  ...(toolchain === undefined ? {} : { toolchain }),
});

/** The same, for a file whose `toolchain` field could not be read. */
const manifestWithProblem = (problem: string): WorkspaceManifest => ({
  ...base,
  toolchainProblem: problem,
});

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (cause) {
    return toUvpError(cause).code;
  }
  throw new Error("expected a refusal and got a selection");
};

describe("which toolchain a call uses", () => {
  it("defaults to this host when the workspace says nothing", () => {
    expect(selectToolchain({})).toEqual({ kind: "local" });
    expect(selectToolchain({ manifest: manifestDeclaring(undefined) })).toEqual({ kind: "local" });
  });

  it("uses the image the workspace named, with nothing else asked for", () => {
    const manifest = manifestDeclaring({ kind: "container", image: "localhost/base:12" });
    expect(selectToolchain({ manifest })).toEqual({
      kind: "container",
      image: "localhost/base:12",
    });
  });

  it("lets a call refuse the container its workspace asked for", () => {
    // The override that exists, and it only ever goes one way.
    const manifest = manifestDeclaring({ kind: "container", image: "localhost/base:12" });
    expect(selectToolchain({ manifest, requested: "local" })).toEqual({ kind: "local" });
  });

  it("refuses a call that insists on a container nothing named an image for", () => {
    // `container` from a caller is a demand, not a designation: this is the case
    // that keeps an image from being chosen by a flag.
    expect(codeOf(() => selectToolchain({ requested: "container" }))).toBe("missing_requirement");
    expect(
      codeOf(() =>
        selectToolchain({ manifest: manifestDeclaring({ kind: "local" }), requested: "container" }),
      ),
    ).toBe("missing_requirement");
  });

  it("accepts a call that insists on the container the workspace named", () => {
    const manifest = manifestDeclaring({ kind: "container", image: "localhost/base:12" });
    expect(selectToolchain({ manifest, requested: "container" })).toEqual({
      kind: "container",
      image: "localhost/base:12",
    });
  });

  it("refuses a declaration it could not read, rather than building locally", () => {
    // The whole reason the manifest reports a problem instead of dropping the
    // field. Falling back here would be a build on this host for a workspace
    // that asked for an image, which is the wrong answer presented as success.
    const manifest = manifestWithProblem("`toolchain` asks for a container and names no image.");
    expect(codeOf(() => selectToolchain({ manifest }))).toBe("invalid_request");
  });

  it("refuses the same declaration even when the call asked for local", () => {
    // A call cannot paper over a file it did not write: `local` says where *this*
    // call wants to build, and a workspace whose instruction is unreadable is a
    // workspace nobody can answer for, whichever way the call leans.
    const manifest = manifestWithProblem(
      "`toolchain.kind` is undefined rather than one of local, container.",
    );
    expect(codeOf(() => selectToolchain({ manifest, requested: "local" }))).toBe("invalid_request");
  });

  it("names the file it refused", () => {
    const manifest = manifestWithProblem("`toolchain` is present and is not an object.");
    try {
      selectToolchain({ manifest });
      throw new Error("expected a refusal");
    } catch (cause) {
      expect(toUvpError(cause).message).toContain("/w/svc/uvp.json");
    }
  });
});
