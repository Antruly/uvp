import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { renderTemplate } from "./templates.js";
import type { TemplateId } from "./templates.js";
import { manifestOf, manifestProblemOf, readWorkspaceManifest } from "./workspaceManifest.js";
import type { UvpFeature } from "../domain/features.js";
import type { UvpFrontendSelection } from "../domain/frontends.js";
import type { UvpModule } from "../domain/modules.js";

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
 *
 * The other direction of the same claim is the rest of the file: the generator
 * writes a well-formed manifest, and the reader is also pointed at directories
 * nobody generated — a hand-edited `uvp.json`, a file whose fields have the
 * wrong types, a `uvp.json` that is not an object at all. The reader's rule there
 * is that every field is absent until it has been checked, so each of those has
 * to degrade to a *stated* answer — absent, a default, or a problem — rather
 * than to a wrong one. Those cases are written against the reader directly,
 * because a generator cannot produce them.
 *
 * The last group is about the read itself rather than about a field. "No file"
 * and "a file that could not be used" are different answers, and the second one
 * exists so that a workspace declaring a container build is never built on the
 * host because the declaration could not be parsed.
 *
 * The cases are grouped by the thing they are a claim about rather than by the
 * function that answers them, which is why the toolchain declaration is not
 * tested under the transport it has nothing to do with.
 */

/**
 * `title`, on the host where a mode bit does not stop a read.
 *
 * `chmod(0o000)` is how these cases produce an unreadable file; Windows has no
 * mode bits to withhold, so the case would assert a state the host cannot enter.
 */
const named = (title: string): string =>
  process.platform === "win32"
    ? `${title} — skipped: this host has no POSIX mode bits to make the file unreadable`
    : title;

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

/** Render a workspace to disk exactly as `uvp workspace create` would. */
const writeWorkspace = async (
  template: TemplateId,
  features: readonly UvpFeature[],
  modules?: readonly UvpModule[],
  frontends?: readonly UvpFrontendSelection[],
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "uvp-manifest-"));
  directories.push(root);
  const files = renderTemplate(template, {
    name: "svc",
    port: 8080,
    features,
    ...(modules === undefined ? {} : { modules }),
    ...(frontends === undefined ? {} : { frontends }),
  });
  for (const file of files) {
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
  return root;
};

/** An empty directory to point the reader at. */
const scratchRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "uvp-manifest-"));
  directories.push(root);
  return root;
};

/** A directory holding exactly this `uvp.json`, generator or not. */
const manifestRoot = async (manifest: unknown): Promise<string> => {
  const root = await scratchRoot();
  await writeFile(join(root, "uvp.json"), JSON.stringify(manifest));
  return root;
};

/**
 * The manifest the reader found, for the cases about its fields.
 *
 * The other state — a file that is there and could not be used — has its own
 * cases below, which read the result whole. Everywhere else the question is what
 * the fields mean, and "was there a file" is the setup rather than the subject.
 */
const manifestAt = async (root: string) => manifestOf(await readWorkspaceManifest(root));

describe("the transport a workspace declares", () => {
  it("is HTTPS for a workspace that declared tls", async () => {
    const manifest = await manifestAt(await writeWorkspace("hello-http", ["tls"]));
    expect(manifest?.scheme).toBe("https");
    expect(manifest?.features).toEqual(["tls"]);
  });

  it("is HTTP for the same workspace without it", async () => {
    const manifest = await manifestAt(await writeWorkspace("hello-http", ["http2", "websocket"]));
    expect(manifest?.scheme).toBe("http");
  });

  it("is HTTPS for tls alongside anything else", async () => {
    // `features` is a list, and the reader has to find `tls` in it rather than
    // look at its first element — which is how a workspace that declared
    // `["http2", "tls"]` would be read as cleartext and probed over the wrong
    // scheme by every caller downstream.
    const manifest = await manifestAt(await writeWorkspace("hello-http", ["http2", "tls"]));
    expect(manifest?.scheme).toBe("https");
  });

  it("is not stated by a manifest for a directory that has none", async () => {
    // No manifest is a distinguishable answer from a manifest that declares
    // cleartext, and it has to stay that way: the caller applies its own default
    // for a directory that is not a uvp workspace, and `absent` is how it knows
    // to.
    expect(await readWorkspaceManifest(await scratchRoot())).toStrictEqual({ state: "absent" });
  });
});

