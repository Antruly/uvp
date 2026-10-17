# Releasing

Releases are cut by release-please from conventional commits. No one edits a
version by hand, and no one tags by hand.

The configuration (`release-please-config.json`), the changelog rules, the gate
on pull request titles, and the workflow that runs release-please
(`.github/workflows/release-please.yml`, added in #177 for #160) exist. No release has
been cut yet, so the flow below is written from the configuration and has not
been observed end to end — see [Pre-release checks](#pre-release-checks).

## The flow

1. A pull request merges to `main` with a conventional-commit title.
2. release-please opens or updates a release PR. It carries the version bump, the
   changelog entry, and the files that embed a version. There is no tag and no
   `bootstrap-sha`, so the first run reads the whole branch history and the first
   release PR's changelog covers all of it; `bootstrap-sha` is the knob if that
   is not wanted, and it can be removed after the first release.
3. A maintainer runs `npm run docs:generate` and commits the regenerated files to
   the release PR, because `sbom.cdx.json` carries the version in two compound
   strings that `extra-files` cannot rewrite. This is a maintainer step by
   decision, not an oversight: the scope decision on #160
   ([Option B](https://github.com/Antruly/uvp/issues/160#issuecomment-6233157938))
   keeps the workflow to opening and updating the PR, so no workflow gets write
   access to a pull request branch.
4. A maintainer reviews that PR like any other — the changelog is the part that
   gets read, because it is what users will see.
5. Merging the release PR tags the commit and publishes.

The tag has no `v` prefix (`include-v-in-tag: false`). The npm package is
`uvp-agents`; the repository is `uvp`. That difference is intentional and
permanent — the repository name says what the project is, the package name says
what it installs.

## The token, and what it does not trigger

The workflow runs `googleapis/release-please-action` with the job's
`GITHUB_TOKEN`; no additional credential is configured. That one job declares
only the permissions the action needs (`contents: write`,
`pull-requests: write`, `issues: write`), and every other workflow in this
repository keeps `contents: read` or nothing.

Two consequences are GitHub behaviour rather than this repository's policy, and
both matter for a release:

- The repository setting **Allow GitHub Actions to create and approve pull
  requests** must be enabled, or the release PR cannot be opened.
- A pull request opened with `GITHUB_TOKEN` does not trigger `pull_request`
  workflows. The release PR therefore may carry no CI results of its own, and
  the pre-release checks below are run by the maintainer rather than read from
  the PR. Granting the workflow a personal access token so those workflows run
  is a new-credential decision; it has not been made.

Neither setting is observable from the source tree, so they are stated here
rather than asserted by a check.

## Every release bumps the minor

```json
{ "versioning": "always-bump-minor" }
```

Pre-1.0, a patch release that contains a behaviour change is indistinguishable
from one that does not, and the version number is the only signal a user has.
Bumping the minor on every release makes "did anything change?" answerable
without reading the changelog, at the cost of a version number that moves faster
than the code.

This is revisited at 1.0.0, not before.

## What gets the version written into it

release-please updates these through `extra-files`, so a version can never be
right in one place and stale in another:

| File                              | Field                                                       |
| --------------------------------- | ----------------------------------------------------------- |
| `package.json`                    | `$.version`                                                 |
| `server.json`                     | `$.version` and `$.packages[0].version`                     |
| `src/generatedPackageMetadata.ts` | the line carrying the `x-release-please-version` annotation |

`server.json` is the MCP registry metadata, and it carries the version twice:
once for the server entry and once for the npm package it points at. Those two
disagreeing is how a registry listing points at a version that does not exist.

`src/generatedPackageMetadata.ts` is generated, and a CI check regenerates it and
fails on a diff. Hand-editing it produces a build that is green locally and red
in CI.

`sbom.cdx.json` carries the version in four places, and only two of them are
values `extra-files` can write:

| Where                        | Shape                        |
| ---------------------------- | ---------------------------- |
| `metadata.tools[0].version`  | `"0.1.0"`                    |
| `metadata.component.version` | `"0.1.0"`                    |
| `metadata.component.bom-ref` | `"uvp-agents@0.1.0"`         |
| `metadata.component.purl`    | `"pkg:npm/uvp-agents@0.1.0"` |

A `jsonpath` entry replaces the whole value at its path, so it can update the
first two and cannot update the last two without destroying them. That is why
`sbom.cdx.json` is not in `extra-files`: the release PR has to run
`npm run docs:generate` after the bump, which rewrites all four from
`package.json` and re-derives the `serialNumber` from the result. Nothing is
silently stale if that step is skipped — `docs:check` runs on every pull request
and compares the file byte for byte, so the release PR is red until it is
regenerated. The release-please workflow does **not** perform that regeneration:
the scope decision on #160 keeps it out, so no workflow takes write access to a
pull request branch. The step is the maintainer's, and whether the PR shows the
red check depends on whether CI ran on it at all — see
[the token this workflow runs with](#the-token-and-what-it-does-not-trigger).

## Publishing the MCP registry entry

`server.json` is the metadata the [MCP registry](https://registry.modelcontextprotocol.io)
lists; it is not the package. The entry publishes **after** the npm package
exists (#161), and only with the maintainer's explicit authorization — the
registry publish is an external publication.

The registry's CLI is `mcp-publisher` from
[modelcontextprotocol/registry](https://github.com/modelcontextprotocol/registry)
(the registry is in preview). From the repository root:

```bash
mcp-publisher validate      # schema validation; publishes nothing
mcp-publisher login github  # device flow; the namespace is io.github.Antruly
mcp-publisher publish
```

With GitHub authentication the registry checks ownership through the name: the
server name must start with `io.github.<login>/`, and the npm package's
`package.json` must carry an `mcpName` equal to it. This repository sets
`"mcpName": "io.github.Antruly/uvp"`, and the metadata check below refuses a
`server.json` whose name differs.

Verify what a client will see:

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.Antruly/uvp"
```

The acceptance for #162 is that listing plus a fresh client's MCP handshake and
`uvp_doctor` from the registry-installed path — not the local schema check.

### The version, the description, and the check

`server.json` is in release-please's `extra-files` for both `$.version` and
`$.packages[0].version`, so the release PR moves the server entry and the npm
entry together. `npm run metadata:check` (part of `check:ci`) then refuses a file
where those disagree with `package.json`, where the name differs from
`package.json#mcpName`, where the npm identifier/runtime/transport/argument shape
is not the one a client installs, or where the description exceeds the registry
schema's 100-character cap.

That check does not fetch the registry schema: `mcp-publisher validate` is the
authoritative schema validation and needs the CLI, which is a network download,
so it is the maintainer's step at publish time. On 2026-10-17 the schema at
`https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`
was fetched and `server.json` validated against it; the first run failed on the
description's length, which is why the entry now carries the shorter tagline.

## Changelog sections

Commits are grouped by type. Everything is shown except `chore`:

| Type       | Section                |
| ---------- | ---------------------- |
| `feat`     | Features               |
| `fix`      | Bug Fixes              |
| `perf`     | Performance            |
| `refactor` | Refactors              |
| `docs`     | Documentation          |
| `test`     | Tests                  |
| `build`    | Build System           |
| `ci`       | Continuous Integration |
| `chore`    | _hidden_               |

Pull request titles must be conventional commits — `pr-title.yml` enforces the
pattern on every PR, so a title that would produce a bad changelog entry cannot
merge.

`chore` is hidden because dependency updates and version bumps are noise in a
changelog users read. They remain in the commit history.

## Compatibility promises

Pre-1.0, the honest answer is: **tool contracts are stable, everything else may
change.**

The contracts are the interface an agent sees, and an agent that cached a tool
schema should keep working. A change to an existing tool's input or output schema
is a breaking change and gets a `!` in the commit title, which release-please
promotes to a major bump.

Generated code is not covered. A new uvp version may emit different C++ from the
same template, and a workspace generated by an older version is not expected to
be regenerable byte-for-byte by a newer one.

libuvcpp's floor — 1.7.0 — is a compatibility promise in the direction that
matters: uvp will not require a newer libuvcpp within a minor series without
saying so.

## Release artifacts

| Artifact           | Where                                                        |
| ------------------ | ------------------------------------------------------------ |
| npm package        | `uvp-agents`                                                 |
| MCP registry entry | `io.github.Antruly/uvp`                                      |
| Tool catalog       | `docs/public/tool-catalog.json`, also shipped in the package |
| Bill of materials  | `sbom.cdx.json`, also shipped in the package                 |
| Documentation site | GitHub Pages, from `docs/.vitepress/dist/`                   |

The tool catalog is generated from the contracts, so it describes the version it
was built from and not the version someone remembered to update it for.

`sbom.cdx.json` is CycloneDX 1.5 over the production dependency closure, written
by `npm run sbom:generate` and covered by `npm run sbom:check`. It ships in the
tarball alongside `THIRD_PARTY_NOTICES.md` and `licenses/npm-dependencies.json`,
which are the two documents it agrees with and neither of which used to be in
`files[]`. See [the bill of materials](roadmap.md#sbom) for what it establishes
and what it does not.

## Pre-release checks

These are the pre-release checks. The release workflow does not run them: it
only opens and updates the release PR. No release has been cut yet, so every
step here is still a thing a maintainer does by hand, on the release PR's head.
The intent is a lane that fails closed — nothing publishes if any of this
fails:

```bash
npm ci
npm run compile
npm run check:pr              # the static gate, every repository check, and the whole suite
npm run test:toolchain        # skipped if libuvcpp is absent
npm pack --dry-run            # inspect what will ship
```

`check:pr` includes the pack reproducibility check, which packs the tarball three
more times and compares digests — see
[what it establishes](#reproducibility-of-the-tarball), and note that it needs
`dist/`, so it belongs after `npm run compile` rather than before it.

Then the packaged check, which is the one that catches the mistakes that matter:

```bash
npm pack
npm install --global --ignore-scripts ./uvp-agents-*.tgz
uvp --version
uvp --help
uvp doctor --json
```

Installing the tarball rather than the workspace is the point. A package that
works from `node_modules` in the repository and fails from a tarball is usually
missing a file from `files[]` or reaching for a path that only exists in a
checkout.

### Reproducibility of the tarball {#reproducibility-of-the-tarball}

The tarball is meant to be a fact about the source tree: the same tree packs to
the same bytes, so the digest a consumer computes can be checked against a tag,
and a release can be reproduced by anyone who wants to. `npm run
verify:pack-reproducible` — part of `check:pr`, and a step in the packaged
rehearsal — packs the tree, packs it again seconds later into a different
directory, unpacks the first tarball's contents at another absolute path and
packs those, and fails if any digest differs. All three pass `--ignore-scripts`,
because a copy of the tarball's contents has no `node_modules` for `husky` to run
in; packing this tree with the lifecycle scripts and without them produced the
same digest, which is why holding that constant costs nothing.

Measured on 2026-10-16: the digest is stable across repeated packs, across pack
destinations, across the contents being unpacked at a different path and depth,
and across a clean rebuild of `dist/` in between (`npm run compile` deletes and
rewrites it). What that does _not_ establish is another machine, another npm
version, or a different filesystem: the unpacked copy is the closest local
stand-in for a different checkout and it is a stand-in. The npm version is held
by `packageManager` in `package.json`, and the check is a check about _this_
toolchain's packing until someone runs it elsewhere.

The same run also checks that the tarball delivers every path `files[]` names,
because reproducibility says the tarball is a fact about its contents and says
nothing about whether they are the right ones. An entry naming a path that no
longer exists is ignored by npm in silence, so a package can promise a file it
does not contain and pass every other check here; `THIRD_PARTY_NOTICES.md` was in
that state until this release path was written down. The opposite mistake — a file
that should ship and is not listed — remains a reviewer's, checked by the
`files[]` item in the maintainer checklist below.

## Maintainer checklist

Before merging a release PR:

- [ ] The changelog reads correctly — entries describe user-visible behaviour,
      not implementation steps.
- [ ] Every breaking change is marked and has a migration note.
- [ ] `files[]` in `package.json` still covers everything the package needs at
      runtime.
- [ ] Every generated file is regenerated after the version bump — `npm run
      docs:generate` — including `sbom.cdx.json`, whose root component and
      `serialNumber` both change with the version.
- [ ] The packaged install was run, not assumed.
- [ ] `uvp --version` reports the new version after a packaged install.
- [ ] The [pre-release checks](#pre-release-checks) were run on the release PR's
      head, because the token that opened it does not trigger `pull_request`
      workflows.
- [ ] The release PR's `Human owner:` line is filled in. See the
      [AI contribution policy](https://github.com/Antruly/uvp/blob/main/CONTRIBUTING.md#ai-contribution-policy).

## If a release goes wrong

**Do not force-push a tag.** npm versions are immutable; unpublishing is
restricted and breaks anyone who already installed. Publish a patch instead, with
a changelog entry that says what was wrong.

**If the tag exists but nothing was published**, delete the tag and let
release-please open a fresh release PR. Nothing is broken yet at that point.

**If a bad version was published**, deprecate it rather than unpublishing:

```bash
npm deprecate uvp-agents@<version> "Broken: <reason>. Use <version> instead."
```

The install keeps working for anyone who already has it, no one new gets it, and
the reason is visible in the registry.

## Next

- [Testing](testing.md) — what the pre-release lane runs
- [Roadmap](roadmap.md) — where the project is going
