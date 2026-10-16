# Third-party notices

uvp's own source is licensed under the [MIT License](LICENSE). Third-party
components retain their own licenses and their own terms; nothing in this
repository relicenses them.

This file is an inventory with pointers, not a substitute for a license text. The
authoritative license for any dependency is the one distributed with it.

## The build-time substrate

### libuvcpp

uvp does not bundle or redistribute libuvcpp. It generates projects that link
against a libuvcpp installation you provide, and it reads that installation's
generated configuration header and published `pkg-config` file to report which
modules are present.

- Project: https://github.com/Antruly/libuvcpp
- License: MIT
- Version uvp is verified against: **1.7.0**

Because uvp links nothing against libuvcpp itself — it invokes your compiler,
which links your installation — libuvcpp's license obligations attach to the
project uvp generates for you, alongside your own. The generated `README.md`
names libuvcpp and its version floor for that reason.

libuv itself is a transitive dependency of libuvcpp and is likewise not
distributed by uvp.

### The C++ toolchain and CMake

uvp invokes a compiler and CMake that are already installed. It does not install,
upgrade, or modify either. `uvp doctor` reports what it found.

## Distributed npm dependencies

These are runtime dependencies: they are installed when you install uvp.

| Package                        | License    | Used for                                            |
| ------------------------------ | ---------- | --------------------------------------------------- |
| `@modelcontextprotocol/server` | Apache-2.0 | The MCP server transport and tool registration      |
| `zod`                          | MIT        | Contract and manifest validation                    |
| `canonicalize`                 | Apache-2.0 | Stable JSON digests over contract and catalog input |

Exact versions are pinned in `package.json` (`save-exact=true`) and resolved from
`package-lock.json`. These are the packages uvp declares; what they in turn pull
in is `@modelcontextprotocol/core`, and the closure is listed in
`licenses/npm-dependencies.json`.

## Development dependencies

Not distributed with the published package.

| Package                         | License    | Used for                                      |
| ------------------------------- | ---------- | --------------------------------------------- |
| `typescript`                    | Apache-2.0 | Compilation and type checking                 |
| `vitest`, `@vitest/coverage-v8` | MIT        | Test runner and coverage                      |
| `@stryker-mutator/core`         | Apache-2.0 | Mutation testing                              |
| `oxlint`, `oxfmt`               | MIT        | Linting and formatting                        |
| `knip`                          | ISC        | Unused-file, export, and dependency detection |
| `jscpd`                         | MIT        | Duplication detection                         |
| `turbo`                         | MIT        | Task orchestration and caching                |
| `vitepress`                     | MIT        | The documentation site                        |
| `husky`                         | MIT        | Git hooks                                     |
| `@types/node`                   | MIT        | Node.js type definitions                      |

## Generated code

A workspace uvp generates contains no third-party source. It contains a
`CMakeLists.txt`, a `main.cpp`, a `uvp.json`, a `README.md`, a `.gitignore`, and —
for the `static-files` template — one HTML file. All of it is produced by uvp and
carries the same MIT terms as this repository, unless you configure otherwise.

## Maintaining and redistributing notices

If you redistribute uvp, or a package derived from it, keep this file and the
`LICENSE` alongside it. If you add a dependency, add its row here in the same
change — a dependency review that does not update the inventory is incomplete.

For a machine-checked inventory of the installed dependency tree, run
`npm run licenses:generate`, which writes into `licenses/`. That output reflects
the resolved lockfile, and this file explains the intent behind the choices.
`npm run licenses:check` fails when it is stale, and `npm run docs:check` — which
CI runs — also checks the table above against `package.json` and
`package-lock.json`: a dependency added or removed without a row here is a build
failure rather than something a reviewer has to notice.

For a machine-readable inventory in a format other tools read, `sbom.cdx.json` is
CycloneDX 1.5 over the same closure, written by `npm run sbom:generate`. It covers
the npm package. It does not cover libuvcpp, which uvp neither bundles nor
redistributes, and it is an inventory rather than a vulnerability report.

All three files ship with the package, which is what makes the paragraph above
actionable: `THIRD_PARTY_NOTICES.md`, `licenses/npm-dependencies.json` and
`sbom.cdx.json` are in `files[]` in `package.json`.
