import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { renderTemplate } from "./templates.js";
import type { TemplateId } from "./templates.js";
import { readWorkspaceManifest } from "./workspaceManifest.js";
import type { UvpFeature } from "../domain/features.js";

/**
 * What a manifest means, checked against what a workspace writes.
 *
 * `readWorkspaceManifest` is the one owner of this file's meaning, so the
 * interesting question is not "does it parse JSON" but "does the thing the
 * generator writes mean what the reader says it means". The two halves of that
 * are tested as one round trip here, because they are one claim: the generator
 * writes `features`, and the reader derives the transport from it, so a
 * workspace that reaches its own service over HTTPS has to be readable as HTTPS
 * by the code that probes it.
 *
 * The transport is deliberately *derived* rather than stored. A manifest that
 * carried a `scheme` field could state it differently from the feature list
 * right next to it, and the feature list is what `uvp doctor --workspace`
 * already answers from.
 */

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

/** Render a workspace to disk exactly as `uvp workspace create` would. */
const writeWorkspace = async (
  template: TemplateId,
  features: readonly UvpFeature[],
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "uvp-manifest-"));
  directories.push(root);
  for (const file of renderTemplate(template, { name: "svc", port: 8080, features })) {
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
  return root;
};

describe("the transport a workspace declares", () => {
  it("is HTTPS for a workspace that declared tls", async () => {
    const manifest = await readWorkspaceManifest(await writeWorkspace("hello-http", ["tls"]));
    expect(manifest?.scheme).toBe("https");
    expect(manifest?.features).toEqual(["tls"]);
  });

  it("is HTTP for the same workspace without it", async () => {
    const manifest = await readWorkspaceManifest(
      await writeWorkspace("hello-http", ["http2", "websocket"]),
    );
    expect(manifest?.scheme).toBe("http");
  });

  it("is HTTPS for tls alongside anything else", async () => {
    // `features` is a list, and the reader has to find `tls` in it rather than
    // look at its first element — which is how a workspace that declared
    // `["http2", "tls"]` would be read as cleartext and probed over the wrong
    // scheme by every caller downstream.
    const manifest = await readWorkspaceManifest(
      await writeWorkspace("hello-http", ["http2", "tls"]),
    );
    expect(manifest?.scheme).toBe("https");
  });

  it("is not stated by a manifest for a directory that has none", async () => {
    // No manifest is a distinguishable answer from a manifest that declares
    // cleartext, and it has to stay that way: the caller applies its own default
    // for a directory that is not a uvp workspace, and `undefined` is how it
    // knows to.
    const root = await mkdtemp(join(tmpdir(), "uvp-manifest-"));
    directories.push(root);
    expect(await readWorkspaceManifest(root)).toBeUndefined();
  });

  it("drops a feature it does not recognise without losing the rest", async () => {
    // A feature name is a promise about the generated code, so an unknown one is
    // reported rather than mapped to the nearest known one — and a feature that
    // *is* known must survive next to it, because the unknown one is not a
    // reason to forget what the workspace actually declared.
    const root = await writeWorkspace("hello-http", ["tls"]);
    await writeFile(
      join(root, "uvp.json"),
      JSON.stringify({ name: "svc", features: ["tls", "quantum"], port: 8080 }),
    );
    const manifest = await readWorkspaceManifest(root);
    expect(manifest?.features).toEqual(["tls"]);
    expect(manifest?.unrecognisedFeatures).toEqual(["quantum"]);
    expect(manifest?.scheme).toBe("https");
  });
});
