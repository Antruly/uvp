# CLI and evidence

Every uvp tool has a CLI equivalent, generated from the same contract. The
command names are the tool names with the `uvp_` prefix dropped and underscores
turned into spaces.

## Global behaviour

**`--json` on every command.** Structured output, on stdout, for a machine.
Without it, a command prints for a person. The two are not the same rendering of
the same object: the human form drops fields that matter to a parser and the JSON
form is stable.

**Exit codes.** `0` success. `1` the operation ran and the answer is no — a
failed assertion, an unmet requirement. `2` the input or the environment was
wrong — a bad flag, no libuvcpp, no such workspace. The distinction matters to a
script: `1` means "the service is not doing what you asked", `2` means "uvp could
not ask it".

**Failures print the error contract.** Code, message, and the offending field
where there is one. A schema violation is `invalid_request` naming the field, not
a usage dump.

**No command.** Bare `uvp` prints the command list on stdout and exits `2`: a
person who typed `uvp` wants the list, and the code says the question was not
finished being asked. `--help` asks for the same text and exits `0`. Under
`--json` there is no such case — there is no result to print, so stdout stays
empty and the failure contract goes to stderr, because a caller piping into a
parser must never be handed prose. A word that matches no command is a refusal
naming it (`uvp buidl` reports `No command named "buidl".`), and a word that
matches the start of a two-word command names the whole thing
(`uvp capture statr`).

## `uvp doctor`

```bash
uvp doctor
uvp doctor --json
uvp doctor --features tls,websocket --provider local
```

Reports the compiler, CMake, and libuvcpp build uvp found: the route that
answered, the prefix, the version and where the version was read from, the
modules the build actually defines, and which requested features it therefore
provides.

Run it first. When something later fails, its output is what makes the failure
readable.

```
compiler     g++ 13.3.0        /usr/bin/g++
cmake        3.29.6            /usr/bin/cmake
libuvcpp     1.7.0             cmake_package   /home/dev/.local
modules      UVCPP_WEB_ENABLE=1  UVCPP_WEBAPP_ENABLE=1  UVCPP_OPENSSL_ENABLE=1
             UVCPP_NGHTTP2_ENABLE=0  UVCPP_ENABLE_DB=0 …
features     satisfied    websocket, soap
             unmet        tls         rebuild with UVCPP_ENABLE_OPENSSL=ON
```