describe("the toolchain declaration", () => {
  it("reads a container toolchain and the image it names", async () => {
    const root = await manifestRoot({
      name: "svc",
      toolchain: { kind: "container", image: "localhost/uvp-base:12" },
    });
    const manifest = await manifestAt(root);
    expect(manifest?.toolchain).toEqual({ kind: "container", image: "localhost/uvp-base:12" });
    expect(manifest?.toolchainProblem).toBeUndefined();
  });

  it("reads a local toolchain that names nothing else as the local toolchain", async () => {
    // Present rather than a problem: this is the declaration whose two halves
    // agree, and it is what a workspace asks for when it wants to be built here.
    // Asserting the whole manifest rather than the field, because "no problem"
    // and "no key" are different claims and only one of them is this one.
    const root = await manifestRoot({ name: "svc", toolchain: { kind: "local" } });
    expect(await manifestAt(root)).toStrictEqual({
      name: "svc",
      scheme: "http",
      features: [],
      unrecognisedFeatures: [],
      unrecognisedModules: [],
      unrecognisedFrontends: [],
      toolchain: { kind: "local" },
      path: join(root, "uvp.json"),
    });
  });

  it("is not stated for a workspace that declares no toolchain", async () => {
    // Absent, not `local`: the reader reports what the file says, and "the file
    // does not say" is a different fact from "the file says this host". The
    // default is applied once, by the selection rule, to both cases alike.
    const manifest = await manifestAt(await writeWorkspace("hello-http", []));
    expect(manifest?.toolchain).toBeUndefined();
    expect(manifest?.toolchainProblem).toBeUndefined();
  });

  it.each([
    ["a value that is not an object", "container"],
    ["null", null],
    ["a kind that is not a name", { kind: "docker", image: "x" }],
    ["a kind that is not a string", { kind: 7 }],
    ["a local toolchain that also names an image", { kind: "local", image: "x" }],
    ["a local toolchain that names an empty image", { kind: "local", image: "" }],
    ["a container toolchain that names no image", { kind: "container" }],
  ])("reports %s as a problem rather than as a fallback", async (_label, toolchain) => {
    // The one field of this file that is an instruction rather than an
    // observation, so the one field whose malformed value must not degrade to a
    // default: the default available here is "build on this host", which is the
    // opposite of what a workspace that named an image asked for.
    //
    // The reason is asserted to *exist* rather than to *say this*. An empty one
    // is a refusal with nothing in it to act on, which is a real defect; a
    // reworded one is not, and a test that fails on a reworded message measures
    // the message. `errors.ts`'s two unreadable sentences are left unpinned for
    // the same reason — and `toBeTypeOf("string")` here would not do, because the
    // empty string is one.
    const manifest = await manifestAt(await manifestRoot({ name: "svc", toolchain }));
    expect(manifest?.toolchain).toBeUndefined();
    expect(manifest?.toolchainProblem).toBeTruthy();
  });

  it("names the value it found when the kind is not one it knows", async () => {
    // The reason is what a caller reports when it refuses to build, so it has to
    // carry the value that caused the refusal: a message saying only that the
    // kind is wrong sends the reader back to the file with nothing to look for.
    const root = await manifestRoot({ name: "svc", toolchain: { kind: "docker", image: "x" } });
    expect((await manifestAt(root))?.toolchainProblem).toContain("docker");
  });
});

describe("the feature list", () => {
  it("drops a feature it does not recognise without losing the rest", async () => {
    // A feature name is a promise about the generated code, so an unknown one is
    // reported rather than mapped to the nearest known one — and a feature that
    // *is* known must survive next to it, because the unknown one is not a
    // reason to forget what the workspace actually declared.
    const root = await manifestRoot({ name: "svc", features: ["tls", "quantum"], port: 8080 });
    const manifest = await manifestAt(root);
    expect(manifest?.features).toEqual(["tls"]);
    expect(manifest?.unrecognisedFeatures).toEqual(["quantum"]);
    expect(manifest?.scheme).toBe("https");
  });

  it.each([
    ["an absent `features`", { name: "svc" }],
    ["a `features` that is a string", { name: "svc", features: "tls" }],
    ["a `features` that is an object", { name: "svc", features: { 0: "tls" } }],
  ])(
    "reads %s as no features at all, and reports none as unrecognised",
    async (_label, manifest) => {
      // The fallback is an empty list, and a placeholder in it would land in
      // `unrecognisedFeatures` — the list a caller shows the user — so both lists
      // are asserted, not just the one the placeholder is not in.
      const read = await manifestAt(await manifestRoot(manifest));
      expect(read?.features).toStrictEqual([]);
      expect(read?.unrecognisedFeatures).toStrictEqual([]);
      expect(read?.scheme).toBe("http");
    },
  );

  it("skips a feature list entry that is not a name, rather than reporting it", async () => {
    // An entry that is not a string is not a name the workspace declared, so it
    // is not an unrecognised name either: reporting `7` would put a number in a
    // list of strings and hand a caller something it cannot print as a feature.
    const root = await manifestRoot({
      name: "svc",
      features: ["tls", 7, null, ["quantum"], "quantum"],
    });
    const read = await manifestAt(root);
    expect(read?.features).toStrictEqual(["tls"]);
    expect(read?.unrecognisedFeatures).toStrictEqual(["quantum"]);
    expect(read?.scheme).toBe("https");
  });
});

