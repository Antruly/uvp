# Current development plan

**Snapshot:** 2026-10-17T14:29Z. This is a snapshot, not a live dashboard. The
direction lead updates it per batch with the maintainer's approval; counts and
open items will drift between snapshots.

This page answers three questions for an AI engineer or a contributor:

1. what is already working;
2. what is being worked on now;
3. which direction is useful next, and how to claim it.

Follow [the AI development workflow](agent-workflow.md) and
[AI engineer operations](ai-engineer-operations.md) before claiming anything.

## Where we are

- **87 merged PRs**, **83 closed issues**; **7 open issues**, **5 open PRs** at
  this snapshot.
- **Roadmap:** 50 of 54 marked items are done. The four open rows are
  `remote-ssh/` (blocked on verification), two CI observations/flakes, and the
  Ubuntu 26.04 migration watch.
- **Milestone 1:** complete. The full describe → generate → build → run → probe →
  evidence loop works for all six templates against real libuvcpp.
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
`0.3.0`, is already open.

For the 0.2.0 release, #188's CI was green at `b973f27`; the regenerated derived
files were already in that commit, so the `docs:generate` step was done before
the merge.

## Current direction

1. **Release.** `uvp-agents@0.2.0` is live; #188 merged, the tag and GitHub
   release exist, and #161 is closed. #191 (MCP registry prep) and #192 (npm
   publish prep) are merged. #194 is the open `0.3.0` release PR with no checks;
   the owner must decide whether to cut it, run `npm run docs:generate` on the
   release branch, run the pre-release checks, and record the approval. Trusted
   publishing for `publish.yml` is **not configured yet**; `0.2.0` was the manual
   bootstrap without a provenance attestation.
   - **#162** MCP registry publish — authorized by the maintainer; #191 has
     landed, so the remaining gate is the `mcp-publisher` GitHub authorization.
   - **#163** clean-environment setup acceptance — claimed by Antruly-dev-1; PR
     #195 is open.
   - **#179** first-release notes and upgrade guidance — claimed by
     Antruly-dev-2; PR #196 is open.
2. **Windows/MSVC.** The remaining tracked item is the external
   Chocolatey/pkgconfiglite failure on the Windows MSVC lane (#166); the
   maintainer decides whether to wait, rerun, pin, or mark it a named gap.
3. **Remaining reliability.** #184's blocking finding (an abandoned request was
   not destroyed) was addressed at `5be6fbb`; it awaits re-review and approval.
   #185 is merged.
4. **Documentation and status accuracy.** #178 merged; #179 is now PR #196.
5. **Agent onboarding acceptance.** #163 is the clean-environment proof of
   `setup` → MCP configuration → `uvp_doctor` → generate → build → run → verify;
   PR #195 is open.
