# Current development plan

**Snapshot:** 2026-10-17T11:17Z. This is a snapshot, not a live dashboard. The
direction lead updates it per batch with the maintainer's approval; counts and
open items will drift between snapshots.

This page answers three questions for an AI engineer or a contributor:

1. what is already working;
2. what is being worked on now;
3. which direction is useful next, and how to claim it.

Follow [the AI development workflow](agent-workflow.md) and
[AI engineer operations](ai-engineer-operations.md) before claiming anything.

## Where we are

- **78 merged PRs**, **76 closed issues**; **10 open issues**, **2 open PRs** at
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

## Current direction

1. **Release automation and the first public release.** This is the critical
   path. The package is not yet published, so `npx uvp-agents setup` is not real
   until the release pipeline exists.
   - **#160** release-please workflow — claimed by Antruly-dev-1; PR #177 is the
     in-progress draft.
   - **#161** npm publish — implementation may start now; merge/publish only after
     #160 lands.
   - **#162** MCP registry publish — validation/dry-run may start now; publish
     only after #161.
   - **#163** clean-environment setup acceptance — harness/tests may start now;
     the real `npx` run only after #161.
   - **#178** first-release support matrix — independent, open and unclaimed
     after the earlier claim was released; can start now.
   - **#179** first-release notes and upgrade guidance — independent, can start
     now; finalize before the release PR merges.
2. **Windows/MSVC polish.** MSVC link diagnostics (#142 / PR #143) and the
   Windows database refusal path (#108) have landed. The remaining tracked item
   is the external Chocolatey/pkgconfiglite failure on the Windows MSVC lane
   (#166); the maintainer decides whether to wait, rerun, pin, or mark it a named
   gap.
3. **Remaining reliability fix.** Workspace-name validation (#87 / PR #91): the
   review's blocking reserved-name finding was fixed at `dc91b78`; CI is green
   and the PR is a draft awaiting re-review. It is not a new claim.
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

| Task                                     | Issue | Can start              | Execute after            | Status                                   |
| ---------------------------------------- | ----- | ---------------------- | ------------------------ | ---------------------------------------- |
| Release-please workflow                  | #160  | Now                    | —                        | **Claimed by Antruly-dev-1**; PR #177    |
| npm publish                              | #161  | Now                    | #160 and the release tag | Open, unclaimed                          |
| MCP registry publish                     | #162  | Now (validate/dry-run) | #161                     | Open, unclaimed                          |
| Clean-environment setup acceptance       | #163  | Now (harness/tests)    | #161                     | Open, unclaimed                          |
| First-release support matrix             | #178  | Now                    | —                        | Open, unclaimed (earlier claim released) |
| First-release notes and upgrade guidance | #179  | Now                    | #161 for final content   | Open, unclaimed                          |

One active task per engineer. The claim comment is the ownership record until the
tracker assignment exists. Do not merge, publish, or run the final acceptance
before the dependency has landed. Antruly-dev-1 briefly claimed #178, released it
at 11:25:10Z to keep one active task, and no branch or PR was opened for it.

## Suggested parallel lanes

These are recommendations for self-claiming, not assignments:

| Engineer      | Now                          | Next                                               |
| ------------- | ---------------------------- | -------------------------------------------------- |
| Antruly-dev-1 | #160 (in progress)           | #161 npm publish                                   |
| Antruly-dev-2 | #178 support matrix          | #179 release notes                                 |
| Antruly-dev-3 | #91 re-review/merge (author) | #162 registry validation/dry-run → #163 after #161 |

The lanes are independent until the execute gate. An engineer who finishes early
may claim the next task in the table; one active task per engineer still applies.

## Open work at this snapshot

| Area                      | Issue | PR  | Status                      | Next                                     |
| ------------------------- | ----- | --- | --------------------------- | ---------------------------------------- |
| Workspace name validation | #87   | #91 | PR clean, draft (`dc91b78`) | Awaiting re-review; no new claim         |
| Windows MSVC CI           | #166  | —   | External Chocolatey failure | Maintainer decision: wait/rerun/pin/skip |
| Mutation attribution      | #41   | —   | Upstream blocked            | Watch Stryker #6210/#6214                |

#122/#130 and #142/#143 are merged/closed. Do not open a competing PR for an
issue that already has one.

## Next work not yet tracked

These are candidate areas. Open an issue (or a design discussion, where the
contribution scope requires one) if you intend to own one:

- README/status/FAQ updates beyond #178/#179;
- a Windows VS-version coverage check after #154/#155;
- workspace/verification reliability fixes beyond the current open issues;
- a decision and fix for #166 if the maintainer chooses to repair the CI route
  rather than wait;
- richer application templates only if the maintainer decides the scope (auth,
  OpenAPI, fuller CRUD patterns); the current templates are deliberately minimal.

## Available directions for contributors

You may propose or claim work in these directions. Follow the contribution scope
and the identity/task-taking rules.

| Direction                     | What is useful                                                 | Why                                                     |
| ----------------------------- | -------------------------------------------------------------- | ------------------------------------------------------- |
| Release engineering           | #160–#163: release-please, npm, MCP registry, setup acceptance | Unblocks the stated goal: an AI can install and use uvp |
| Release documentation         | #178 support matrix, #179 release notes                        | Makes the release claims match the observed lanes       |
| Windows/MSVC                  | #166 decision; VS-version coverage check                       | Makes the Windows claims observed rather than inferred  |
| Runtime/workspace reliability | review/finish #91; add regressions                             | Closes the remaining correctness gap                    |
| Agent onboarding              | #163: setup → doctor → create → build → run → verify           | Proves the MCP path end to end                          |
| Upstream tracking             | Stryker #41; libuvcpp issues in the libuvcpp repo              | Keeps uvp's own scope clean                             |

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

The current estimate is **about one to two weeks of focused work** for a first
public release. The critical path is #160 → #161 → #162/#163, with #178/#179 in
parallel and #91 awaiting re-review after the author's `dc91b78` fix. The release pipeline has never been
run, so this estimate is derived rather than observed.

## How to claim

1. Read [AI engineer operations](ai-engineer-operations.md) and confirm your
   identity in `dev-identity.md`.
2. Pick an eligible task. For #160–#163, respect the execute gate: prep may start
   now; merge/publish/acceptance waits for the dependency.
3. Post the claim comment with your identity marker.
4. Update your local identity file and start work.
5. Hand back with evidence if you cannot finish; do not leave a silent stall.
