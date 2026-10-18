import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * A minimal `uvp.template/1` package on disk, for the store tests.
 *
 * The caller owns the temporary root (and its cleanup); this helper only writes
 * the package beneath it. Keeping the root caller-owned is what lets the store
 * tests and the search tests share one definition of "a valid package" without
 * a second copy of the manifest shape.
 */

export const DEFAULT_TEMPLATE_PACKAGE_CONTENT = "int main() { return 0; }\n";

export interface TemplatePackageFixture {
  readonly dir: string;
  readonly manifest: Record<string, unknown>;
  readonly content: string;
}

export const makeTemplatePackage = async ({
  root,
  overrides = {},
  content = DEFAULT_TEMPLATE_PACKAGE_CONTENT,
}: {
  readonly root: string;
  readonly overrides?: Record<string, unknown>;
  readonly content?: string;
}): Promise<TemplatePackageFixture> => {
  const dir = path.join(root, "package");
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