describe("the module list", () => {
  it("round-trips a selection the generator recorded", async () => {
    const root = await writeWorkspace("websocket-test", ["websocket"], ["health", "echo-log"]);
    const manifest = await manifestAt(root);
    expect(manifest?.modules).toEqual(["health", "echo-log"]);
    expect(manifest?.unrecognisedModules).toEqual([]);
  });

  it("reads an absent field as the template's default rather than as none", async () => {
    // `--modules` was not passed, so the field is not written: the generated
    // source composes the template's default, and "absent" has to stay
    // distinguishable from an explicit empty selection.
    const root = await writeWorkspace("websocket-test", ["websocket"]);
    const manifest = await manifestAt(root);
    expect(manifest?.modules).toBeUndefined();
    expect(manifest?.unrecognisedModules).toStrictEqual([]);
  });

  it("keeps a manifest written before modules existed valid", async () => {
    const read = await readWorkspaceManifest(await manifestRoot({ name: "svc" }));
    expect(read.state).toBe("read");
    const manifest = manifestOf(read);
    expect(manifest?.modules).toBeUndefined();
    expect(manifest?.unrecognisedModules).toStrictEqual([]);
  });

  it("reports an unknown module name beside the ones it kept", async () => {
    const manifest = await manifestAt(
      await manifestRoot({
        name: "svc",
        template: "websocket-test",
        modules: ["health", "quantum"],
      }),
    );
    expect(manifest?.modules).toEqual(["health"]);
    expect(manifest?.unrecognisedModules).toEqual(["quantum"]);
  });

  it("keeps an explicitly empty selection distinct from an absent one", async () => {
    const manifest = await manifestAt(await manifestRoot({ name: "svc", modules: [] }));
    expect(manifest?.modules).toStrictEqual([]);
  });

  it.each([
    ["a `modules` that is a string", { name: "svc", modules: "health" }],
    ["a `modules` entry that is not a string", { name: "svc", modules: ["health", 7] }],
  ])("refuses %s rather than answering a composition it did not read", async (_label, body) => {
    // Folding a malformed declaration into "absent" would answer the template
    // default on behalf of a file that said something else.
    const read = await readWorkspaceManifest(await manifestRoot(body));
    expect(read.state).toBe("unreadable");
    expect(manifestProblemOf(read)).toContain("modules");
  });
});

