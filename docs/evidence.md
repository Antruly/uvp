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
`assertion`, `benchmark`, `comparison` — the things uvp produces evidence about.
Seven of them are named for what uvp went and looked at. `comparison` is the
exception, and it is the reason the list has a sentence rather than a count: a
comparison of two saved reports observed neither of them live, and every fact in
it came out of records something else wrote. Filing it under the kind of the
thing compared would claim an observation that was never made.

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
the reader gets the id, the digest, the coverage and the sources without the
record's body. Which of the record's fields that leaves out, and what it means
for a reader, is [its own section](#what-is-not-inlined).

**`unknowns`** holds the questions that could not be answered. This array being
non-empty is not a failure. It is the report being honest about its own limits,
and a report that is never empty here is a report that is not looking.

## What is not inlined

The evidence record above has nine fields. The reference a tool result carries
has seven, and the three of the record's it drops are **`subject`, `observed` and
`derived`** — what the entry is about, what was seen, and what was concluded from
it. What it has instead is `digest`, which is computed _from_ those three fields
and from `coverage` (`kind` too), so the fingerprint is over content the reader
cannot see.

That is not an abbreviation a reader can resolve. Every tool result and every
saved bundle carries `recorder.evidence.map(toEvidenceRef)`; the full records
exist inside the handler that built them and nowhere else. So when this page says
an entry is evidence for a conclusion, what a reader actually has is the digest,
the coverage, the sources, and whatever the tool restated at the top level of its
output. In the worked example below that is enough, because `exchanges[]`
restates the status, the protocol and the assertion counters. For a tool whose
conclusion is not restated there, the digest is what establishes that two runs
agree and the coverage is what establishes how much was examined — and neither
says what was seen.

This is a settled design rather than an open question, as of 2026-10-16. The
alternative — a second bundle shape carrying the whole records, which
`src/domain/evidence.ts` declared as `evidenceBundleSchema` and never shipped —
has been deleted, and the roadmap records why in
[the section on it](roadmap.md#evidence-bundle). Making the recorded detail
reachable from a bundle would change what every tool's output carries, and what it
would buy is low: a reader who needs to know what was seen calls the tool that saw
it, and the refs and `unknown_ids` are what say which call that is.

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

The bundle that comes back, abbreviated — the ids, timestamps and digests are
real, the source paths cut down, and two of its four entries shown:

```json
{
  "tool": "uvp_verify",
  "provider": { "id": "local", "platform": "linux-x64" },
  "goal": "GET /items/1 returns the first stored item",
  "workspace_id": "wsp_a6fa2a9ede2308343175fb",
  "bundle_id": "bun_527182bd8c1c4de0a06c79",
  "status": "verified",
  "build": { "succeeded": true, "exit_code": 0 },
  "service": {
    "run_id": "run_5192723ba4724c0c8737e1",
    "ready": true,
    "endpoint": "http://127.0.0.1:8401/"
  },
  "exchanges": [
    {
      "name": "GET /items/1",
      "exchange_id": "exc_e03796d8289146bb9c28f3",
      "status": 200,
      "http_version": "1.1",
      "elapsed_ms": 2,
      "assertions_passed": 2,
      "assertions_failed": 0,
      "failures": []
    }
  ],
  "evidence": [
    {
      "evidence_id": "ev_3cc1e12130af4e1bb5d9e9",
      "kind": "build",
      "observed_at": "2026-10-16T05:03:50.363Z",
      "digest": "60e21a7cb00ab2fe0ea3ca7480d5ed604771565baa8ad4f7bdccd814d23ade6a",
      "coverage": { "scope": "build", "status": "complete" },
      "sources": [{ "kind": "command", "ref": "cmake -S … -B … -DCMAKE_BUILD_TYPE=Debug" }],
      "limitations": []
    },
    {
      "evidence_id": "ev_4950c1cf03ca411d9521c5",
      "kind": "assertion",
      "observed_at": "2026-10-16T05:03:50.375Z",
      "digest": "28228a72a1822e5d18cb44a78cb4baa256fee3760ee10b637a9482469c758c05",
      "coverage": { "scope": "GET /items/1 assertions", "status": "complete" },
      "sources": [{ "kind": "endpoint", "ref": "http://127.0.0.1:8401/items/1" }],
      "limitations": []
    }
  ],
  "unknowns": [],
  "limitations": [
    "The service was stopped after the pass; the evidence describes a process that no longer exists."
  ],
  "unverified": []
}
```

Read it like this: `exchanges[0].status = 200` is a fact — uvp read it off the
wire, over the protocol `http_version` names. `assertions_passed = 2` is
arithmetic over that fact. `coverage.examined = 2` with `total = 2` is why the
status is `verified` rather than `partial`, and `unknowns: []` says no question
went unanswered.

An evidence entry is a **reference**: id, kind, when, a semantic `digest`, the
coverage it covers, and the sources behind it. The recorded `subject`,
`observed` and `derived` of that entry are not inlined here — see
[what is not inlined](#what-is-not-inlined) for why that is settled rather than
pending — so what a reader of a
result checks a conclusion against is the `digest`, the `coverage`, and the
tool's own top-level fields, which are what `exchanges[]` carries above.

Now the version where the second assertion could not be evaluated — the same
pass with a second assertion whose JSONPath the engine refuses — shown the same
way, with the two entries above left out:

```json
{
  "status": "partial",
  "exchanges": [
    {
      "name": "GET /items/1",
      "status": 200,
      "assertions_passed": 1,
      "assertions_failed": 0,
      "failures": []
    }
  ],
  "evidence": [
    {
      "evidence_id": "ev_8d63e28954ec415293b61d",
      "kind": "assertion",
      "digest": "f6c9a32c5e155605b83ce5b718db0db995d41deb24dfb7b8a48a702a44f5604a",
      "coverage": {
        "scope": "GET /items/1 assertions",
        "status": "partial",
        "examined": 1,
        "total": 2,
        "note": "1 of 2 assertion(s) could not be evaluated against this exchange; each one names its own reason"
      },
      "sources": [{ "kind": "endpoint", "ref": "http://127.0.0.1:8401/items/1" }],
      "limitations": []
    }
  ],
  "unknowns": [
    {
      "unknown_id": "unk_1a86b323dfd347c2802947",
      "question": "Does `body_json_path_equals` on `message` (\"Hello\") hold for GET /items/1 (GET /items/1)?",
      "reason": "not_attempted",
      "blocked_by": "unsupported JSONPath: path must start with $"
    }
  ],
  "unverified": [
    {
      "question": "Does `body_json_path_equals` on `message` (\"Hello\") hold for GET /items/1 (GET /items/1)?",
      "reason": "the assertion could not be evaluated: unsupported JSONPath: path must start with $"
    }
  ]
}
```

Quoted as it was captured, bracket and all: the question names its subject twice,
because `uvp verify` derives a request's name from its method and path and the
template then appended them again. It reads `... hold for GET /items/1` now.
What matters for this page is the shape rather than the wording — the check that
could not run is a question with a reason, in both the envelope and the bundle,
and no counter anywhere says it passed.

The first assertion was satisfied. The status is still `partial`, because
`verified` is a claim about the whole goal and half of it was not examined: the
exchange counters report the one check that ran, `coverage` says `examined: 1` of
`total: 2`, and the check that did not run is a `ResidualUnknown` — in the
envelope's `unknowns`, which a tool result's reader sees, and in `unverified`,
which a bundle's reader sees.

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
