import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { UvpFailure } from "../domain/errors.js";
import type { StoredTemplatePackage } from "./TemplateStore.js";
import type { StoredTemplatePackageFile, StoredTemplatePackageSource } from "./TemplateStore.js";
import { renderTemplatePackageWorkspace } from "./TemplatePackageRender.js";

/**
 * Rendering a stored package into a workspace.
 *
 * The store and the manifest validator already own the questions "is this
 * package well formed" and "does the tree match the manifest". This file asks
 * the narrower question the render step adds: given bytes that passed those
 * checks, does the workspace get exactly those files, with the v1 placeholders
 * substituted in text and nothing else rewritten?
 *
 * The interesting cases are the ones where a reasonable-looking shortcut is
 * wrong: substituting inside a PNG, replacing `{{features}}` with a
 * human-readable list instead of the manifest's spelling, keeping the package's
 * `template` field beside `template_package`, or reporting routes the package
 * never declared.
 */

const DIGEST = `sha256:${"a".repeat(64)}`;

const storedPackage = (overrides: Partial<StoredTemplatePackage> = {}): StoredTemplatePackage => ({
  id: "acme-dashboard",
  version: "1.2.0",
  name: "Acme dashboard",
  category: "fullstack",
  digest: DIGEST,
  files: [],
  unverified: false,
  path: "/tmp/store/acme-dashboard/1.2.0",
  ...overrides,
});

const source = (
  files: readonly StoredTemplatePackageFile[],
  overrides: Partial<StoredTemplatePackage> = {},
): StoredTemplatePackageSource => ({ package: storedPackage(overrides), files });

const textFile = (path: string, text: string): StoredTemplatePackageFile => ({
  path,
  bytes: Buffer.from(text, "utf8"),
});

const binaryFile = (path: string, bytes: readonly number[]): StoredTemplatePackageFile => ({
  path,
  bytes: Uint8Array.from(bytes),
});

const contentOf = (
  rendered: ReturnType<typeof renderTemplatePackageWorkspace>,
  path: string,
): Uint8Array => {
  const file = rendered.files.find((entry) => entry.path === path);
  if (file === undefined) {
    throw new Error(
      `no rendered file ${path}; got ${rendered.files.map((f) => f.path).join(", ")}`,
    );
  }
  return file.content;
};

const textOf = (
  rendered: ReturnType<typeof renderTemplatePackageWorkspace>,
  path: string,
): string => Buffer.from(contentOf(rendered, path)).toString("utf8");

describe("placeholders", () => {
  it("substitutes the three v1 placeholders in every text file", () => {
    const rendered = renderTemplatePackageWorkspace({
      source: source(
        [
          textFile(
            "src/main.cpp",
            'const char *name = "{{project.name}}";\nconst int port = {{project.port}};\n',
          ),
          textFile("README.md", "{{project.name}} serves {{features}}.\n"),
        ],
        { requires: { features: ["websocket", "tls"] } },
      ),
      name: "svc",
      port: 8080,
    });

    expect(textOf(rendered, "src/main.cpp")).toContain('"svc"');
    expect(textOf(rendered, "src/main.cpp")).toContain("port = 8080;");
    // Comma-separated in the manifest's order: a package author maps the text
    // back to `requires.features`, and a generated list keeps that order.
    expect(textOf(rendered, "README.md")).toBe("svc serves websocket,tls.\n");
  });

  it("renders an empty features placeholder when the manifest declares none", () => {
    const rendered = renderTemplatePackageWorkspace({
      source: source([textFile("build.sh", "features: [{{features}}]\n")]),
      name: "svc",
      port: 8080,
    });
    expect(textOf(rendered, "build.sh")).toBe("features: []\n");
  });

  it("copies a file that is not UTF-8 byte for byte", () => {
    // Every one of these bytes is either invalid UTF-8 or a control byte whose
    // decoding would not round-trip; a renderer that ran the substitution over
    // text-decoded bytes would corrupt the image it cannot read.
    const bytes = [0xff, 0xd8, 0xff, 0x00, 0x01, 0x02, 0x7b, 0x7b];
    const rendered = renderTemplatePackageWorkspace({
      source: source([binaryFile("assets/logo.png", bytes)]),
      name: "svc",
      port: 8080,
    });
    expect([...contentOf(rendered, "assets/logo.png")]).toEqual(bytes);
  });

  it("keeps a UTF-8 BOM so re-encoding does not silently drop it", () => {
    const withBom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("{{project.name}}\n", "utf8"),
    ]);
    const rendered = renderTemplatePackageWorkspace({
      source: source([{ path: "src/main.cpp", bytes: withBom }]),
      name: "svc",
      port: 8080,
    });
    expect(Array.from(contentOf(rendered, "src/main.cpp").slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(textOf(rendered, "src/main.cpp")).toBe("﻿svc\n");
  });
});