6. **Upstream watch.** #41 is blocked on Stryker's upstream vitest-runner
   (#6210/#6214). A libuvcpp defect belongs in the libuvcpp repository, not in a
   local patch.

## Claimable first-stage tasks

Claim by commenting with your identity, as described in
[AI engineer operations](ai-engineer-operations.md#task-taking-mode). At this
snapshot all first-stage tasks are claimed; the remaining work is review,
approval, and the owner's release actions.

| Task                                     | Issue | Current state                                                           |
| ---------------------------------------- | ----- | ----------------------------------------------------------------------- |
| MCP registry publish                     | #162  | **Claimed by Antruly-dev-3**; #191 merged; publish waits on GitHub auth |
| Clean-environment setup acceptance       | #163  | **Claimed by Antruly-dev-1**; PR #195                                   |
| First-release notes and upgrade guidance | #179  | **Claimed by Antruly-dev-2**; PR #196                                   |

#161 is closed; #188 is merged; #194 is the next release PR, not a claimable
task. One active task per engineer. The claim comment is the ownership record
until the tracker assignment exists.

## Suggested parallel lanes

These are recommendations for self-claiming, not assignments:

| Engineer      | Now                                      | Next                       |
| ------------- | ---------------------------------------- | -------------------------- |
| Antruly-dev-1 | #163 setup acceptance (PR #195)          | Review/approval            |
| Antruly-dev-2 | #179 release notes (PR #196)             | Review/approval            |
| Antruly-dev-3 | #162 MCP registry publish (auth pending) | Verify listing + handshake |

The lanes are independent until the execute gate. An engineer who finishes early
may claim an eligible task from a new issue; one active task per engineer still
applies.

## Open work at this snapshot

| Area                    | Issue | PR   | Status                                         | Next                                                 |
| ----------------------- | ----- | ---- | ---------------------------------------------- | ---------------------------------------------------- |
| Next release (0.3.0)    | —     | #194 | Release PR, no checks, `autorelease: pending`  | Owner pre-merge checklist; decide whether to cut     |
| Work plan refresh       | #189  | #190 | Draft; review corrections applied              | Re-review; owner readiness/approval                  |
| Workspace handshake fix | #182  | #184 | Draft; blocking finding addressed at `5be6fbb` | Re-review and approval                               |
| Setup acceptance        | #163  | #195 | Draft, clean                                   | Review/approval                                      |
| Release notes           | #179  | #196 | Draft, CI running                              | Review/approval                                      |
| MCP registry publish    | #162  | —    | Authorized; #191 merged; auth pending          | Complete `mcp-publisher login github`; publish 0.2.0 |
| Windows MSVC CI         | #166  | —    | External Chocolatey failure                    | Maintainer decision: wait/rerun/pin/skip             |
| Mutation attribution    | #41   | —    | Upstream blocked                               | Watch Stryker #6210/#6214                            |

#87/#91, #122/#130, #142/#143, #154/#155, #160/#177, #178/#193, #185, #188,
#191, and #192 are merged/closed. Do not open a competing PR for an issue that
already has one.

## Next work not yet tracked

These are candidate areas. Open an issue (or a design discussion, where the
contribution scope requires one) if you intend to own one:

- README/status/FAQ updates beyond #179/#196;
- a Windows VS-version coverage check after #154/#155;
- reliability fixes beyond #184;
- a decision and fix for #166 if the maintainer chooses to repair the CI route
  rather than wait;
- richer application templates only if the maintainer decides the scope (auth,
  OpenAPI, fuller CRUD patterns); the current templates are deliberately minimal.

## Available directions for contributors

You may propose or claim work in these directions. Follow the contribution scope
and the identity/task-taking rules.

| Direction                     | What is useful                                            | Why                                                        |
| ----------------------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| Release engineering           | trusted publisher, #194, #162                             | Turns the published package into a repeatable release path |
| Release documentation         | #179/#196; README/status follow-ups                       | Makes the release claims match the observed lanes          |
| Windows/MSVC                  | #166 decision; VS-version coverage check                  | Makes the Windows claims observed rather than inferred     |
| Runtime/workspace reliability | re-review/approve #184; add regressions                   | Closes the remaining correctness gaps                      |
| Agent onboarding              | #163/#195: setup → doctor → create → build → run → verify | Proves the MCP path end to end                             |
| Upstream tracking             | Stryker #41; libuvcpp issues in the libuvcpp repo         | Keeps uvp's own scope clean                                |

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

`uvp-agents@0.2.0` is published; the registry's shasum and integrity match the
verified tarball, and a clean install reports `uvp-agents 0.2.0`. The first
publish was the manual bootstrap, so `0.2.0` has no provenance attestation.

#194 is the open `0.3.0` release PR. Before merging it the owner must decide
whether to cut `0.3.0`, run `npm run docs:generate` on the release branch (the
same Option B step as #188), run the pre-release checks, and record the approval.
Trusted publishing for `publish.yml` must be configured before the next release
is published through the workflow. #162 (MCP registry) is authorized and its prep
has merged; the remaining gate is the GitHub device authorization. #163 (setup
acceptance) is PR #195; #179 (release notes) is PR #196.

## How to claim

1. Read [AI engineer operations](ai-engineer-operations.md) and confirm your
   identity in `dev-identity.md`.
2. Pick an eligible task. At this snapshot the first-stage tasks are claimed; a
   new issue is needed for additional work.
3. Post the claim comment with your identity marker.
4. Update your local identity file and start work.
5. Hand back with evidence if you cannot finish; do not leave a silent stall.
