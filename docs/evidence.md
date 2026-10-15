# Evidence model

Every uvp tool returns evidence. Not a summary of evidence, and not prose about
what probably happened — the evidence itself, in a shape that separates what was
directly seen from what was computed, and that names what could not be
determined.

This page explains why that shape exists, what each part means, and how to read a
report without over-reading it.

## Observed, derived, unknown

Three kinds of statement, and a report that mixes them is a report you cannot
audit.

**Observed** — something uvp directly saw. An exit code. A byte count. A
response body. A line of compiler output. An HTTP status. `observed` is a
free-form record, but it is never a conclusion.

**Derived** — something computed from observations. A median latency. A pass/fail
verdict. A coverage ratio. Every derived value is explainable from `observed`,
and if it is not, it is in the wrong field.

**Unknown** — a question that was asked and could not be answered, recorded as a
`ResidualUnknown` with the question, the reason, and what blocked it.

The split matters because of what a caller does next. A human reading "the
service is healthy" can ask how you know. An agent cannot. Given
`observed.response.status_code = 200` alongside `derived.assertions_passed = 2`,
an agent can check the first against the world and decide whether to trust the
second.

So the rule is mechanical: **a fact goes in `observed` only if uvp saw it.** A
percentage is not observed. A verdict is not observed. A file's contents are
observed; its correctness is not.

## Coverage, and why silence is not a pass

```ts
interface Coverage {
  scope: string; // what this claim is about
  status: "complete" | "partial" | "unknown";
  examined?: number;
  total?: number;
  note?: string; // why it is partial
}
```

`complete` means the stated scope was examined without hitting a known read
limit. It is **never** a claim about anything outside that scope.

The load-bearing rule is the default. **Absent coverage information is
`unknown`, never `complete`.** A tool that did not track its own coverage does
not get to report full coverage because nothing went wrong.

This is the failure mode the rule exists to prevent. A verification run that
checks four of five assertions and then exits early because the process died must
not report `complete` for the assertion scope. It checked four. The fifth is not
"fine because we stopped asking".

`examined` and `total` are optional because not every scope has a count — but
when a scope does have one, a report missing them is a report to distrust.

## The evidence record

```ts
interface Evidence {
  evidence_id: string; // ev_ + 22 hex characters
  kind: EvidenceKind;
  subject: Record<string, unknown>;
  observed_at: string; // ISO 8601
  observed: Record<string, unknown>;
  derived: Record<string, unknown>;
  coverage: Coverage;
  sources: EvidenceSource[];
  limitations: string[];
}
```

**`evidence_id`** is generated, not sequential, so two runs cannot be confused by
their identifiers.

**`kind`** is one of `toolchain`, `build`, `launch`, `exchange`, `capture`,
`assertion`, `benchmark` — the seven things uvp produces evidence about.

**`subject`** identifies what this is evidence _about_, in a form that survives
the session. A path, a port, a method and URL. Two runs of the same check on the
same subject should produce the same `subject`, which is what makes them
comparable.

**`sources`** is provenance, and it is not optional. Every entry names its
`kind` — `command`, `file`, `endpoint`, or `process` — and a `ref`, with an
optional digest:

```ts
{ kind: "command", ref: "cmake --build build --target svc", digest: "sha256:…" }
{ kind: "endpoint", ref: "GET http://127.0.0.1:8080/items/1" }
{ kind: "file", ref: "/path/to/build/svc", digest: "sha256:…" }
```

A claim with no source is not evidence. It is an assertion, and callers are
entitled to treat it as one.

**`limitations`** is where uvp says what this evidence does not establish. "The
response body was capped at 1048576 bytes." "Only the first 200 exchange records were
retained." An empty array is an honest answer to "what are the limits?" only when
uvp genuinely found none.

**`digest`** is a _semantic_ digest, not a hash of the whole record: the same
claim about the same subject yields the same value. This is what lets two runs be
compared for agreement without diffing timestamps and identifiers.

## The envelope

Every tool result carries the same envelope:

```ts
{
  tool: string,
  provider: { id: string, version?: string, platform: string },
  evidence: EvidenceRef[],
  unknowns: ResidualUnknown[],
  limitations: string[]
}
```

**`provider`** is present on every result so that a finding is attributable. "The
build succeeded" means something different from a local GCC and from a container
whose libuvcpp is a different build. Without the provider, a result collected
from a remote toolchain is indistinguishable from a local one, and comparing them
across a fleet produces a conclusion that is not supported.

