# Releasing

Releases are cut by release-please from conventional commits. No one edits a
version by hand, and no one tags by hand.

The configuration (`release-please-config.json`), the changelog rules, the gate
on pull request titles, the workflow that runs release-please
(`.github/workflows/release-please.yml`, added in #177 for #160), and the
workflow that publishes a tag (`publish.yml`, added for #161) exist. The first
release was cut on 2026-10-17: release PR #188, opened and updated by
release-please, carried the maintainer's regeneration commit and merged at
`74df710`, and the tag `uvp-agents-0.2.0` was created on it. The first publish
was made by hand on 2026-10-17 and is observed: `uvp-agents@0.2.0` is on the
official registry, `latest` names it, and `npm view uvp-agents@0.2.0
dist.integrity` reports
`sha512-uXh6BqCNlPO4B3U47/0wqgKyLTf7pzHgeHZ756tUtDww+uf7tOLeC28HSDFy1EAq6uMaWxcjhAPD4igYLOCGLA==`.
The trusted-publisher entry is not attached yet, so `publish.yml` has not been
dispatched and the workflow half of the path below is still unobserved — see
[Publishing the tag](#publishing-the-tag).

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
5. Merging the release PR tags the commit. Publishing is a separate, manual
   dispatch of `publish.yml` with that tag — see
   [Publishing the tag](#publishing-the-tag).

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

## Publishing the tag {#publishing-the-tag}

`publish.yml` is dispatched by hand with the tag release-please created:

```bash
gh workflow run publish.yml -f tag=uvp-agents-<version> -f dry_run=true
gh run watch

gh workflow run publish.yml -f tag=uvp-agents-<version>
gh run watch
```

A tag push cannot trigger it: release-please creates the tag with the job's
`GITHUB_TOKEN`, and events caused by that token start no workflows — the same
rule that leaves the release PR without check runs. A `push: tags` trigger would
never fire, and the failure would look like a release that quietly did not
happen. The dispatch names the tag explicitly and the run checks that the
checkout is exactly that tag's commit.

### The credential

The job authenticates with npm **trusted publishing**: it declares
`id-token: write` and no registry token, and npm exchanges the workflow's OIDC
token for a publish authorization and attestation. There is no long-lived secret
to store or rotate. What that requires:

- The workflow file name configured as the trusted publisher must match —
  `publish.yml`.
- npm 11.5.1 or newer, and Node 22.14 or newer, on a GitHub-hosted runner, for
  the publish itself. The workflow asserts the npm version and takes Node from
  `.nvmrc` rather than assuming either. Attaching the publisher with `npm trust`
  is a newer client still: npm 11.15.0 or newer.
- A trusted-publisher entry for `uvp-agents`: on npmjs.com, the package's
  settings page → Trusted Publishing → GitHub Actions, repository
  `Antruly/uvp`, workflow `publish.yml`, no environment, **Allow npm publish**
  checked. The equivalent command is

  ```bash
  npm trust github uvp-agents --repository Antruly/uvp --file publish.yml --allow-publish
  ```

  Neither the settings page nor that command is reachable from this repository,
  so this section states the configuration rather than a check that verifies it.

**The first publish was manual, by decision.** Trusted publishing is configured
from an existing package's settings page, and npm's `npm trust` documentation
states the requirement directly: _"The package you're configuring must already
exist on the npm registry."_ `uvp-agents` had never been published, so the first
publish could not use trusted publishing. The maintainer authorized the
direction lead to choose the bootstrap, and the choice recorded on
[#161](https://github.com/Antruly/uvp/issues/161#issuecomment-6233847724) was:

1. Publish the first version by hand, from the tag `uvp-agents-0.2.0`, to the
   official registry (`registry.npmjs.org` — not a mirror, and not a local
   `publishConfig` override), at that tag's commit. **Done:** the registry's
   `time` field records `0.2.0` at 2026-10-17T13:22:05Z, and `latest` names it.
   The version list also holds `0.0.0-stage` (13:19:58Z), a staging upload from
   the same session; `latest` does not point at it.
2. Attach the trusted publisher to the package afterwards, as configured above.
   **Outstanding:** `npm trust` wants interactive confirmation and a second
   factor, so the attachment has not been made. Until it is, a dispatch of
   `publish.yml` fails at `npm publish` with an authentication error and uploads
   nothing.
3. Use `publish.yml` for every later version. **Not yet exercised:** no dispatch
   has run, so the workflow's publish half is still unobserved.

What the manual publish had to establish, because the workflow could not run for
it: check out the tag, run the same preflight the workflow runs
(`node scripts/verify-release-version.mjs --tag <tag>` and `npm run
verify:pack-reproducible`), and upload the tarball whose digest those checks
produced. A manual publish carries **no provenance attestation** — provenance is
generated from the workflow's OIDC token, so 0.2.0 is the one version without
it. What survives for it is the registry's digest, compared above; whether the
publisher ran the preflight is not observable from the registry.

**2FA applied to the manual publish.** For an account with two-factor
authentication enabled, npm's registry answers a publish without a second
factor with `403 Two-factor authentication or granular access token with bypass
2fa enabled is required to publish packages.`, and nothing is uploaded — which
is what the first attempt here received. The publish therefore needs either the
one-time code at the prompt or a granular access token scoped to `uvp-agents`
with the `publish` permission and **bypass 2FA** enabled; a browser session on
its own is not enough. A failed attempt uploads nothing, so it can be retried
once the credential is in hand — the version is still unclaimed until a publish
succeeds.

The workflow itself never holds a token: if the trusted publisher is attached,
it publishes; if not, `npm publish` fails with an authentication error and
nothing is uploaded. npm requires a newly created trusted publisher
configuration to complete its first successful publish within two days, after
which it expires and can no longer be used or edited — so attach it and dispatch
the next version inside that window. As of 0.2.0 the attachment has not been
made, so that window has not started.

### What the run establishes

In order, and each step fails closed:

1. `HEAD` is the commit the tag names, and `git describe --tags --exact-match`
   agrees — a dispatch naming an unknown tag, or a tag pointing somewhere else,
   stops here.
2. `npm ci`, `npm run compile`, then
   `node scripts/verify-release-version.mjs --tag <tag>`: `package.json`,
   `server.json` (both version fields), `.release-please-manifest.json`, all four
   version places in `sbom.cdx.json`, and the tag itself name one version.
3. `npm run docs:check`, so the generated files in the tagged tree are the ones
   the contracts produce.
4. The tree is still clean after the build, and `npm run verify:pack-reproducible`
   reproduces the archive and confirms every `files[]` entry is delivered.
5. It packs once, prints the listing, and publishes **that tarball** rather than
   re-packing the directory — the bytes uploaded are the bytes inspected.
6. `npm view uvp-agents@<version>` reports that version with the same
   `dist.integrity` the run packed.
7. It installs `uvp-agents@<version>` from the registry into an empty prefix, and
   runs `uvp --version`, `uvp --help`, `uvp doctor --json` (exit 1,
   `libuvcpp.found === false` — a GitHub runner has no libuvcpp, and 1 is the
   doctor's "checked, not found" status), and `npm run test:packaged-mcp` against
   that installed copy.

The run summary records the tag, the tarball name, and its digest, which is what
a consumer compares against `npm view uvp-agents dist.integrity`.

### The dry run, and re-running

`dry_run=true` performs steps 1–5 and skips everything that touches the
registry. It establishes that the tagged tree packs and passes; it does not
establish that npm accepts the publish, because nothing was sent. Run it first
when the tag is new or the workflow changed.

`npm publish` refuses a version that already exists, so re-dispatching a
successful run fails at the publish step instead of overwriting anything. A
re-dispatch after a failure partway through the verification steps is safe for
the same reason, provided the failure was before the upload.

## Publishing the GitHub Packages mirror {#github-packages-mirror}

GitHub Packages only stores scoped npm packages, and its package names and
scopes must be lowercase. The canonical package is `uvp-agents` on
registry.npmjs.org; `publish-github-packages.yml` derives the scoped mirror
`@antruly/uvp-agents` from the same tag and uploads it to
`https://npm.pkg.github.com`. The repository owner is `Antruly`, and the scope is
lowercase because the registry rejects anything else.

The mirror is a distribution convenience, not a second identity:

- `server.json`, the MCP registry entry, `uvp --version`, and `uvp mcp setup`
  keep the canonical `uvp-agents` name. The MCP registry still points at the
  auth-free npmjs install.
- `scripts/prepare-github-packages.mjs` rewrites `package.json#name`,
  `package.json#publishConfig.registry`, the lockfile's root name, and
  `sbom.cdx.json`. `src/generatedPackageMetadata.ts` and `dist` are left alone,
  so a CLI installed from GitHub Packages reports `uvp-agents <version>`. The
  workflow records that in its summary rather than hiding it.
- The publish does not pass `--provenance`. npmjs generates and stores that
  attestation; this repository has no observation that GitHub Packages accepts
  it, so the mirror carries no provenance claim.

**Automatic.** When release-please creates a release, the `Release please`
workflow calls this workflow through `workflow_call` with the new tag. The mirror
therefore follows the release without a manual dispatch. npmjs is deliberately
not automated: `publish.yml` stays a manual dispatch, because trusted publishing
is npm's mechanism and the mirror does not use it.

For a backfill, or to inspect the prepared tarball before uploading:

```bash
gh workflow run publish-github-packages.yml -f tag=uvp-agents-<version> -f dry_run=true
gh run watch

gh workflow run publish-github-packages.yml -f tag=uvp-agents-<version>
gh run watch
```

The workflow checks the checkout is the tag, runs the canonical version and
pack-reproducibility preflight, derives the mirror, runs the pack-reproducibility
check again on the derived tree, packs once, and inspects the tarball's own
manifest and SBOM before it uploads that tarball. After the upload it compares
the registry's `dist.integrity` with the digest it packed and installs the
package from GitHub Packages into an empty prefix before exercising the CLI and
the stdio MCP contract.

**The credential** is the workflow's `GITHUB_TOKEN` with `packages: write`; no
PAT and no npm trusted-publisher entry are involved, because trusted publishing
is npmjs's mechanism. A manual publish from a workstation needs a classic
personal access token with `write:packages` instead.

**What the run does not establish.** The first publish of a package on GitHub
Packages is private, and installing from GitHub Packages requires an
authenticated token even after the package is made public. The workflow cannot
change visibility; the maintainer sets it in the package's settings. A successful
run therefore proves the registry accepts and serves this artifact to an
authenticated consumer, not that it is publicly installable.

### Bootstrap a tag that predates the helpers {#github-packages-bootstrap}

The workflow runs `scripts/prepare-github-packages.mjs` and
`scripts/verify-release-version.mjs` from the tag checkout. A tag created before
those helpers existed cannot carry them, and a tag is immutable.
`uvp-agents-0.2.0` (`74df710`) is such a tag: both merged after the tag was cut.

For that case only, dispatch with `helpers_ref` set to a full 40-hex commit on
`main` that contains the helpers — including the version check's `--root`. A ref
from before that support is rejected, naming the ref, before anything is
derived:

```bash
gh workflow run publish-github-packages.yml \
  -f tag=uvp-agents-0.2.0 \
  -f helpers_ref=<40-hex-commit-on-main> \
  -f dry_run=true
```

The workflow verifies that the commit is on `origin/main` and contains
`scripts/prepare-github-packages.mjs`, `scripts/verify-release-version.mjs`,
`scripts/lib/npmPurl.mjs`, and `scripts/lib/paths.mjs`, stages those files
outside the checkout, and runs them with `--root` pointing at the tag checkout —
the derivation and the version check alike. The tag tree stays exactly the tag,
and the helpers are not in `files[]`, so the tarball's code is still the tag's.
The run summary records the helper commit and labels the run a bootstrap.

This is a one-time exception for tags that predate the helpers. Every later tag
contains them; leave `helpers_ref` empty.

### The 0.2.0 mirror is observed {#github-packages-observed}

`uvp-agents@0.2.0` was the first release published through this path and the
first bootstrap. The runs are recorded here so a later reader can separate what
was observed from what the workflow promises:

- **The bootstrap path works on a real tag.** The dispatch used
  `tag=uvp-agents-0.2.0` and
  `helpers_ref=7b703598cf0de2eec42ac9b57bf2c76dede19f9a`; run
  [39055283828](https://github.com/Antruly/uvp/actions/runs/39055283828)
  succeeded, and its log shows the staged helpers accepted as on `origin/main`
  and complete before anything was derived.
- **The registry serves the artifact the run packed.**
  `@antruly/uvp-agents@0.2.0` has integrity
  `sha512-DZRVol7eBm7DzK8mfaz/v7CQ5qYQL5im43MhLH21Se2Dn0j+rFCI8h6QZdhySpT3FCQiKuTL5uXWl4tS4GtM2A==`.
  The post-upload comparison printed `GitHub Packages serves
  @antruly/uvp-agents@0.2.0 with the digest this run packed.`
- **An authenticated install works.** The same run installed the package from
  GitHub Packages into an empty prefix, and its version check accepted what
  `uvp --version` printed: `uvp-agents 0.2.0`, the canonical identity.
- **The mirror's copy answers the CLI and the MCP contract.** `uvp doctor`
  exited 1 and reported libuvcpp absent, which is what the run expects on a
  machine with none; the packaged MCP check passed, with
  `io.github.Antruly/uvp` advertising 15 of 15 tools.
- **Visibility is unknown.** GitHub Packages defaults a first publish to private,
  and nothing in these runs observed the package's setting; the workflow cannot
  report or change it. Do not describe the mirror as public or private.
- **This says nothing about npmjs.** The trusted-publisher entry for
  `publish.yml` is a separate mechanism: a successful mirror publish neither
  attaches it nor depends on it, and its status is the one recorded at the top
  of this page.

**Why the pack passes `--ignore-scripts`.** The `prepare` lifecycle is husky,
and with `HUSKY=0` — which the workflow sets — it prints `HUSKY=0 skip install`.
That line lands in `npm pack --json`'s output: run
[39053130363](https://github.com/Antruly/uvp/actions/runs/39053130363) shows the
result, `SyntaxError: Unexpected token 'H', "HUSKY=0 sk"... is not valid JSON`.
The pack step now passes `--ignore-scripts`, and `verify:pack-reproducible`
packs the same way, so the two digests compare like for like.

Consumers install the mirror with a scoped `.npmrc` and a token:

```ini
@antruly:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

```bash
npm install --global @antruly/uvp-agents
```

The npmjs install remains the one that needs no token and is what the rest of
this documentation uses.

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
| `metadata.tools[0].version`  | `"0.2.0"`                    |
| `metadata.component.version` | `"0.2.0"`                    |
| `metadata.component.bom-ref` | `"uvp-agents@0.2.0"`         |
| `metadata.component.purl`    | `"pkg:npm/uvp-agents@0.2.0"` |

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
| GitHub Packages    | `@antruly/uvp-agents` (derived mirror; not canonical)        |
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

These are the pre-release checks. The release-please workflow does not run them:
it only opens and updates the release PR. `publish.yml` runs the subset that
must be true of the tagged tree, plus the install-side checks against the copy
npm serves — the two lists are in
[what the run establishes](#publishing-the-tag) — but it does not run
`check:pr`, because the tag exists only after the release PR merged. So this
remains the maintainer's step on the release PR's head, and it is the gate in
front of the tag. Every step here is still done by hand:

```bash
npm ci
npm run compile
npm run check:pr              # the static gate, every repository check, and the whole suite
npm run test:toolchain        # skipped if libuvcpp is absent
npm pack --dry-run            # inspect what will ship
```

What a release may claim about a host, compiler, generator, or feature is
recorded in the [first-release support matrix](support-matrix.md). A
configuration absent from that page is `unknown`, not unsupported.

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
- [ ] The npm publish path is ready: the trusted publisher is attached for
      `publish.yml`, or — for a version that is the first publish — the manual
      upload and the attachment are planned as
      [the credential section](#publishing-the-tag) records.
- [ ] The release PR's `Human owner:` line is filled in. See the
      [AI contribution policy](https://github.com/Antruly/uvp/blob/main/CONTRIBUTING.md#ai-contribution-policy).

## If a release goes wrong

**Do not force-push a tag.** npm versions are immutable; unpublishing is
restricted and breaks anyone who already installed. Publish a patch instead, with
a changelog entry that says what was wrong.

**If the tag exists but nothing was published**, delete the tag and let
release-please open a fresh release PR. Nothing is broken yet at that point.

**If a publish run failed**, read which step it stopped at. Every step before
`npm publish` leaves the registry untouched and the run can be repeated after
the cause is fixed. If it failed at or after the upload, establish what the
registry holds before doing anything else:

```bash
npm view uvp-agents versions --json
npm view uvp-agents@<version> dist.integrity
```

A version that is listed exists and cannot be replaced; that is the point at
which the deprecate path below applies, not a re-run.

**If a bad version was published**, deprecate it rather than unpublishing:

```bash
npm deprecate uvp-agents@<version> "Broken: <reason>. Use <version> instead."
```

The install keeps working for anyone who already has it, no one new gets it, and
the reason is visible in the registry.

## Next

- [Release notes](release-notes.md) — what the first release shipped and what
  remains unknown
- [Testing](testing.md) — what the pre-release lane runs
- [Roadmap](roadmap.md) — where the project is going
