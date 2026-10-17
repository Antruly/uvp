# Current development plan

**Snapshot:** 2026-10-17T12:10Z. This is a snapshot, not a live dashboard. The
direction lead updates it per batch with the maintainer's approval; counts and
open items will drift between snapshots.

This page answers three questions for an AI engineer or a contributor:

1. what is already working;
2. what is being worked on now;
3. which direction is useful next, and how to claim it.

Follow [the AI development workflow](agent-workflow.md) and
[AI engineer operations](ai-engineer-operations.md) before claiming anything.

## Where we are

- **82 merged PRs**, **80 closed issues**; **10 open issues**, **7 open PRs** at
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

The core product is therefore **feature-complete for the current scope**. The
largest remaining gap is not a feature: **release automation and publishing**.
The first release PR is open as #188.

## Current direction

1. **The first public release.** Release PR #188 is open at `uvp-agents 0.2.0`.
   It has **no CI checks** (a GITHUB_TOKEN-created PR does not trigger
   `pull_request` workflows), so the owner runs the pre-merge checklist on its
   comment: decide the version and whole-history changelog, run
   `npm run docs:generate` on the release branch, run the pre-release checks,
   record the human approval, and merge. Merging #188 tags the commit and creates
   the GitHub release; it does **not** publish to npm.
   - **#161** npm publish — **claimed by Antruly-dev-1**; prep PR #192 adds a
     manual `workflow_dispatch` publish with npm trusted publishing (OIDC), a
     tag/version preflight, and the clean-prefix verification. No publication
     yet; it waits for #188 to merge and a tag.
   - **#162** MCP registry publish — **claimed by Antruly-dev-3**; prep PR #191
     fixed a real schema failure (`server.json` description was 113 characters,
     the schema caps it at 100) and added a registry check to `metadata:check`.
     No publication yet.
   - **#163** clean-environment setup acceptance — open; the real `npx` run waits
     for #161.
   - **#178** first-release support matrix — **claimed by Antruly-dev-2**; PR
     #193 adds `docs/support-matrix.md` and links it from the release docs. CI is
     running.
   - **#179** first-release notes and upgrade guidance — open; Antruly-dev-2
     takes it after #178.
2. **Windows/MSVC.** The MSVC link diagnostics and Windows database fixes have
   landed. The remaining tracked item is the external Chocolatey/pkgconfiglite
   failure on the Windows MSVC lane (#166); the maintainer decides whether to
   wait, rerun, pin, or mark it a named gap.
3. **Remaining reliability.** #91 is merged. The open bug PRs are #184 (#182,
   WebSocket opening handshake) and #185 (#183, HTTP/2 abandoned session); both
   are draft and clean, awaiting their owners' final review/approval.
4. **Documentation and status accuracy.** #178 (support matrix) and #179
   (release notes) are the parallel documentation lane.
5. **Agent onboarding acceptance.** #163 is the clean-environment proof of
   `setup` → MCP configuration → `uvp_doctor` → generate → build → run → verify.