describe("the static frontend list", () => {
  it("round-trips the selection the generator recorded", async () => {
    const root = await writeWorkspace("hello-http", [], undefined, ["h5-tech", "h5-minimal"]);
    const manifest = await manifestAt(root);
    expect(manifest?.frontends).toEqual(["h5-minimal", "h5-tech"]);
    expect(manifest?.unrecognisedFrontends).toEqual([]);
  });

  it("reads an absent field as no skin rather than as a template default", async () => {
    const manifest = await manifestAt(await writeWorkspace("hello-http", []));
    expect(manifest?.frontends).toBeUndefined();
    expect(manifest?.unrecognisedFrontends).toStrictEqual([]);
  });

  it("keeps an explicitly empty selection distinct from an absent one", async () => {
    const manifest = await manifestAt(await manifestRoot({ name: "svc", frontends: [] }));
    expect(manifest?.frontends).toStrictEqual([]);
  });

  it("round-trips a frontend app, which is generated rather than served from public/", async () => {
    const root = await writeWorkspace("hello-http", [], undefined, ["vue3"]);
    const manifest = await manifestAt(root);
    expect(manifest?.frontends).toEqual(["vue3"]);
    expect(manifest?.unrecognisedFrontends).toEqual([]);
  });

  it("reports an unknown frontend beside the ones it kept", async () => {
    const manifest = await manifestAt(
      await manifestRoot({ name: "svc", frontends: ["h5-tech", "angular"] }),
    );
    expect(manifest?.frontends).toEqual(["h5-tech"]);
    expect(manifest?.unrecognisedFrontends).toEqual(["angular"]);
  });

  it("keeps a package-only framework name unrecognised", async () => {
    // `alpine` and `h5` are names a package may declare, not selections `uvp
    // init` can generate. A manifest naming one is reported, not accepted as a
    // frontend with no files behind it.
    const manifest = await manifestAt(await manifestRoot({ name: "svc", frontends: ["alpine"] }));
    expect(manifest?.frontends).toEqual([]);
    expect(manifest?.unrecognisedFrontends).toEqual(["alpine"]);
  });

  it.each([
    ["a `frontends` that is a string", { name: "svc", frontends: "h5-tech" }],
    ["a `frontends` entry that is not a string", { name: "svc", frontends: ["h5-tech", 7] }],
  ])("refuses %s rather than answering that no skin was generated", async (_label, body) => {
    // Absent means "no skin". Folding a malformed declaration into that would
    // describe a workspace as having no page when its file says it has one.
    const read = await readWorkspaceManifest(await manifestRoot(body));
    expect(read.state).toBe("unreadable");
    expect(manifestProblemOf(read)).toContain("frontends");
  });
});

describe("the evidence payload policy", () => {
  it("round-trips the policy the generator compiled into the source", async () => {
    const root = await writeWorkspace("hello-http", [], ["evidence-log"]);
    const manifest = await manifestAt(root);
    expect(manifest?.evidence).toEqual({ payloads: "summary" });
  });

  it("keeps a manifest that records no evidence policy valid", async () => {
    const manifest = await manifestAt(await manifestRoot({ name: "svc" }));
    expect(manifest?.evidence).toBeUndefined();
  });

  it.each([
    ["an `evidence` that is not an object", { name: "svc", evidence: "summary" }],
    ["an unknown policy", { name: "svc", evidence: { payloads: "retain-all" } }],
    ["an `evidence` with no policy", { name: "svc", evidence: {} }],
  ])("refuses %s rather than assuming the default", async (_label, body) => {
    // The default is a fact about what the source was generated with. Answering
    // it for a file that declared something else would describe collection that
    // may not have happened the way the file says.
    const read = await readWorkspaceManifest(await manifestRoot(body));
    expect(read.state).toBe("unreadable");
    expect(manifestProblemOf(read)).toContain("evidence");
  });
});

