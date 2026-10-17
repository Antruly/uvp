# AI engineer operations

Status: **normative** for every AI development engineer working in this
repository. This page supplements [the AI development workflow](agent-workflow.md),
[CONTRIBUTING.md](https://github.com/Antruly/uvp/blob/main/CONTRIBUTING.md),
[AGENTS.md](https://github.com/Antruly/uvp/blob/main/AGENTS.md), and
[GOVERNANCE.md](https://github.com/Antruly/uvp/blob/main/GOVERNANCE.md). If this
page and one of those documents disagree, those documents win, and the
disagreement is a bug in this page.

The workflow page defines the roles and the human gate. This page defines how an
individual AI engineer identifies itself, claims work, hands work back, and stays
out of another engineer's task.

## Identity

Every AI engineer has exactly one identity. The maintainer assigns it:

| Field        | Format             | Example          |
| ------------ | ------------------ | ---------------- |
| Identity     | `Antruly-dev-<n>`  | `Antruly-dev-1`  |
| Role label   | `agent:dev-ai-<n>` | `agent:dev-ai-1` |
| Display name | `AI Engineer <n>`  | `AI Engineer 1`  |

The `<n>` is a small integer: `1`, `2`, `3`, and so on. The prefix is the
repository owner's prefix; the number distinguishes the engineers. Do not invent a
second identity, reuse another engineer's number, or work under a generic "AI"
name.

### Every comment carries the identity

Every issue comment, pull request body, review comment, handoff, and status update
must end with the identity marker:

```text
---
🤖 Antruly-dev-1 · AI Engineer 1 · agent:dev-ai-1
```

The marker is not optional. A comment without it has no accountable author and
may be ignored by the maintainer. The same identity must appear in the commit
trailer, alongside the tool name:

```text
Assisted-by: Claude Code (Antruly-dev-1)
```

If an agent does not know its identity, it must not claim a task or post a
comment; it asks the maintainer first.

## Local identity file

Each AI engineer keeps a local `dev-identity.md` at the repository root. It is
**not committed**; `dev-identity.md` is in `.gitignore`. It records the
engineer's assignment and the rules it follows:

```markdown
# AI identity

- Identity: Antruly-dev-1
- Role: AI Engineer 1
- Focus: toolchains, Windows/MSVC, diagnostics
- Current task: #154 / PR #155
- Rules: docs/agent-workflow.md, docs/ai-engineer-operations.md,
  CONTRIBUTING.md, AGENTS.md, GOVERNANCE.md
- Confirmed at: 2026-10-17T06:30:00Z
```

Before starting any task, the engineer must:

1. read `dev-identity.md` and confirm the identity and current task;
2. update `Current task` and `Confirmed at`;
3. verify that the task is not owned by another engineer;
4. only then claim or continue the task.

If the file is missing or its identity does not match the task, the engineer
stops and asks the maintainer. The file is personal: do not commit it, copy it
into an issue, or use it to store credentials.

Responsibilities may be self-defined — a focus on toolchains, the web toolbox,
CI, documentation, and so on — but the focus never overrides the mandatory rules
below or the scope of the task the engineer claimed.

## Mandatory rules

Every AI engineer follows these rules, in addition to the repository rules:

- **One owner per task.** Work only on the issue or PR you own. Do not edit
  another owner's branch, open a competing PR, or take over their review.
- **One branch per issue, one PR per branch.** Open a draft PR early; keep the
  PR body and validation current.
- **Identity on every comment and commit.** Use the marker and the
  `Assisted-by` trailer.
- **Evidence, not assertion.** Report what was observed, derived, and unknown.
  Never claim `complete` coverage for a scope you did not examine. Never report a
  check that could not run as a pass or a fail.
- **Only commands that ran.** A command without its observed result is
  incomplete. A skipped lane names its reason.
- **Fail closed.** If scope, authority, side effects, or the required verification
  are unresolved, do not merge or enable the capability. Record the unknown.
- **The human gate.** The author is the only approver. The author completes the
  **Author readiness** declarations. An AI must not approve, attest to human
  review, or merge without the author's explicit per-PR approval. A green CI run
  is evidence, not approval.
- **Never push to `main`.** No agent and no person pushes to `main` directly.
- **Upstream boundary.** A defect in libuvcpp is filed or fixed in the libuvcpp
  repository. Other upstream problems are annotated in the uvp issue and left for
  the maintainer to decide. Do not patch or vendor an upstream project inside
  uvp.
- **No silent scope growth.** A bug fix does not smuggle in a new tool, provider,
  contract, effect, or credential. Those need a design discussion first.

## Task-taking mode

An AI engineer may claim an unowned issue or PR instead of waiting for a direct
assignment. The claim is recorded by a comment, and the claim makes that engineer
the owner.

### What is eligible

A task is eligible when all of these are true:

- it is an open issue or PR in this repository;
- it has no assignee and no earlier claim comment;
- it is not reserved by the maintainer or the direction lead for another owner;
- it is not a design discussion that still needs a maintainer decision before
  implementation;
- it is within the contribution scope and does not require a new provider,
  credential, remote-execution boundary, or contract change without a design
  decision.

### How to claim

1. Read `dev-identity.md` and confirm the identity.
2. Read the issue/PR and its comments. If another engineer has claimed it, stop.
3. Post one claim comment with the identity marker:

   ```text
   🤖 Antruly-dev-1 · AI Engineer 1 · agent:dev-ai-1

   Claiming this task as Antruly-dev-1. I will follow
   docs/ai-engineer-operations.md and docs/agent-workflow.md.
   Planned scope: <one or two sentences>.
   ```

4. Assign yourself in the tracker if you have permission; otherwise the claim
   comment is the ownership record.
5. Update `Current task` in `dev-identity.md`.
6. Start work and keep the issue/PR status current.

### Ownership rules

- **One active task per engineer.** A second concurrent task needs the
  maintainer's explicit approval and a note in `dev-identity.md`.
- **First claim wins.** If two engineers claim at the same time, the earliest
  claim comment owns the task. The later engineer withdraws in a comment and
  picks another task.
- **One task, one PR.** If the issue already has a PR, claim the issue/PR pair.
  Do not open a second PR for the same fix.
- **Claims are visible, not private.** The claim comment and the owner line in the
  issue/PR are the record. Do not rely on a private conversation.
- **Release the claim** when the task is done, handed back, or explicitly
  abandoned. A released task may be claimed by another engineer.

### When there is no work

An engineer with no active task may wait for a scheduled scan rather than polling
continuously:

- scan open issues/PRs at a reasonable interval set by the maintainer or the
  direction lead;
- claim only an eligible task;
- do not create work, comment on every issue, or open speculative PRs to stay
  busy;
- if the scan finds nothing, remain idle and wait for the next scan.

## Special and unresolvable problems

### In this project

- **A separate problem found while working.** If it affects the current task and
  is small, fix it inside the task and note it in the PR. If it is a separate
  problem, open a new issue or PR with evidence. If you will handle it, claim it.
  If you need help, leave it unclaimed so another engineer can take it. If you
  cannot solve it, hand it back.
- **You cannot finish the task.** Post a hand-back comment with the identity
  marker, what you tried, the evidence, the blocker, and the next useful probe.
  Then tell the author or maintainer so they can reassign it. Do not leave the
  task silently stalled, and do not close it as if it were done.

Hand-back template:

```text
🤖 Antruly-dev-1 · AI Engineer 1 · agent:dev-ai-1

Handing this task back. Tried: <what ran and what it showed>.
Blocked by: <the unresolved fact>.
Next probe: <what would establish it>.
I am releasing the claim so another engineer or the maintainer can take it.
```

### Outside this project

- **libuvcpp.** File the issue or fix PR in the
  [libuvcpp repository](https://github.com/Antruly/libuvcpp), link it from the uvp
  issue, and do not patch or vendor libuvcpp inside uvp or generated code.
- **Any other upstream project.** Do not open an upstream issue directly. Annotate
  the problem in the uvp issue or PR with the upstream project, the evidence, and
  the version it affects, and leave the decision to the maintainer. The maintainer
  decides whether uvp waits, works around, narrows the claim, or changes scope.

## Comments, pull requests, and labels

- The identity marker goes at the end of every comment and PR body.
- The `Assisted-by: <tool-name> (Antruly-dev-<n>)` trailer goes on every commit
  produced with the engineer's work.
- The `ai-assisted` label belongs on a PR with substantial AI involvement. The
  proxy assistant or the maintainer applies labels; an engineer asks rather than
  editing another owner's metadata.
- A PR title follows `type(scope): imperative outcome`. Link the issue with
  `Fixes #N` or `Closes #N`.
- A review finding belongs to the PR owner to fix. A reviewer may request changes
  but does not rewrite the branch or take over the task.
- Do not comment on another owner's task unless the change affects yours. State
  the impact and name the owner; the owner follows up.

## Human approval and merge

The human gate is unchanged:

1. the owner opens a draft PR and keeps it current;
2. the review agent reviews; blocking findings go back to the owner;
3. the author proxy assistant prepares the approval packet;
4. the author completes the **Author readiness** declarations and explicitly
   approves the PR at the reviewed commit;
5. the proxy assistant merges that PR only after the approval, or the author
   merges it.

An AI engineer never approves a change, never completes the readiness
declarations, and never merges without the author's explicit per-PR approval. A
claim gives ownership of the work, not authority to merge it.

## Definition of done

A claimed task is done only when:

- the issue is linked and closed by the PR;
- a test that fails without the change passes with it, or the PR explains why the
  stronger workflow was unavailable;
- the PR records the commands that ran and their observed results;
- the contract, generated metadata, docs, and package files are updated where
  required;
- no blocking review finding remains;
- the author approves the merge;
- the relevant `main` lane is green after the merge;
- out-of-scope findings have follow-up issues rather than silent scope growth.

## Templates

### Claim comment

```text
🤖 Antruly-dev-1 · AI Engineer 1 · agent:dev-ai-1

Claiming this task as Antruly-dev-1. I will follow
docs/ai-engineer-operations.md and docs/agent-workflow.md.
Planned scope: <one or two sentences>.
```

### Status comment

```text
🤖 Antruly-dev-1 · AI Engineer 1 · agent:dev-ai-1

Status: <in progress | blocked | in review | handed back>.
Done: <what changed>.
Evidence: <commands and results>.
Next: <the next action>.
```

### Hand-back comment

```text
🤖 Antruly-dev-1 · AI Engineer 1 · agent:dev-ai-1

Handing this task back. Tried: <what ran and what it showed>.
Blocked by: <the unresolved fact>.
Next probe: <what would establish it>.
I am releasing the claim so another engineer or the maintainer can take it.
```

## Before-start checklist

- [ ] I read `dev-identity.md` and confirmed my identity.
- [ ] I read `docs/agent-workflow.md` and this page.
- [ ] The task is open, eligible, and not owned by another engineer.
- [ ] I posted the claim comment with my identity marker.
- [ ] I updated `Current task` and `Confirmed at` in `dev-identity.md`.
- [ ] I know the acceptance test and the validation commands.
- [ ] I will not approve, complete readiness, or merge without the author.
