import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  TemplateStoreError,
  getTemplatePackage,
  importTemplatePackage,
  listTemplatePackages,
  removeTemplatePackage,
  resolveTemplateStoreRoot,
} from "./TemplateStore.js";

/**
 * The local store is the half of #236 that writes bytes: the domain validator
 * says what a package means, and these tests say what the store does with a
 * directory that passed (or failed) it. The failure direction matters most —
 * an import that cannot finish must leave no package, a replace that cannot
 * rename must not lose the old tree, and a read of a tampered package must not
 * report the manifest's claim as an observation.
 */

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const temporaryRoot = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
};

const DEFAULT_CONTENT = "int main() { return 0; }\n";

interface Fixture {
  readonly dir: string;
  readonly manifest: Record<string, unknown>;
  readonly content: string;
}

const makePackage = async ({
  overrides = {},
  content = DEFAULT_CONTENT,
}: {
  readonly overrides?: Record<string, unknown>;
  readonly content?: string;
} = {}): Promise<Fixture> => {
  const base = await temporaryRoot("uvp-template-source-");
  const dir = path.join(base, "package");
  await mkdir(path.join(dir, "files", "src"), { recursive: true });
  await writeFile(path.join(dir, "files", "src", "main.cc"), content);
  const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  const baseManifest: Record<string, unknown> = {
    schema: "uvp.template/1",
    id: "acme-dashboard",
    version: "1.2.0",
    name: "Acme dashboard",
    category: "fullstack",
    files: [{ path: "src/main.cc", digest, bytes: Buffer.byteLength(content) }],
    license: { spdx: "MIT", file: "LICENSE" },
    provenance: { author: "Acme", createdAt: "2026-10-18T00:00:00Z" },
  };
  const manifest: Record<string, unknown> = { ...baseManifest, ...overrides };
  for (const key of ["license", "provenance"] as const) {
    if (manifest[key] === null) delete manifest[key];
  }
  await writeFile(path.join(dir, "template.json"), JSON.stringify(manifest));
  await writeFile(path.join(dir, "README.md"), "# Acme\n");
  await writeFile(path.join(dir, "LICENSE"), "MIT\n");
  return { dir, manifest, content };
};

const makeStore = async (): Promise<string> => {
  const root = await temporaryRoot("uvp-template-store-");
  return path.join(root, "store");
};

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof TemplateStoreError ? error.code : (error as { code?: string }).code;
  }
};

describe("the template store root", () => {
  it("uses UVP_TEMPLATE_HOME when it is set", async () => {
    const configured = await temporaryRoot("uvp-template-home-");
    expect(resolveTemplateStoreRoot({ UVP_TEMPLATE_HOME: configured }, "/home/me")).toBe(
      path.resolve(configured),
    );
  });

  it("falls back to ~/.uvp/templates and ignores an empty setting", () => {
    expect(resolveTemplateStoreRoot({ UVP_TEMPLATE_HOME: "" }, "/home/me")).toBe(
      path.resolve(path.join("/home/me", ".uvp", "templates")),
    );
  });
});

describe("importing and reading a package", () => {
  it("imports a valid package, reads it back, and lists it", async () => {
    const storeRoot = await makeStore();
    const fixture = await makePackage();

    const imported = await importTemplatePackage({ sourceDir: fixture.dir, storeRoot });
    expect(imported.replaced).toBe(false);
    expect(imported.package.id).toBe("acme-dashboard");
    expect(imported.package.version).toBe("1.2.0");
    expect(imported.package.unverified).toBe(false);
    expect(imported.package.license).toEqual({ spdx: "MIT", file: "LICENSE" });
    expect(imported.package.files).toEqual(fixture.manifest["files"]);

    const read = await getTemplatePackage("acme-dashboard", "1.2.0", { storeRoot });
    expect(read.digest).toBe(imported.package.digest);
    expect(read.files[0]?.path).toBe("src/main.cc");

    const listed = await listTemplatePackages({ storeRoot });
    expect(listed.corrupt).toEqual([]);
    expect(listed.packages.map((entry) => `${entry.id}@${entry.version}`)).toEqual([
      "acme-dashboard@1.2.0",
    ]);
  });

  it("refuses an existing id@version unless replace is explicit", async () => {
    const storeRoot = await makeStore();
    const fixture = await makePackage();
    await importTemplatePackage({ sourceDir: fixture.dir, storeRoot });

    expect(await codeOf(importTemplatePackage({ sourceDir: fixture.dir, storeRoot }))).toBe(
      "template_exists",
    );
  });

  it("replaces a version only when asked, and reads the new bytes", async () => {
    const storeRoot = await makeStore();
    const first = await makePackage();
    await importTemplatePackage({ sourceDir: first.dir, storeRoot });

    const replacement = await makePackage({ content: "int main() { return 1; }\n" });
    const replaced = await importTemplatePackage({
      sourceDir: replacement.dir,
      storeRoot,
      replace: true,
    });
    expect(replaced.replaced).toBe(true);

    const read = await getTemplatePackage("acme-dashboard", "1.2.0", { storeRoot });
    const expected = `sha256:${createHash("sha256").update(replacement.content).digest("hex")}`;
    expect(read.files[0]?.digest).toBe(expected);
    expect(await readFile(path.join(read.path, "files", "src", "main.cc"), "utf8")).toBe(
      "int main() { return 1; }\n",
    );
    const listed = await listTemplatePackages({ storeRoot });
    expect(listed.packages).toHaveLength(1);
  });

  it("reports a package whose file bytes no longer match as invalid", async () => {
    const storeRoot = await makeStore();
    const fixture = await makePackage();
    const imported = await importTemplatePackage({ sourceDir: fixture.dir, storeRoot });
    await writeFile(path.join(imported.package.path, "files", "src", "main.cc"), "changed\n");

    expect(await codeOf(getTemplatePackage("acme-dashboard", "1.2.0", { storeRoot }))).toBe(
      "invalid_package",
    );
    const listed = await listTemplatePackages({ storeRoot });
    expect(listed.packages).toEqual([]);
    expect(listed.corrupt).toHaveLength(1);
  });
});

