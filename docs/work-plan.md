# Current development plan

**Snapshot:** 2026-10-18, `main` at `7b70359`. This is a snapshot, not a live
dashboard. The direction lead updates it per batch with the maintainer's
approval; counts and open items will drift between snapshots.

This page answers three questions for an AI engineer or a contributor:

1. what is already working;
2. what is being worked on now;
3. which direction is useful next, and how to claim it.

Follow [the AI development workflow](agent-workflow.md) and
[AI engineer operations](ai-engineer-operations.md) before claiming anything.

## Where we are

- **95 merged PRs**, **92 closed issues**; **5 open issues**, **1 open PR** at
  this snapshot.
- **Roadmap:** 50 of 54 marked items are done. The four open rows are
  `remote-ssh/` (blocked on verification), two CI observations/flakes, and the
  Ubuntu 26.04 migration watch.
- **Milestone 1:** complete. The full describe → generate → build → run → probe →
  evidence loop works for all seven templates against real libuvcpp.
- **Milestone 2:** the `container` provider is written and passes the provider
  conformance suite; `remote-ssh/` is not written and is blocked on a real
  verification route, not on appetite.
- **Milestone 3:** HTTP/2, HTTP/3, TLS, database-backed templates, capture replay,
  and bundle diff are in place.
- **Web toolbox:** HTTP/1.1, HTTP/2, HTTP/3, TLS, WebSocket (Node and libuvcpp
  native probe), SOAP, load test, capture, assertions, verify, bundle diff.
- **MCP and CLI:** 15 tool contracts shared by both surfaces; `uvp setup` supports
  Claude Code, Claude Desktop, and Cursor; the `build-libuvcpp-services` skill is
  shipped with the package.
- **Quality:** source, conformance, toolchain, boundary, composition, and
  acceptance projects; mutation testing, fuzzing, a Windows source lane, a
  Windows MSVC toolchain lane, container conformance, SBOM, and reproducible
  packing.

The core product is therefore **feature-complete for the current scope**.
**`uvp-agents@0.2.0` is published on npm**; the next release PR, #194 for
`0.3.0`, is open with no CI checks of its own.

The GitHub Packages mirror tooling merged after the 0.2.0 tag: #197/#198 (the
scoped mirror), #199/#200 (bootstrap for a tag that predates the helpers),
#201/#202 (a `--root`-aware version preflight, with #203 folded into it), and
#204/#205 (`npm pack --json` no longer corrupted by the `prepare` lifecycle).
The observed 0.2.0 mirror publish, its integrity, and what remains unknown are
recorded by **#207**; this page does not restate them.

## Current direction