describe("the workspace manifest", () => {
  it("synthesises uvp.json when the package ships none", () => {
    const rendered = renderTemplatePackageWorkspace({
      source: source([textFile("src/main.cpp", "int main() { return 0; }\n")], {
        requires: { features: ["websocket"], libuvcpp: ">=1.7.0" },
      }),
      name: "svc",
      port: 8080,
    });

    const manifest = JSON.parse(textOf(rendered, "uvp.json")) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      uvp: 1,
      name: "svc",
      binary: "svc",
      port: 8080,
      features: ["websocket"],
      requirements: { libuvcpp: ">=1.7.0" },
      template_package: { id: "acme-dashboard", version: "1.2.0", digest: DIGEST },
    });
    expect(manifest).not.toHaveProperty("template");
    expect(rendered.binary).toBe("svc");
  });

  it("keeps a package's own manifest fields and replaces only the selector", () => {
    const rendered = renderTemplatePackageWorkspace({
      source: source([
        textFile(
          "uvp.json",
          JSON.stringify({
            uvp: 1,
            name: "dashboard",
            template: "hello-http",
            binary: "dashboard-svc",
            port: 9000,
            features: ["tls"],
            evidence: { payloads: "verbatim" },
          }),
        ),
      ]),
      name: "dashboard",
      port: 9000,
    });

    const manifest = JSON.parse(textOf(rendered, "uvp.json")) as Record<string, unknown>;
    expect(manifest).not.toHaveProperty("template");
    expect(manifest["binary"]).toBe("dashboard-svc");
    expect(manifest["port"]).toBe(9000);
    expect(manifest["evidence"]).toEqual({ payloads: "verbatim" });
    expect(manifest["template_package"]).toEqual({
      id: "acme-dashboard",
      version: "1.2.0",
      digest: DIGEST,
    });
    // `uvp run` names the same binary the manifest does, not the project name.
    expect(rendered.binary).toBe("dashboard-svc");
  });

  it("falls back from a missing binary to the package name, then the project name", () => {
    const namedPackage = renderTemplatePackageWorkspace({
      source: source([textFile("uvp.json", JSON.stringify({ uvp: 1, name: "acme" }))], {
        name: "Acme dashboard",
      }),
      name: "svc",
      port: 8080,
    });
    expect(namedPackage.binary).toBe("acme");

    const unnamed = renderTemplatePackageWorkspace({
      source: source([textFile("uvp.json", JSON.stringify({ uvp: 1 }))], { name: "" }),
      name: "svc",
      port: 8080,
    });
    expect(unnamed.binary).toBe("svc");
  });

  it.each([
    ["invalid JSON", "not json"],
    ["a JSON array", "[]"],
    ["a JSON string", '"manifest"'],
  ])("refuses %s in the package's uvp.json", (_label, text) => {
    let caught: unknown;
    try {
      renderTemplatePackageWorkspace({
        source: source([textFile("uvp.json", text)]),
        name: "svc",
        port: 8080,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UvpFailure);
    expect((caught as UvpFailure).detail.code).toBe("invalid_request");
  });

  it("refuses a uvp.json that is not UTF-8 text", () => {
    let caught: unknown;
    try {
      renderTemplatePackageWorkspace({
        source: source([binaryFile("uvp.json", [0xff, 0x00])]),
        name: "svc",
        port: 8080,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UvpFailure);
    expect((caught as UvpFailure).detail.code).toBe("invalid_request");
    expect((caught as Error).message).toContain("not UTF-8");
  });
});

describe("routes", () => {
  it("returns exactly the declared routes", () => {
    const rendered = renderTemplatePackageWorkspace({
      source: source([textFile("src/main.cpp", "int main() { return 0; }\n")], {
        routes: ["GET /healthz", "WS /echo"],
      }),
      name: "svc",
      port: 8080,
    });
    expect(rendered.routes).toEqual(["GET /healthz", "WS /echo"]);
    expect(rendered.routesLimitation).toBeUndefined();
  });

  it("reports an absent declaration as a limitation, not as an inspected list", () => {
    const rendered = renderTemplatePackageWorkspace({
      source: source([textFile("src/main.cpp", "int main() { return 0; }\n")]),
      name: "svc",
      port: 8080,
    });
    expect(rendered.routes).toEqual([]);
    // The wording is the answer the caller reports: an empty list alone would
    // read as "the service registers nothing", which nobody checked.
    expect(rendered.routesLimitation).toBe("The package declares no routes.");
  });

  it("keeps an explicit empty declaration distinct from an absent one", () => {
    const rendered = renderTemplatePackageWorkspace({
      source: source([textFile("src/main.cpp", "int main() { return 0; }\n")], { routes: [] }),
      name: "svc",
      port: 8080,
    });
    expect(rendered.routes).toEqual([]);
    expect(rendered.routesLimitation).toBeUndefined();
  });
});