describe("unverified local packages (Q6)", () => {
  it("refuses missing licence/provenance by default and admits them only with the flag", async () => {
    const storeRoot = await makeStore();
    const fixture = await makePackage({ overrides: { license: null, provenance: null } });

    expect(await codeOf(importTemplatePackage({ sourceDir: fixture.dir, storeRoot }))).toBe(
      "invalid_package",
    );

    const imported = await importTemplatePackage({
      sourceDir: fixture.dir,
      storeRoot,
      allowUnverified: true,
    });
    expect(imported.package.unverified).toBe(true);
    expect(imported.package.license).toBeUndefined();
    expect(imported.package.provenance).toBeUndefined();

    const read = await getTemplatePackage("acme-dashboard", "1.2.0", { storeRoot });
    expect(read.unverified).toBe(true);
    const listed = await listTemplatePackages({ storeRoot });
    expect(listed.packages[0]?.unverified).toBe(true);
  });

  it("does not admit a non-licence problem under the unverified flag", async () => {
    const storeRoot = await makeStore();
    const fixture = await makePackage({ overrides: { category: "desktop" } });
    expect(
      await codeOf(
        importTemplatePackage({ sourceDir: fixture.dir, storeRoot, allowUnverified: true }),
      ),
    ).toBe("invalid_package");
  });
});

describe("package shape", () => {
  it("requires README.md and LICENSE for a strict package", async () => {
    const storeRoot = await makeStore();
    const noReadme = await makePackage();
    await rm(path.join(noReadme.dir, "README.md"));
    expect(await codeOf(importTemplatePackage({ sourceDir: noReadme.dir, storeRoot }))).toBe(
      "invalid_package",
    );

    const noLicense = await makePackage();
    await rm(path.join(noLicense.dir, "LICENSE"));
    expect(await codeOf(importTemplatePackage({ sourceDir: noLicense.dir, storeRoot }))).toBe(
      "invalid_package",
    );
  });

  it("rejects an unexpected top-level entry", async () => {
    const storeRoot = await makeStore();
    const fixture = await makePackage();
    await writeFile(path.join(fixture.dir, "notes.txt"), "not part of the package\n");
    expect(await codeOf(importTemplatePackage({ sourceDir: fixture.dir, storeRoot }))).toBe(
      "invalid_package",
    );
  });

  it.skipIf(process.platform === "win32")("rejects a symlink under files/", async () => {
    const storeRoot = await makeStore();
    const fixture = await makePackage();
    await symlink("src/main.cc", path.join(fixture.dir, "files", "link.cc"));
    expect(await codeOf(importTemplatePackage({ sourceDir: fixture.dir, storeRoot }))).toBe(
      "invalid_package",
    );
  });
});

describe("the store's failure paths", () => {
  it("serializes mutations with the lock and reports the wait", async () => {
    const storeRoot = await makeStore();
    const fixture = await makePackage();
    await mkdir(storeRoot, { recursive: true });
    await writeFile(path.join(storeRoot, ".lock"), "held\n");

    expect(
      await codeOf(importTemplatePackage({ sourceDir: fixture.dir, storeRoot, lockTimeoutMs: 20 })),
    ).toBe("store_locked");
  });

  it("lists a corrupt entry without failing the whole store", async () => {
    const storeRoot = await makeStore();
    const broken = path.join(storeRoot, "broken", "1.0.0");
    await mkdir(broken, { recursive: true });
    await writeFile(path.join(broken, "template.json"), "{ not json\n");
    await writeFile(path.join(broken, "README.md"), "# Broken\n");

    const listed = await listTemplatePackages({ storeRoot });
    expect(listed.packages).toEqual([]);
    expect(listed.corrupt).toHaveLength(1);
    expect(listed.corrupt[0]?.path).toBe(broken);

    expect(await codeOf(getTemplatePackage("broken", "1.0.0", { storeRoot }))).toBe(
      "invalid_package",
    );
  });

  it("removes a version, then reports it as absent", async () => {
    const storeRoot = await makeStore();
    const fixture = await makePackage();
    await importTemplatePackage({ sourceDir: fixture.dir, storeRoot });

    const removed = await removeTemplatePackage("acme-dashboard", "1.2.0", { storeRoot });
    expect(removed.removed).toBe(path.join(storeRoot, "acme-dashboard", "1.2.0"));
    expect(await codeOf(getTemplatePackage("acme-dashboard", "1.2.0", { storeRoot }))).toBe(
      "not_found",
    );
    expect(await codeOf(removeTemplatePackage("acme-dashboard", "1.2.0", { storeRoot }))).toBe(
      "not_found",
    );
  });
});