A feature uvp could not check is listed under `undetermined` with the reason, not
folded into either side. See
[libuvcpp feature mapping](libuvcpp-features.md#undetermined-is-a-real-answer).

## `uvp init`

```bash
uvp init ./svc --name svc --template rest-api --port 8080 --features websocket,tls
```

Scaffolds a CMake project. Writes files; starts nothing; builds nothing.

| Template         | What it produces                                        |
| ---------------- | ------------------------------------------------------- |
| `hello-http`     | One route returning JSON. The smallest thing that runs. |
| `rest-api`       | A collection with `GET`/`POST` and JSON in and out.     |
| `websocket-echo` | An upgrade endpoint that echoes frames back.            |
| `soap-service`   | A SOAP endpoint with a hand-written envelope.           |
| `static-files`   | Serves a directory over HTTP.                           |

`rest-api` and `websocket-echo` need `UVCPP_BUILD_WEBAPP=ON` in the libuvcpp you
built against. `uvp init` does not check that — `uvp doctor` does, and the
generated code has a compile-time guard that turns a missing module into one
readable error instead of a cascade of unknown-identifier failures inside
libuvcpp's own headers.

Pass `--features` to add the guards and the CMake surface for optional modules.
The switches that would enable them are emitted as comments in the generated
`CMakeLists.txt`, because a feature cannot be retrofitted into an installed
library.

`uvp init` refuses to write into a non-empty directory without `--force`.

## `uvp build`

```bash
uvp build ./svc
uvp build ./svc --json
```

Configures and compiles through CMake, using the toolkit and libuvcpp that
`uvp doctor` found.

A compile failure is **not** an error. It exits `1` and returns diagnostics,
tagged by phase:

```json
{
  "exit_code": 1,
  "phase": "compile",
  "diagnostics": [
    {
      "file": "src/main.cpp",
      "line": 42,
      "severity": "error",
      "message": "no member named 'serve_static' in 'uvcpp::web_app'"
    }
  ]
}
```

This is what makes the fix-and-retry loop work: an agent reads the diagnostics,
edits, and builds again. `phase` is `configure`, `compile`, or `link`, and the
distinction is worth having — a configure failure is a missing libuvcpp, a link
failure is a missing module.

## `uvp run` and `uvp stop`

```bash
uvp run ./svc --port 8080
uvp stop --all
```

`uvp run` starts the binary, waits until the port answers, and prints a handle
and the startup output. It does not return until the service is listening or the
startup timeout expires — a service that is about to fail does not get reported
as running.

`detach: true` — the default — leaves the service running and returns. With
`--no-detach` the call stays in the foreground for as long as the service runs,
holding it under supervision, so an interrupt stops it rather than abandoning it.

Supervision is scoped to the session: uvp can stop anything it started, by handle
or with `uvp stop --all`, for as long as the process that started it is running.
It can signal only processes uvp started; it is not a general process killer.

Scoped to the session means scoped to the _process_. The run registry is held in
memory by the uvp process that started the service, and `uvp run` detaches by
default, so the CLI invocation that launched a service has already exited by the
time you would type the next command — and a later `uvp stop --all` starts a new
process with an empty registry. It will report that nothing was running while the
service from the previous invocation is still listening. That report is true
about the registry and misleading about the machine, and it is the reason the
flag reads `--all` rather than "everything".

Three ways to end up with a service you can actually stop:

- Run the service under the MCP server and stop it there. The server is one
  process for the whole session, so its registry outlives the individual calls.
- Pass `--no-detach`, which keeps `uvp run` in the foreground for as long as the
  service runs. An interrupt then stops the service before the call returns:
  Ctrl-C gives a free port and exit 130, SIGTERM exit 143, and either way the
  line on stderr says which run was stopped and what became of it. The service is
  started in its own process group, so the terminal's signal reaches the CLI and
  not the service — the CLI stopping it is what ties the two lifetimes together.
- Stop the pid `uvp run` printed, with whatever your shell provides.

A detached run is not lost — it is unowned. The distinction matters because
`uvp stop --all` cannot tell you which of the two you have.

## `uvp verify`

```bash
uvp verify ./svc --port 8080 \
  --request GET /items/1 \
  --assert status=200 \
  --assert 'json:$.value=first'
```

The whole closure in one supervised pass: configure, compile, launch, drive, assert,
stop, report. Returns a bundle whose status is one of four:

| Status     | Requires                                                              |
| ---------- | --------------------------------------------------------------------- |
| `verified` | Every assertion evaluated, all passed, coverage `complete`            |
| `partial`  | Some passed; others were not evaluated, or coverage is not `complete` |
| `failed`   | At least one evaluated assertion did not hold                         |
| `unknown`  | The goal could not be evaluated at all                                |

A run whose process died before the second assertion is `partial`, even if the
first passed and nothing failed. `verified` is a claim about the whole goal, and
half of it was not examined.

### Assertions

| Form                                   | Checks                               |
| -------------------------------------- | ------------------------------------ |
| `status=200`                           | Response status                      |
| `status=2xx`                           | Status class                         |
| `json:$.value=first`                   | A JSON path, compared after parsing  |
| `json:$.value`                         | That the JSON path is present        |
| `header:content-type=application/json` | A response header                    |
| `header:content-type`                  | That the response header is present  |
| `header:content-type~=<regex>`         | A response header, as a regex        |
| `body=substring`                       | A substring of the raw body          |
| `body~=<regex>`                        | A regular expression in the raw body |
| `body_bytes<1024`                      | The size of the raw body             |
| `latency<250ms`                        | Elapsed time for the exchange        |

The short forms cover the common cases; `--assert '{"kind": …}'` takes a JSON
object and reaches the whole evaluator vocabulary, which is also how the kinds
that need a set rather than a single value are written — `{"kind":"status_in",
"expected":[200,201]}`, where `status=2xx` would have to do.

`~=` matches a regular expression, so a plain substring is a valid pattern. It is
only accepted against a header and the raw body: no assertion in the vocabulary
matches a regular expression against a JSON path, so `json:$.value~=^a` is
refused rather than quietly widened to a whole-body check. Use `json:$.value=<v>`
to compare the parsed value.

Negation is the one thing the two assertion surfaces do not share. A leading `!`
negates any form, including a JSON object, and `uvp assert` accepts it. `uvp
verify` refuses it: `uvp_verify` evaluates every assertion affirmatively and
reports the value it observed, so a negated check would be a check the bundle
described as one thing and ran as another. Both the CLI and the tool contract
refuse it — the contract declares `negate` in order to reject it, because
dropping the field silently is the failure mode being avoided.

A JSON path that does not exist is a failure with the path and `is absent` in the
message — not an error, and not a `= undefined` that reads as a value the body
held. The difference matters: "the field is absent" is an answer, and it is the
answer an agent needs to distinguish a missing field from a malformed body, which
says `not valid JSON` instead. Each failure names both what was there and what
was asked for, because in a bundle `failures` is a list of strings and nothing
else in the output repeats the expectation. (`uvp assert exchange` carries the
same pair as structured `observed` and `expected` fields.)

## Web commands

Each of these maps to one `web` tool.

```bash
uvp http GET http://127.0.0.1:8080/items/1
uvp http POST http://127.0.0.1:8080/items --header 'content-type: application/json' --data '{"value":"x"}'
uvp ws ws://127.0.0.1:8080/echo --send hello --expect-frame hello
uvp soap http://127.0.0.1:8080/ws --action Ping --body '<Ping/>'
uvp load http://127.0.0.1:8080/items --requests 200 --concurrency 20
uvp capture start http://127.0.0.1:8080
uvp capture read --limit 20
uvp assert --exchange ex_… --assert status=200
```

`uvp load` reports percentiles. Those are `derived`; the individual timings they
came from are `observed` and come back with them, in the order they were taken,
under `samples` — a p99 nobody can trace back to a sample is a number, not a
measurement. `--max-samples` (default 10000) bounds how many are kept and
`samples_dropped` says how many were timed and not kept; every number in the
distribution is computed from exactly the samples returned, so a run that dropped
some is a `partial` scope rather than a quiet approximation.

`uvp capture read` truncates bodies above the recording limit and says so: the
limit is returned as `body_limit_bytes`, each exchange carries
`request_body_truncated` and `response_body_truncated`, and a read that cut a body
is a `partial` scope with the limit named in `limitations`. The limit is
`max_body_bytes` on `uvp capture start` and it governs recording only — a captured
request is still forwarded whole, and one too large to forward whole is refused
with `413` and recorded as refused rather than sent upstream short.

A capture session also holds a bounded window. `max_body_bytes` bounds one
exchange and says nothing about how many accumulate, so `--max-retained-bytes`
(default 32 MiB) bounds the recorded bodies the whole session keeps, and a count
ceiling bounds a session whose traffic is all tiny. Past either, the oldest
exchanges are dropped — a capture is read to find out what just happened — and
`uvp capture read` reports `withheld_by_retention`, with `retained_bytes` and
`retained_limit_bytes` beside it so the bound can be checked rather than assumed.
`total_recorded` is every exchange the session saw, so the page, the read limit,
and the retention caps add up to it. A `since_id` the session no longer holds
sets `since_id_unknown` and starts the page at the oldest exchange it does keep,
rather than answering a dropped cursor with an implicit "from the beginning".

`uvp ws` with no `--send` performs the handshake and stops. A `101` is a success
and is reported as one, separately from the frame log, so "the upgrade was
rejected" and "it opened and then said nothing" are different results.

Every frame carries `at_ms`, stamped when that frame crossed the socket rather
than at the end of the probe — otherwise a greeting that arrived at 1 ms and a
reply that arrived at 900 ms would both read as the probe's total duration.
`--expect-frame` is an input to the probe, which matches it against received
frames only and returns one `expectations` entry per value, naming the frame that
answered it (`matched_frame_index`). The CLI reads that verdict rather than
re-matching the frame log, and exits 1 when an expectation went unmet. A frame
uvp sent is never the answer: on an echo server the sent and expected strings are
identical, which is exactly the case that would otherwise pass against a server
that never replied. A closing handshake the peer started is reported as
`close.code` and `close.reason` with `closed_cleanly`; a peer that hung up with no
close frame reports `closed_cleanly: false` and no `close`, which is an
observation and not an error.

## `uvp mcp` and `uvp setup`

```bash
uvp mcp          # run the MCP server over stdio
uvp setup        # print client configuration
uvp setup --write
```

`uvp mcp` speaks MCP on standard input and output. It prints nothing else on
stdout — a stray log line corrupts the stream.

## Reading the output

Every result carries the same envelope:

```json
{
  "tool": "uvp_verify",
  "provider": { "id": "local", "version": "0.1.0", "platform": "linux-x64" },
  "evidence": [ { "evidence_id": "ev_…", "kind": "exchange", "coverage": { … } } ],
  "unknowns": [],
  "limitations": []
}
```

Two fields are worth checking on every result, in this order:

**`unknowns`** — a non-empty array is not a failure. It is the report saying which
questions it could not answer, and it is the field most likely to change your
mind about a result you were about to accept.

**`limitations`** — truncation, sampling, timeouts. A `verified` status with
"the body was capped at 1048576 bytes" in `limitations` is a report about a prefix,
not about a response.

`provider` is on every result so a finding is attributable. A build that
succeeded on a local GCC and a build that succeeded in a container are different
findings, and comparing them across machines without the provider produces a
conclusion the data does not support.

## Next

- [Evidence model](evidence.md) — what `observed`, `derived`, and `unknown` mean
- [MCP contracts](mcp-contracts.md) — the same tools over MCP
