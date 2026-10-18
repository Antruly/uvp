# Template packages

A template package is data, not code. It carries a manifest, a source tree, a
README, a licence, and an optional preview — nothing that runs at import time.
The `uvp.template/1` schema is the format's only authoritative description: the
validator in `src/domain/templatePackage*.ts` implements the tables below, and a
package that disagrees with them is refused rather than repaired.

## Status

The schema and validator (P1), the directory reader and local store (P2–P4),
the CLI/MCP surface (P5), and workspace generation (P6) are shipped. `uvp
template validate` checks a directory without writing, and `uvp template
import` copies one into the local store under `$UVP_TEMPLATE_HOME` (or
`~/.uvp/templates`); `search`, `get`, `export`, and `remove` cover the rest.
`uvp init --template-package id@version` renders a stored package into a
workspace. The store never executes a package: the source tree is copied into
the generated workspace, and building that workspace remains the evidence that
it works.

## Package layout

```text
acme-dashboard/
├── template.json       the manifest
├── README.md           what the package is and how to use it
├── LICENSE             the licence file named by the manifest
├── preview.png         optional: preview.png, preview.svg, or preview.webp
└── files/              the source tree, copied into the generated project
    └── src/main.cc
```

`template.json` is the only file the format interprets. Every path in its
`files` array is relative to `files/`, not to the package root, and may not begin
with `files/`.

## Example

```json
{
  "schema": "uvp.template/1",
  "id": "acme-dashboard",
  "version": "1.0.0",
  "name": "Acme dashboard",
  "description": "A dashboard service with a health route and a browser console",
  "category": "fullstack",
  "framework": "vue3",
  "tags": ["dashboard", "admin"],
  "requires": {
    "uvp": ">=0.3.0",
    "libuvcpp": ">=1.7.0 <2.0.0",
    "features": ["tls"]
  },
  "variables": {
    "name": { "type": "slug", "required": true, "default": "acme-dashboard" },
    "port": { "type": "port", "default": 8080 }
  },
  "files": [
    {
      "path": "src/main.cc",
      "digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      "bytes": 1024
    }
  ],
  "routes": ["GET /healthz", "WS /console"],
  "license": { "spdx": "MIT", "file": "LICENSE" },
  "provenance": {
    "author": "Acme",
    "source": "https://example.test/acme/template",
    "revision": "abc123",
    "createdAt": "2026-10-18T00:00:00Z"
  }
}
```

## Manifest fields

The schema is closed: an unknown key anywhere in the manifest is a problem, not
something ignored. That is deliberate — a misspelled `licence` would otherwise
claim something the package does not carry, and a reader that re-serialises the
manifest would silently drop it.

| Field               | Required | Rule                                                                                             |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `schema`            | yes      | exactly `uvp.template/1`                                                                         |
| `id`                | yes      | lowercase slug (`acme-dashboard`), at most 64 characters                                         |
| `version`           | yes      | SemVer 2.0.0 (`1.2.0`, `1.2.3-rc.1`); no ranges                                                  |
| `name`              | yes      | 1–80 characters, single line                                                                     |
| `description`       | no       | 1–2000 characters, single line                                                                   |
| `category`          | yes      | `frontend`, `backend`, `fullstack`, or `module`                                                  |
| `framework`         | no       | `h5`, `vue3`, `react`, `svelte`, `alpine`, or `htmx`                                             |
| `tags`              | no       | at most 20 lowercase slugs of at most 32 characters each                                         |
| `requires.uvp`      | no       | a comparator set or exact version (`>=0.3.0`, `>=1.7.0 <2.0.0`)                                  |
| `requires.libuvcpp` | no       | the same range spelling                                                                          |
| `requires.features` | no       | libuvcpp features: `tls`, `http2`, `http3`, `grpc`, `websocket`, `soap`, `db`                    |
| `variables`         | no       | only `name` (`type: "slug"`) and `port` (`type: "port"`), with optional `required` and `default` |
| `files`             | yes      | at least one entry; `path`, `digest`, and `bytes`                                                |
| `routes`            | no       | at most 64 unique `METHOD /path` entries; the methods the route table names                      |
| `license`           | yes      | `spdx` or `name`, and `file: "LICENSE"`                                                          |
| `provenance`        | yes      | `author`, `createdAt`; optional `source` and `revision`                                          |
| `preview`           | no       | `preview.png`, `preview.svg`, or `preview.webp`                                                  |

`name`, `description`, `license.name`, and `provenance.author` may not contain
control characters. They appear in search results and reports, and a control
character could rewrite the line a terminal has already written.