describe("the fields a manifest carries", () => {
  it("reads every field it states, and derives the transport from the features", async () => {
    const root = await manifestRoot({
      name: "svc",
      binary: "svc-server",
      port: 8080,
      template: "hello-http",
      features: ["tls", "quantum"],
      requirements: { libuvcpp: "1.7.0" },
      toolchain: { kind: "container", image: "localhost/uvp-base:12" },
    });
    expect(await manifestAt(root)).toStrictEqual({
      name: "svc",
      binary: "svc-server",
      port: 8080,
      template: "hello-http",
      scheme: "https",
      features: ["tls"],
      unrecognisedFeatures: ["quantum"],
      unrecognisedModules: [],
      unrecognisedFrontends: [],
      requiredLibuvcpp: "1.7.0",
      toolchain: { kind: "container", image: "localhost/uvp-base:12" },
      path: join(root, "uvp.json"),
    });
  });

  it("carries no key for a field the file did not state", async () => {
    // `toStrictEqual` rather than `toEqual`, and that is load-bearing: the one
    // difference between them is a key that is present with the value
    // `undefined`, which is a claim the file did not make. A port of `undefined`
    // and no port at all are different facts about a workspace, and every
    // optional field here is spread only when it holds a value.
    const root = await manifestRoot({ name: "svc" });
    expect(await manifestAt(root)).toStrictEqual({
      name: "svc",
      scheme: "http",
      features: [],
      unrecognisedFeatures: [],
      unrecognisedModules: [],
      unrecognisedFrontends: [],
      path: join(root, "uvp.json"),
    });
  });

  it("reads an empty string as a field that was not stated", async () => {
    // `""` is not a name, an image or a version, and reporting it as one is how a
    // caller ends up with a binary called the empty string.
    const root = await manifestRoot({
      name: "svc",
      binary: "",
      template: "",
      requirements: { libuvcpp: "" },
    });
    expect(await manifestAt(root)).toStrictEqual({
      name: "svc",
      scheme: "http",
      features: [],
      unrecognisedFeatures: [],
      unrecognisedModules: [],
      unrecognisedFrontends: [],
      path: join(root, "uvp.json"),
    });
  });

  it("reads a field of the wrong type as a field that was not stated", async () => {
    // The name falls back to its default for the same reason the others vanish:
    // `7` is not a name, and a workspace called `7` is a wrong answer where
    // `app` is the documented one.
    const root = await manifestRoot({
      name: 7,
      binary: 7,
      port: "8080",
      template: [],
      requirements: { libuvcpp: 7 },
    });
    expect(await manifestAt(root)).toStrictEqual({
      name: "app",
      scheme: "http",
      features: [],
      unrecognisedFeatures: [],
      unrecognisedModules: [],
      unrecognisedFrontends: [],
      path: join(root, "uvp.json"),
    });
  });

  it("reads a port only when it is a whole number", async () => {
    // `8080.5` passes `typeof port === "number"` and is still not a port: reading
    // it as one hands every downstream consumer a number no listener can bind.
    const root = await manifestRoot({ name: "svc", port: 8080.5 });
    expect(await manifestAt(root)).toStrictEqual({
      name: "svc",
      scheme: "http",
      features: [],
      unrecognisedFeatures: [],
      unrecognisedModules: [],
      unrecognisedFrontends: [],
      path: join(root, "uvp.json"),
    });
  });

  it("reads the libuvcpp requirement from `requirements` and not from the top level", async () => {
    const root = await manifestRoot({
      name: "svc",
      libuvcpp: "9.9.9",
      requirements: "libuvcpp: 1.7.0",
    });
    expect((await manifestAt(root))?.requiredLibuvcpp).toBeUndefined();
  });

  it("falls back to the name `app` for a manifest that states none", async () => {
    const root = await manifestRoot({ features: ["websocket"] });
    expect((await manifestAt(root))?.name).toBe("app");
  });
});

describe("a manifest that is not an object", () => {
  it.each([
    ["null", null],
    ["an array", []],
    ["a number", 42],
    ["a string", "hello"],
  ])("reads %s as a file that cannot be used, not as no file", async (_label, contents) => {
    // `JSON.parse` accepts all four, so the record check is the only thing
    // standing between them and a manifest built out of nothing: every field read
    // after it answers `undefined` for an array, so without the check a directory
    // holding `[]` would answer as a cleartext workspace named `app`. With the
    // check it is `unreadable` rather than `absent`, because the file is there
    // and saying something this reader does not understand.
    const root = await scratchRoot();
    await writeFile(join(root, "uvp.json"), JSON.stringify(contents));
    const read = await readWorkspaceManifest(root);
    expect(read.state).toBe("unreadable");
    expect(manifestProblemOf(read)).toContain("not a JSON object");
  });
});

describe("a file that is there and cannot be used", () => {
  it("reports invalid JSON as unreadable rather than as no manifest", async () => {
    // The whole reason the reader has three states: this directory declares a
    // container build, the file is truncated, and a reader that answered
    // `undefined` would hand every caller "declares nothing" — which is the
    // fallback that builds a container workspace on this host.
    const root = await scratchRoot();
    await writeFile(join(root, "uvp.json"), '{"toolchain": {"kind": "container"');
    const read = await readWorkspaceManifest(root);
    expect(read.state).toBe("unreadable");
    expect(manifestProblemOf(read)).toContain("is not valid JSON");
    expect(manifestOf(read)).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    named("reports a file it may not read as unreadable, naming the failure"),
    async () => {
      const root = await scratchRoot();
      const path = join(root, "uvp.json");
      await writeFile(path, '{"name": "svc"}');
      await chmod(path, 0o000);
      try {
        const read = await readWorkspaceManifest(root);
        expect(read.state).toBe("unreadable");
        expect(manifestProblemOf(read)).toContain("may not read it");
      } finally {
        await chmod(path, 0o644);
      }
    },
  );

  it("leaves the file name in the problem, so the refusal can name what to repair", async () => {
    const root = await scratchRoot();
    await writeFile(join(root, "uvp.json"), "not json");
    expect(manifestProblemOf(await readWorkspaceManifest(root))).toContain("uvp.json");
  });
});
