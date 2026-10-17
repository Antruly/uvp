# Governance

uvp is a small project with a deliberately simple decision process. This document
says who decides what, and what evidence a decision needs.

## Roles

**Maintainer.** Merges to `main`, publishes releases, and holds the final say on
scope. The maintainer is the only role that can approve a change involving target
interaction, credentials, or a remote execution boundary.

**Contributor.** Anyone who opens an issue, a design discussion, or a pull
request. Contributors do not need permission to propose; the proposal gate is on
integration, not on discussion.

There is currently one maintainer. As the project grows, contributors who have
landed several substantive changes and demonstrated the judgment described under
[Decision standards](#decision-standards) may be invited to become maintainers.

## Decision process

| Decision                                                            | Process                                                                          |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Bug fix, documentation, test                                        | A pull request. The maintainer reviews and merges.                               |
| New template                                                        | A pull request with a built-and-run demonstration.                               |
| New tool, or a change to a tool's contract                          | A design discussion first, then a pull request.                                  |
| New provider, or any new ability to reach outside the local machine | A design discussion, an explicit maintainer scope decision, then a pull request. |
| Change to the error contract or the evidence model                  | A design discussion, then a pull request with migration notes.                   |
| Breaking change                                                     | The same as above, plus a `!` marker and migration notes in the changelog.       |

Anything not listed is a judgment call, and the maintainer will say which bucket
it fell into when a decision is made.

## Decision standards

A decision — approval, rejection, or deferral — is expected to rest on:

- **Evidence.** Which claims were observed, which were derived, and which remain
  unknown. A claim that a tool "works" needs a run, not a reading.
- **Scope fit.** Whether the capability belongs in uvp at all, judged by what it
  actually does rather than by what it is called. See
  [CONTRIBUTING.md#contribution-scope](CONTRIBUTING.md#contribution-scope).
- **Honesty of the output.** Whether the change preserves the distinction between
  observed, derived, and unknown in what it returns to callers.

A change that passes CI but reports `complete` for a scope it did not examine is
not approvable. That is the one rule this project treats as non-negotiable.

## Disagreement

Disagreement is welcome and should be specific: name the claim, the evidence
against it, and what would change your mind. If a decision is disputed and the
maintainer is the deciding party, the maintainer states the reasoning in the
thread. "Because I said so" is not a decision standard here; a disagreement that
cannot be resolved on evidence is resolved by the maintainer, and the reasoning
is recorded either way.

## Fail-closed default

When a scope, authority, or verification question is unresolved, the answer is
**no** — do not merge, do not enable, do not ship. Narrow the change or leave it
pending. Unresolved questions are recorded as unknowns rather than converted into
assumptions. Passing CI, a completed implementation, or upstream popularity is
not scope approval.

## Releases

Releases are automated. Pushes to `main` open or refresh a Release Please pull
request with the next version and changelog. The maintainer reviews it like any
other change; merging it starts publication. See
[docs/releasing.md](docs/releasing.md).

The project follows semantic versioning with one deliberate wrinkle: the version
increments **minor** on every release during the pre-1.0 period, including for
breaking changes. There is no `0.x.y` patch line, because a pre-1.0 project that
claims patch-level compatibility is making a promise it cannot keep.

## AI agents in this process

Agents may propose changes to their operator, draft code, and run verification.
With the operator's standing authorization, an agent may also open one branch per
tracked issue and one pull request against `main`, write the pull request
description, comment on the issue or pull request, answer review comments, and
merge that pull request once the human owner has explicitly approved it. The human
owner remains the party of record.

An agent never approves a change, never attests to human review, never completes
the **Author readiness** declarations, and never closes a pull request it did not
merge. Those stay the owner's. A green CI run is evidence, not approval. Without
the operator's authorization, an agent writes no branch and no pull request and
proposes the change to its operator instead. Nothing is pushed to `main` directly,
by an agent or by a person.

This is the same rule as
[CONTRIBUTING.md#ai-contribution-policy](CONTRIBUTING.md#ai-contribution-policy).
The two documents must not diverge.

## Changing this document

Open a pull request. Governance changes are reviewed by the same standard as
anything else, and a change that narrows transparency needs a stronger reason
than one that widens it.