**`evidence`** holds references, not full records, so a result stays small and
the bundle holds the detail. Each ref carries `evidence_id`, `kind`,
`observed_at`, `digest`, `coverage`, `sources`, and `limitations`.

**`unknowns`** holds the questions that could not be answered. This array being
non-empty is not a failure. It is the report being honest about its own limits,
and a report that is never empty here is a report that is not looking.

## Verification status

A verification bundle closes with one of four statuses:

| Status     | Meaning                                                                          |
| ---------- | -------------------------------------------------------------------------------- |
| `verified` | Every assertion in the goal was evaluated and passed, with `complete` coverage   |
| `partial`  | Some assertions passed; others were not evaluated, or coverage is not `complete` |
| `failed`   | At least one evaluated assertion did not hold                                    |
| `unknown`  | The goal could not be evaluated at all                                           |

`verified` is the only status that means what a reader wants it to mean, and it
requires every assertion to have actually run. A run whose process died before
the second assertion is `partial`, even if the first assertion passed and nothing
failed.

`unknown` and `failed` are different, and the difference is the point. `failed`
means uvp checked and the check did not hold. `unknown` means uvp could not
check. An agent that treats the two the same will either retry a broken service
forever or accept an unverified one.

## Worked example

```
uvp verify ./svc --port 8080 \
  --request GET /items/1 \
  --assert status=200 \
  --assert 'json:$.value=first'
```

The bundle that comes back, abbreviated:

```json
{
  "bundle_id": "vb_…",
  "goal": "GET /items/1 returns 200 with value=first",
  "status": "verified",
  "evidence_ids": ["ev_…", "ev_…", "ev_…"],
  "unknown_ids": [],
  "members": [
    {
      "kind": "exchange",
      "subject": { "method": "GET", "url": "http://127.0.0.1:8080/items/1" },
      "observed": { "status_code": 200, "body_bytes": 24, "elapsed_ms": 3 },
      "derived": {},
      "coverage": { "scope": "response body", "status": "complete", "examined": 24, "total": 24 },
      "sources": [{ "kind": "endpoint", "ref": "GET http://127.0.0.1:8080/items/1" }],
      "limitations": []
    },
    {
      "kind": "assertion",
      "subject": { "assertion": "status=200" },
      "observed": { "actual_status": 200 },
      "derived": { "passed": true },
      "coverage": { "scope": "assertions", "status": "complete", "examined": 2, "total": 2 },
      "sources": [{ "kind": "endpoint", "ref": "GET http://127.0.0.1:8080/items/1" }],
      "limitations": []
    }
  ]
}
```

Read it like this: `observed.status_code` is a fact — uvp read it off the wire.
`derived.passed` is arithmetic over that fact. `coverage.examined = 2` with
`total = 2` is why the status is `verified` rather than `partial`, and
`unknown_ids: []` says no question went unanswered.

Now the version where the second assertion did not run because the process exited
after the first:

```json
{
  "status": "partial",
  "unknown_ids": ["uk_…"],
  "members": [
    {
      "kind": "assertion",
      "coverage": {
        "scope": "assertions",
        "status": "partial",
        "examined": 1,
        "total": 2,
        "note": "process exited before the second assertion was evaluated"
      }
    }
  ],
  "unknowns": [
    {
      "unknown_id": "uk_…",
      "question": "does json:$.value equal \"first\"?",
      "reason": "the service exited before the assertion could be evaluated",
      "blocked_by": "process exit"
    }
  ]
}
```

The first assertion passed. The status is still `partial`, because `verified` is
a claim about the whole goal and half of it was not examined.

## What evidence is not

**Not a log.** Logs are chronological and undifferentiated. Evidence is scoped to
a subject and split by how it was established.

**Not a guarantee.** `verified` means the assertions you wrote held under the
conditions uvp ran them in. It says nothing about load, concurrency, or a
different machine.

**Not permanent.** Evidence describes a run that happened. A later run is
different evidence about the same goal, and comparing them by `digest` is how you
tell whether the subject changed or only the clock did.

**Not a substitute for reading `limitations`.** Every tool that can truncate,
sample, or time out says so there. A `verified` status with a `limitations` entry
that says "the body was capped at 1048576 bytes" is a report about a prefix, not
about a response.
