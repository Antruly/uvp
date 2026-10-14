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

Supervision is scoped to the session: everything uvp started is stopped when the
session ends. `uvp stop` stops it earlier, by handle or with `--all`. It can
signal only processes uvp started; it is not a general process killer.

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
| `header:content-type=application/json` | A response header                    |
| `body~=<regex>`                        | A regular expression in the raw body |
| `latency<250ms`                        | Elapsed time for the exchange        |

`~=` matches a regular expression, so a plain substring is a valid pattern. It is
only accepted against a header and the raw body: no assertion in the vocabulary
matches a regular expression against a JSON path, so `json:$.value~=^a` is
refused rather than quietly widened to a whole-body check. Use `json:$.value=<v>`
to compare the parsed value. A leading `!` negates any form, including a JSON
object.

A JSON path that does not exist is a failure with `actual: null` and the path in
the message — not an error. The difference matters: "the field is absent" is an
answer, and it is the answer an agent needs to distinguish a missing field from a
malformed body.

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
came from are `observed` and are kept, because a p99 nobody can trace back to a
sample is a number, not a measurement.

`uvp capture read` truncates bodies above a size limit and says so in `coverage`
and `limitations`. The limit is reported, not applied silently.

`uvp ws` with no `--send` performs the handshake and stops. A `101` is a success
and is reported as one.

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
"the body was truncated at 64 KiB" in `limitations` is a report about a prefix,
not about a response.

`provider` is on every result so a finding is attributable. A build that
succeeded on a local GCC and a build that succeeded in a container are different
findings, and comparing them across machines without the provider produces a
conclusion the data does not support.

## Next

- [Evidence model](evidence.md) — what `observed`, `derived`, and `unknown` mean
- [MCP contracts](mcp-contracts.md) — the same tools over MCP