6. **Upstream watch.** #41 is blocked on Stryker's upstream vitest-runner
   (#6210/#6214). A libuvcpp defect belongs in the libuvcpp repository, not in a
   local patch.

## Claimable first-stage tasks

Claim by commenting with your identity, as described in
[AI engineer operations](ai-engineer-operations.md#task-taking-mode). The
dependency is on **merge/publish/execute**, not on starting the preparation.

| Task                                     | Issue | Can start              | Execute after          | Status                                |
| ---------------------------------------- | ----- | ---------------------- | ---------------------- | ------------------------------------- |
| npm publish                              | #161  | Now                    | #188 merge and tag     | **Claimed by Antruly-dev-1**; PR #192 |
| MCP registry publish                     | #162  | Now (validate/dry-run) | #161                   | **Claimed by Antruly-dev-3**; PR #191 |
| Clean-environment setup acceptance       | #163  | Now (harness/tests)    | #161                   | Open, unclaimed                       |
| First-release support matrix             | #178  | Now                    | —                      | **Claimed by Antruly-dev-2**; PR #193 |
| First-release notes and upgrade guidance | #179  | Now                    | #161 for final content | Open; Antruly-dev-2 next              |

#160 is closed; #188 is the release PR, not a claimable task. One active task per
engineer. The claim comment is the ownership record until the tracker assignment
exists.

## Suggested parallel lanes

These are recommendations for self-claiming, not assignments:

| Engineer      | Now                                             | Next                             |
| ------------- | ----------------------------------------------- | -------------------------------- |
| Antruly-dev-1 | #161 npm publish preparation (claimed, PR #192) | Publish after #188 merges/tags   |
| Antruly-dev-2 | #178 support matrix (claimed, PR #193)          | #179 release notes               |
| Antruly-dev-3 | #162 registry preparation (claimed, PR #191)    | #163 setup acceptance after #161 |

The lanes are independent until the execute gate. An engineer who finishes early
may claim the next task in the table; one active task per engineer still applies.

## Open work at this snapshot

| Area                        | Issue | PR   | Status                                            | Next                                          |
| --------------------------- | ----- | ---- | ------------------------------------------------- | --------------------------------------------- |
| First public release        | —     | #188 | Release PR, no CI, `autorelease: pending`         | Owner pre-merge checklist; then merge         |
| npm publish preparation     | #161  | #192 | Draft PR, clean; OIDC publish + version preflight | Review; apply `ai-assisted`; publish is gated |
| MCP registry preparation    | #162  | #191 | Draft PR, clean; schema fix + metadata check      | Review; apply `ai-assisted`; publish is gated |
| Support matrix              | #178  | #193 | Draft PR, CI running                              | Review; apply `ai-assisted`; then #179        |
| WebSocket opening handshake | #182  | #184 | Draft PR, clean                                   | Owner review/approval                         |
| HTTP/2 abandoned session    | #183  | #185 | Draft PR, clean                                   | Owner review/approval                         |
| Windows MSVC CI             | #166  | —    | External Chocolatey failure                       | Maintainer decision: wait/rerun/pin/skip      |
| Mutation attribution        | #41   | —    | Upstream blocked                                  | Watch Stryker #6210/#6214                     |

#87/#91, #122/#130, #142/#143, #154/#155, and #160/#177 are merged/closed. Do
not open a competing PR for an issue that already has one.

## Next work not yet tracked

These are candidate areas. Open an issue (or a design discussion, where the
contribution scope requires one) if you intend to own one:

- README/status/FAQ updates beyond #178/#179;
- a Windows VS-version coverage check after #154/#155;
- reliability fixes beyond #184/#185;
- a decision and fix for #166 if the maintainer chooses to repair the CI route
  rather than wait;
- richer application templates only if the maintainer decides the scope (auth,
  OpenAPI, fuller CRUD patterns); the current templates are deliberately minimal.

## Available directions for contributors

You may propose or claim work in these directions. Follow the contribution scope
and the identity/task-taking rules.

| Direction                     | What is useful                                       | Why                                                          |
| ----------------------------- | ---------------------------------------------------- | ------------------------------------------------------------ |
| Release engineering           | #161–#163: npm, MCP registry, setup acceptance       | Turns the merged release PR into a published, usable package |
| Release documentation         | #178 support matrix, #179 release notes              | Makes the release claims match the observed lanes            |
| Windows/MSVC                  | #166 decision; VS-version coverage check             | Makes the Windows claims observed rather than inferred       |
| Runtime/workspace reliability | finish/review #184 and #185; add regressions         | Closes the remaining correctness gaps                        |
| Agent onboarding              | #163: setup → doctor → create → build → run → verify | Proves the MCP path end to end                               |
| Upstream tracking             | Stryker #41; libuvcpp issues in the libuvcpp repo    | Keeps uvp's own scope clean                                  |

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

A first public release should mean: the npm package is published, the MCP
registry entry resolves, `npx uvp-agents setup` works in a clean environment, and
the documented support matrix matches the lanes that actually ran.

Release PR #188 is open at `0.2.0`. The owner must decide the version and
whole-history changelog, run `npm run docs:generate` and the pre-release checks on
the release branch, record the approval, and merge. Merging #188 creates the tag
and GitHub release; #161 publishes to npm, then #162/#163. The prep work is in
progress: #161 is dev-1's PR #192, #162 is dev-3's PR #191, and #178 is dev-2's
PR #193. #184/#185 await review/approval. The release pipeline is now observed up
to the open PR; the publish path is still unobserved.

## How to claim

1. Read [AI engineer operations](ai-engineer-operations.md) and confirm your
   identity in `dev-identity.md`.
2. Pick an eligible task. For #161–#163, respect the execute gate: prep may start
   now; merge/publish/acceptance waits for the dependency.
3. Post the claim comment with your identity marker.
4. Update your local identity file and start work.
5. Hand back with evidence if you cannot finish; do not leave a silent stall.
