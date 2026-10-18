import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { renderTemplate } from "../../src/application/templates.js";
import { sha256 } from "../../src/domain/identity.js";
import { EXE } from "../../src/toolchains/host.js";
import {
  realLibuvcpp,
  resultOrThrow,
  runCli,
  scratch,
  skipReason,
  startService,
} from "../support/realLibuvcpp.js";

/**
 * A template package, end to end against a real toolchain.
 *
 * The source and CLI lanes prove the package is parsed, stored, searched, and
 * rendered. This lane answers the question none of them can: does a workspace
 * generated from a package build with the CMake and libuvcpp on this host?
 *
 * The package is derived from the built-in `hello-http` template so the C++ is
 * known-good; the test replaces the project name and port with the v1
 * placeholders, imports the package, initializes a workspace, and builds it.
 * The generated workspace's build is the evidence the package format promises.
 */

const guard = realLibuvcpp === undefined ? skipReason : "";
const PORT = 8093;
const NAME = "pkgfixture";

describe.skipIf(guard !== "")("a template package", () => {
  it("imports, generates, and builds a workspace from a package", async () => {
    const root = scratch();
    const store = join(root, "store");
    const packageDir = join(root, "package");
    const workspace = join(root, "workspace");

    const generated = renderTemplate("hello-http", {
      name: NAME,
      port: PORT,
      features: [],
      modules: [],
      frontends: [],
    }).filter(
      (file) => file.path !== "uvp.json" && file.path !== "README.md" && file.path !== ".gitignore",
    );

    const files: { path: string; digest: string; bytes: number }[] = [];
    for (const file of generated) {
      const content = file.content
        .split(NAME)
        .join("{{project.name}}")
        .split(String(PORT))
        .join("{{project.port}}");
      const target = join(packageDir, "files", file.path);
      await mkdir(dirname(target), { recursive: true });
      const bytes = Buffer.from(content, "utf8");
      await writeFile(target, bytes);
      files.push({ path: file.path, digest: `sha256:${sha256(bytes)}`, bytes: bytes.byteLength });
    }

    await writeFile(
      join(packageDir, "template.json"),
      JSON.stringify({
        schema: "uvp.template/1",
        id: "fixture-package",
        version: "1.0.0",
        name: "Fixture package",
        category: "backend",
        files,
        license: { spdx: "MIT", file: "LICENSE" },
        provenance: { author: "uvp tests", createdAt: "2026-10-18T00:00:00Z" },
        requires: { libuvcpp: ">=1.7.0" },
        routes: ["GET /hello"],
      }),
    );
    await writeFile(join(packageDir, "README.md"), "# Fixture package\n");
    await writeFile(join(packageDir, "LICENSE"), "MIT\n");

    const env = { UVP_TEMPLATE_HOME: store };
    const imported = resultOrThrow(
      await runCli(["template", "import", packageDir, "--json"], { env }),
    );
    expect(imported["id"]).toBe("fixture-package");

    const initialized = resultOrThrow(
      await runCli(
        [
          "init",
          workspace,
          "--name",
          NAME,
          "--template-package",
          "fixture-package@1.0.0",
          "--port",
          String(PORT),
          "--json",
        ],
        { env },
      ),
    );
    expect(initialized["template_package"]).toMatchObject({
      id: "fixture-package",
      version: "1.0.0",
    });
    expect(initialized["routes"]).toEqual(["GET /hello"]);
    expect(await readFile(join(workspace, "CMakeLists.txt"), "utf8")).toContain(NAME);
    const manifest = JSON.parse(await readFile(join(workspace, "uvp.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(manifest["port"]).toBe(PORT);
    expect(manifest["requirements"]).toEqual({ libuvcpp: ">=1.7.0" });
    expect(manifest["template_package"]).toMatchObject({
      id: "fixture-package",
      version: "1.0.0",
    });

    const built = resultOrThrow(await runCli(["build", workspace, "--json"]));
    expect(built["succeeded"]).toBe(true);

    const service = await startService({
      name: NAME,
      template: "fixture-package",
      port: PORT,
      root: workspace,
      buildDir: join(workspace, "build"),
      binary: join(workspace, "build", NAME + EXE),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${String(PORT)}/hello`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Hello, AI");
    } finally {
      await service.stop();
    }
  }, 600_000);
});
