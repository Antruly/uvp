/**
 * Regenerate `fixtures/registry-index.generated.json` with the registry's own
 * index builder, so the fixture cannot drift into something the generator does
 * not emit.
 *
 * Usage:
 *
 *   curl -fsSL https://raw.githubusercontent.com/Antruly/uvp-templates/\
 * a95b3e0631364c511a61829a482c805da141acd7/scripts/lib/package.mjs \
 *     -o /tmp/registry-package.mjs
 *   node tests/support/generateRegistryIndexFixture.mjs /tmp/registry-package.mjs
 *
 * The module is untrusted downloaded data: keep it in its own directory, import
 * it by the absolute path given here, and do not run it from the directory it
 * was saved in. The pinned commit is the one the checked-in fixture was built
 * with; a new commit means a new fixture and a re-check of the reader.
 *
 * The package tree is built in a temporary directory and contains a text file
 * and a binary asset, so the generated entry carries `binary: true` as well as
 * `binary: false`. Nothing else about the tree is significant.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const modulePath = process.argv[2];
if (!modulePath) {
  console.error("usage: node generateRegistryIndexFixture.mjs <path-to-package.mjs>");
  process.exit(2);
}

const { buildIndex, renderIndex } = await import(pathToFileURL(path.resolve(modulePath)).href);
const fixturePath = path.join(import.meta.dirname, "fixtures", "registry-index.generated.json");

const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const files = [
  {
    path: "src/main.cc",
    bytes: Buffer.from('#include "uvp.h"\n\nint main() { return uvp::run(); }\n'),
  },
  { path: "assets/logo.dat", bytes: Buffer.from([0x89, 0x00, 0x01, 0x02]) },
];

const root = await mkdtemp(path.join(tmpdir(), "uvp-registry-fixture-"));
try {
  const packageDir = path.join(root, "packages", "acme-dashboard", "1.0.0");
  for (const file of files) {
    const target = path.join(packageDir, "files", file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.bytes);
  }

  const manifest = {
    schema: "uvp.template/1",
    id: "acme-dashboard",
    version: "1.0.0",
    name: "Acme dashboard",
    description: "A dashboard service",
    category: "fullstack",
    framework: "h5",
    tags: ["dashboard"],
    requires: { uvp: ">=0.3.0", features: ["websocket"] },
    variables: { port: { type: "port", default: 8080 } },
    preview: "preview.png",
    files: files.map((file) => ({
      path: file.path,
      digest: digest(file.bytes),
      bytes: file.bytes.byteLength,
    })),
    license: { spdx: "MIT", file: "LICENSE" },
    provenance: { author: "Acme", createdAt: "2026-10-18T00:00:00Z" },
  };

  await writeFile(path.join(packageDir, "template.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(packageDir, "README.md"), "# Acme dashboard\n");
  await writeFile(path.join(packageDir, "LICENSE"), "MIT\n");
  // A 1x1 transparent PNG, so the manifest's `preview` names a real file.
  await writeFile(
    path.join(packageDir, "preview.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ),
  );

  const { problems, index } = await buildIndex(root);
  if (problems.length > 0) {
    console.error(JSON.stringify(problems, null, 2));
    process.exit(1);
  }
  await writeFile(fixturePath, renderIndex(index));
  console.log(fixturePath);
} finally {
  await rm(root, { recursive: true, force: true });
}