1. **Release.** `uvp-agents@0.2.0` is live on npm; the tag and GitHub release
   exist, and #188 is merged. #194 is the open `0.3.0` release PR. It was created
   by `GITHUB_TOKEN`, so **no CI runs on it**; the owner posted the merge
   checklist at 2026-10-17T14:42Z. The batch that checklist said to wait for
   (#184, #190, #195, #196) has merged and release-please has since rebased the
   PR to `f173cde`.
   - The blocking item from the owner's 2026-10-17T12:21Z review **still applies
     at `f173cde`**: `package.json` is `0.3.0` while `sbom.cdx.json` still
     describes `0.2.0`, so `npm run docs:generate` and a commit of the
     regenerated files (the same Option B step as #188) must happen on the
     release branch before `docs:check` can pass on `main`.
   - Trusted publishing for `publish.yml` is **not configured**; `0.2.0` was the
     manual bootstrap without a provenance attestation.
   - **#162** MCP registry publish — claimed by Antruly-dev-3; the prep (#191)
     merged, so the remaining gate is the `mcp-publisher` GitHub authorization.
2. **Windows/MSVC.** #166 recovered on its own: the `Windows MSVC toolchain
   (default)` lane passed at 07:52Z with a real anonymous Chocolatey install
   after three failures in the preceding 25 minutes. The durability decision —
   wait and rerun, pin the SourceForge archive the package downloads, or skip the
   route with a named reason — is still the maintainer's; the issue stays open to
   keep the intermittent record.
3. **Documentation and status accuracy.** #206 (this refresh) and #207 (the
   observed GitHub Packages mirror) are the two open documentation tasks.
4. **Upstream watch.** #41 is blocked on Stryker's upstream vitest-runner
   (#6210/#6214). A libuvcpp defect belongs in the libuvcpp repository, not in a
   local patch.

## Claimable first-stage tasks

Claim by commenting with your identity, as described in
[AI engineer operations](ai-engineer-operations.md#task-taking-mode). At this
snapshot every open task is claimed or waiting on a decision outside an
engineer's hands.

| Task                                 | Issue | Current state                                                           |
| ------------------------------------ | ----- | ----------------------------------------------------------------------- |
| Work plan refresh                    | #206  | **Claimed by Antruly-dev-1**                                            |
| GitHub Packages mirror documentation | #207  | **Claimed by Antruly-dev-2**                                            |
| MCP registry publish                 | #162  | **Claimed by Antruly-dev-3**; #191 merged; publish waits on GitHub auth |
| Windows MSVC default lane durability | #166  | Maintainer decision: wait/rerun, pin, or skip with a named reason       |
| Mutation attribution                 | #41   | Upstream blocked; watch Stryker #6210/#6214                             |

#194 is the next release PR, not a claimable task: its remaining steps are the
owner's. One active task per engineer. The claim comment is the ownership record
until the tracker assignment exists.

## Suggested parallel lanes

These are recommendations for self-claiming, not assignments:

| Engineer      | Now                                      | Next                       |
| ------------- | ---------------------------------------- | -------------------------- |
| Antruly-dev-1 | #206 work plan refresh                   | Review/approval            |
| Antruly-dev-2 | #207 mirror documentation                | Review/approval            |
| Antruly-dev-3 | #162 MCP registry publish (auth pending) | Verify listing + handshake |

The lanes are independent until the execute gate. An engineer who finishes early
may claim an eligible task from a new issue; one active task per engineer still
applies.

## Open work at this snapshot

| Area                        | Issue | PR   | Status                                        | Next                                                                        |
| --------------------------- | ----- | ---- | --------------------------------------------- | --------------------------------------------------------------------------- |
| Next release (0.3.0)        | —     | #194 | Release PR, no checks, rebased to `f173cde`   | Owner checklist; regenerate the SBOM on the release branch; record approval |
| Work plan refresh           | #206  | —    | Claimed by Antruly-dev-1                      | Open a PR against `main`                                                    |
| GitHub Packages mirror docs | #207  | —    | Claimed by Antruly-dev-2                      | Open a PR against `main`                                                    |
| MCP registry publish        | #162  | —    | Authorized; #191 merged; auth pending         | Complete `mcp-publisher login github`; publish 0.2.0                        |
| Windows MSVC CI             | #166  | —    | Recovered at 07:52Z; intermittency unresolved | Maintainer decision: wait/rerun, pin, or skip with a named reason           |
| Mutation attribution        | #41   | —    | Upstream blocked                              | Watch Stryker #6210/#6214                                                   |

Merged or closed since the previous snapshot: #182/#184 (the WebSocket handshake
bound), #189/#190 (the earlier work plan refresh), #163/#195 (clean-environment
setup acceptance), #179/#196 (first-release notes), #197/#198 (scoped GitHub
Packages mirror), #199/#200 (mirror bootstrap), #201/#202 and #203 (root-aware
version preflight), #204/#205 (pack JSON). Earlier merges — #87/#91, #122/#130,
#142/#143, #154/#155, #160/#177, #178/#193, #185, #187, #188, #191, #192 — remain
closed. The open issues above are each claimed or waiting on a maintainer
decision, so a competing claim or PR would duplicate ownership rather than start
the work.

## Next work not yet tracked

These are candidate areas. Open an issue (or a design discussion, where the
contribution scope requires one) if you intend to own one:

- README/status/FAQ updates beyond the first-release notes (#179/#196);
- a Windows VS-version coverage check after #154/#155;
- regressions around the HTTP/2 and WebSocket fixes (#185, #184) now that those
  lanes have run on the merged code;
- a decision and fix for #166 if the maintainer chooses to repair the CI route
  rather than wait;
- determining the GitHub Packages mirror's package visibility, which is unknown
  because the local token lacks `read:packages` (see #207); this needs a
  credential decision rather than a code change;
- richer application templates only if the maintainer decides the scope (auth,
  OpenAPI, fuller CRUD patterns); the current templates are deliberately minimal.

## Available directions for contributors

You may propose or claim work in these directions. Follow the contribution scope
and the identity/task-taking rules.

| Direction                     | What is useful                                        | Why                                                        |
| ----------------------------- | ----------------------------------------------------- | ---------------------------------------------------------- |
| Release engineering           | #194's remaining owner steps; trusted publisher; #162 | Turns the published package into a repeatable release path |
| Release documentation         | #206, #207; README/status follow-ups                  | Makes the release claims match the observed lanes          |
| Windows/MSVC                  | #166 decision; VS-version coverage check              | Makes the Windows claims observed rather than inferred     |
| Runtime/workspace reliability | regressions for the HTTP/2 and WebSocket fixes        | Guards the correctness fixes that just landed              |
| Upstream tracking             | Stryker #41; libuvcpp issues in the libuvcpp repo     | Keeps uvp's own scope clean                                |

If you need help, leave the task unclaimed in the plan/issue so another engineer
can pick it up. If you cannot solve it, hand it back with evidence; do not leave
it silently stalled.

## Not planned

These are deliberate boundaries from the roadmap and contribution scope. Do not
start them as part of a bug fix or a first release:

- a uvp runtime library;
- a C++ MCP SDK;
- a production deployment or scaling tool;
- a general-purpose load generator;
- a hosted service;
- patching or vendoring libuvcpp inside uvp.

## Release readiness

`uvp-agents@0.2.0` is published on npm; the registry's shasum and integrity match
the verified tarball, and a clean install reports `uvp-agents 0.2.0`. The first
publish was the manual bootstrap, so `0.2.0` has no provenance attestation.

#194 is the open `0.3.0` release PR. Before merging it the owner must cut or
defer `0.3.0`, run `npm run docs:generate` on the release branch (the SBOM at
`f173cde` still says `0.2.0`), run `npm run docs:check` and the pre-release
checks locally because no CI runs on the PR, and record the approval. Trusted
publishing for `publish.yml` must be configured before the next release is
published through the workflow. #162 (MCP registry) is authorized and its prep
has merged; the remaining gate is the GitHub device authorization. The GitHub
Packages mirror is a second distribution route, not a second identity: the
canonical install and `server.json` stay on npm, and the observed 0.2.0 mirror
facts are recorded by #207.

## How to claim

1. Read [AI engineer operations](ai-engineer-operations.md) and confirm your
   identity in `dev-identity.md`.
2. Pick an eligible task. At this snapshot every open task is claimed or waiting
   on a maintainer decision; a new issue is needed for additional work.
3. Post the claim comment with your identity marker.
4. Update your local identity file and start work.
5. Hand back with evidence if you cannot finish; do not leave a silent stall.