`routes` is what the package's service registers, and it is the only route
information `uvp init` reports for a package workspace. A method must be one of
`GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, or `WS`; a path is
`:name` for one parameter or `*name` for a subtree, as in the built-in route
table. An absent `routes` means the package did not say, not that the service
registers nothing: `uvp init` reports an empty list with a limitation naming
that gap rather than inferring routes from source it never ran.

## Limits

The limits are named in `DEFAULT_TEMPLATE_PACKAGE_LIMITS`; changing a number
does not change the schema. They bound what one package can ask a store to hold
before the store's own checks run.

| Limit                      | Value           |
| -------------------------- | --------------- |
| files per package          | 512             |
| routes per package         | 64              |
| one file                   | 1 MiB           |
| total declared or observed | 8 MiB           |
| path length                | 240 characters  |
| name                       | 80 characters   |
| description                | 2000 characters |
| tags                       | 20              |
| one tag                    | 32 characters   |
| id                         | 64 characters   |
| author                     | 120 characters  |
| revision                   | 120 characters  |
| licence name               | 80 characters   |
| SPDX identifier            | 64 characters   |

## Paths

Paths are portable or they are refused. The Windows rules apply on every host,
because a package imported on Linux may be extracted and built on Windows:

- relative, with `/` separators — no absolute paths, drive letters, `~`, or `\`;
- no empty, `.`, or `..` segments;
- no characters Windows forbids (`< > : " | ? *`) and no control characters;
- no segment ending in a dot or space, and no reserved device name (`CON`,
  `LPT1`, …);
- no archive (`.zip`, `.tar.gz`, …) and no executable or object file (`.so`,
  `.exe`, `.o`, …) — a package carries source, not binaries;
- unique case-insensitively, so a tree cannot overwrite itself on a
  case-insensitive filesystem.

## Licence and provenance

A package must state a licence and where it came from. `license.spdx` accepts a
single SPDX identifier such as `MIT` or `Apache-2.0`, optionally with a trailing
`+`; expressions (`MIT OR Apache-2.0`) are refused in v1. The identifier's
existence is **not** checked — this is syntax, not an SPDX database lookup. The
licence text itself is the package's `LICENSE` file.

`provenance.createdAt` is a UTC ISO-8601 timestamp with a real calendar date;
`provenance.source` must be an absolute http(s) URL without credentials.

## Placeholders

A v1 package may use three placeholders in `files/`:

| Placeholder                           | Substituted from                                |
| ------------------------------------- | ----------------------------------------------- |
| <span v-pre>`{{project.name}}`</span> | the project name, declared by a `name` variable |
| <span v-pre>`{{project.port}}`</span> | the port, declared by a `port` variable         |
| <span v-pre>`{{features}}`</span>     | `requires.features`                             |

There are no conditional placeholders in v1. A variable for any other
placeholder is refused, because it would render literally into a compiled file.

Substitution is textual and happens on every occurrence in a file that decodes
as UTF-8. A file that does not decode is copied byte for byte — rewriting bytes
that are not text would corrupt an image or an icon for nothing.
<span v-pre>`{{features}}`</span> becomes the feature names joined with `,` in
the manifest's order. Because the substitution is textual, the package controls
its own quoting: a manifest that writes
<span v-pre>`"port": {{project.port}}`</span> renders a JSON number, while
<span v-pre>`"port": "{{project.port}}"`</span> renders a string the workspace
manifest reader will then refuse as it would any other bad field.

## Generating a workspace from a package

```bash
uvp init ./dashboard --name dashboard --template-package acme-dashboard@1.0.0
```

A workspace is generated from exactly one selector: a built-in `template` or a
stored `template_package`, never both. Naming both is refused before the store
is read, so the answer cannot depend on which package happened to be stored. The
package's `files/` tree is written under the workspace root with the
placeholders substituted, and every file is read back and re-hashed against the
manifest first: a stored tree that no longer matches its manifest is an
`artifact_modified` failure, and no partial workspace is written.

Only the package's source is rendered. `features`, `modules`,
`event_payloads`, and `frontends` compose the built-in generators, so they are
refused with `--template-package` rather than accepted and ignored. A package's
`requires.features` describes what its source was written for; `uvp init` does
not check that the installed libuvcpp satisfies it — the build is the evidence.

The one file uvp writes rather than copies is `uvp.json`:

- a package that ships one keeps every field, loses `template` (the selectors
  are mutually exclusive), and gains `template_package: {id, version, digest}`;
- a package without one gets a minimal manifest with `uvp`, `name`, `binary`,
  `port`, `features`, `template_package`, and `requires.libuvcpp` when the
  package declared one.

The result reports the built-in `template` or the `template_package`
identity, never both, and the routes exactly as the manifest declared them.

## What validation establishes

The validator returns every problem in one pass rather than the first, so an
import can write one complete report before writing anything to disk. On
success it returns the manifest, a canonical digest, and `filesObserved`.

- `filesObserved: false` means only the declaration was examined. The manifest is
  well-formed; nothing says the tree matches it.
- `filesObserved: true` means a reader supplied a listing of `files/`, and the
  two lists were checked against each other in both directions: a declared file
  that was not observed is a problem, and so is an observed file that was not
  declared.

The digest is `sha256:` over the manifest's RFC 8785 canonical JSON, so two
manifests with the same content digest identically regardless of key order.

Validation does **not** establish that a reader's digest was recomputed (it is
compared only when the reader supplied one), that a symlink or binary flag was
examined (only reported values are checked), that an SPDX identifier exists, that
a requirement range is satisfied, or that the generated C++ compiles. Those are
later increments or other tools' findings.
