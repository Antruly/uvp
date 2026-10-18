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

An assertion that could not be evaluated at all — a header the client never read,
a body the record does not hold — is the third state, and `uvp assert` exits `2`
on it rather than `0`. The exit codes are a two-way answer to a three-way
question, and the safe collapse is the one that does not turn "nobody could tell"
into "everything held": a script reading `0` concludes the service passed a check
it was never given.

**Failures print the error contract.** Code, message, and the offending field
where there is one. A schema violation is `invalid_request` naming the field, not
a usage dump.

**`--version` before the command.** `uvp --version` prints `uvp-agents <version>` on
stdout and exits `0`. It is answered before a command word and not after one,
because `uvp soap --version 1.2` is already the SOAP protocol version: a command
that declares the spelling keeps it, and `uvp doctor --version` is refused with a
message saying where the flag belongs rather than one claiming it does not exist.
Like `--help`, the text is the answer to the question asked, so `--json` does not
change it.

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

Each compiler is reported where it was found. On Windows, an MSVC that is
installed but not on `PATH` — the normal state outside a Developer Command
Prompt — is listed with `on_path: false` and the environment it needs, rather
than as a missing prerequisite; CMake's Visual Studio generator builds with it,
the Ninja generator needs a Developer Command Prompt.

Pass `--workspace PATH` and the report describes the toolchain the workspace
asks for, not only this host: a `uvp.json` that names a container is reported
with that image's toolchain in the list — or, when this host has no runtime or
the image is not present, with the prerequisite that is missing, which is the
answer to "can I build this here" before a build that was never going to start.
`libuvcpp` and `features` then come from what the workspace will build against,
and when the image cannot be examined at all the report says so rather than
answering from this host:

```json
{ "toolchain": { "kind": "container", "image": "localhost/uvp-base:12" } }
```

`--provider ID` restricts which toolchains are listed; it does not change what
the `libuvcpp` and `features` sections are about, and the report says so when the
two differ. A workspace whose declaration cannot be read is refused here too,
rather than reported as if it built on this host.

## `uvp init`

```bash
uvp init ./svc --name svc --template rest-api --port 8080 --features websocket,tls
```

Scaffolds a CMake project. Writes files; starts nothing; builds nothing.

| Template         | What it produces                                             |
| ---------------- | ------------------------------------------------------------ |
| `hello-http`     | One route, `GET /hello`, returning JSON. The smallest thing. |
| `rest-api`       | A collection with `GET`/`POST` and JSON in and out.          |
| `websocket-echo` | An upgrade endpoint that echoes frames back.                 |
| `websocket-test` | Health, a bounded echo log, a WS echo, and a static console. |
| `soap-service`   | A SOAP endpoint with a hand-written envelope.                |
| `static-files`   | Serves a directory over HTTP.                                |

`uvp init` prints one `route` line per route the template registers, so the
first request to try is in its output — `route GET /hello` for `hello-http`. The
same list is the `routes` field of `uvp_workspace_create`. A path that is not in
it is a 404 from a service that is working exactly as generated, not a failure
to diagnose.

`rest-api`, `websocket-echo`, and `websocket-test` need `UVCPP_BUILD_WEBAPP=ON` in
the libuvcpp you built against. `uvp init` does not check that — `uvp doctor`
does, and the generated code has a compile-time guard that turns a missing module
into one readable error instead of a cascade of unknown-identifier failures
inside libuvcpp's own headers.

Pass `--features` to add the guards and the CMake surface for optional modules.
The switches that would enable them are emitted as comments in the generated
`CMakeLists.txt`, because a feature cannot be retrofitted into an installed
library.

### Application modules

`--modules` composes uvp's own application code into the template. These are not
libuvcpp build switches: a feature says what the library was built with, a module
says what uvp writes into `src/main.cpp`.

| Module           | What it adds                                                                       |
| ---------------- | ---------------------------------------------------------------------------------- |
| `health`         | `GET /healthz` answering `{"status":"ok"}`                                         |
| `echo-log`       | a bounded in-memory log of arriving messages, with `GET /api/echo-log`             |
| `evidence-log`   | a bounded log of HTTP requests and of messages on `WS /ws`, with `GET /api/events` |
| `websocket-echo` | `WS /ws`, echoing text and binary frames and reporting ping/close                  |
| `static-console` | `public/index.html`, a page that drives the echo route and the log                 |

```bash
uvp init ./svc --name svc --template websocket-test --modules health,echo-log
```

`websocket-test` composes `health`, `echo-log`, `websocket-echo` and
`static-console` by default; every other template composes none unless you ask,
and the routes it already serves stay. `evidence-log` is opt-in everywhere,
including `websocket-test`, so the module layer does not change what a template
generated before it existed. Its endpoint reports the event schema, the
retention window, the counters, and the payload policy along with the events:
text payloads are kept as a length and an FNV-1a hash, and binary payloads as a
short hex prefix, because the log is meant to correlate traffic rather than to
retain message bodies. Message events are the ones the `websocket-echo` module's
`WS /ws` route receives; a WebSocket route a template already serves is not
instrumented. `--event-payloads verbatim` keeps the text itself
instead; the policy is compiled into the service and recorded in `uvp.json`, and
asking for it without `evidence-log` is refused rather than quietly ignored. Some combinations are
refused before a file is written: an unknown or repeated name, `websocket-echo`
without `--features websocket`, `static-console` without the two modules its page
drives, and a module whose exact route the template already registers (`health`
on `rest-api`, for example). `http3-service` composes no modules at all — it is
written against `uvcpp_http_server`, and the modules are written against
`uvcpp_web_app`.

The selection is recorded in `uvp.json` as `modules` when it differs from the
template's default; a workspace generated without `--modules` keeps the manifest
it had before the field existed. The list is a set, not an order: the generated
files are the same however the names were typed.

Two features change the generated code rather than only the build. `http2` turns
on cleartext HTTP/2 on the same port. `tls` makes the service serve **HTTPS and
refuse to start rather than fall back to cleartext** — the one failure nobody can
see from the outside, since a caller who asked for HTTPS and got HTTP has traffic
that looks protected from their side and is not. Such a service takes its
certificate from the environment:

```bash
UVP_TLS_CERT=/etc/ssl/private/svc.crt UVP_TLS_KEY=/etc/ssl/private/svc.key ./build/svc
```

With neither variable set it generates a self-signed certificate for `localhost`
and prints a line saying so: a development certificate that every verifying
client, uvp's own included, will refuse. With only one of the two set it stops and
names the missing one, because the missing half could belong to either
arrangement and only one of them is what the operator meant. A pair that does not
go together — a key from somewhere else — is caught where libuvcpp reads it and
stops the service with the reason, naming the file, rather than surfacing at the
first handshake where the operator would see nothing. The generated `uvp.json`
records `tls` in `features` and nothing else: the transport is a consequence of
that list, so `uvp run` and the readiness probe read the scheme out of it instead
of a field that could state it differently.

### Static frontends

`--frontend` writes one built-in static skin and `--frontends` writes several.
A skin is three plain files under `public/<skin>/` — `index.html`, `app.css`,
`app.js` — with no build step, no framework, and no runtime network access: no
CDN, no external font, no analytics. `uvp build` never runs Node, and the
generated `CMakeLists.txt` is the same with or without a skin. The service
serves the directory with `app.serve_static("/", "./public")`, registered after
the template's exact routes.

| Skin           | What it is                                                               |
| -------------- | ------------------------------------------------------------------------ |
| `h5-minimal`   | a light, single-column page with a heading, a status line, a local clock |
| `h5-dashboard` | a dark card grid with locally rendered status tiles and a count-up timer |
| `h5-tech`      | a dark, monospace terminal-style page with a local render log            |

```bash
uvp init ./svc --name svc --template rest-api --frontends h5-minimal,h5-tech
```

Each skin is reachable at `/<skin>/`, and `/` serves a page that lists the
selected skins. `websocket-test`'s console already owns `/` and links the skins
instead of being replaced; `static-files`' placeholder page is replaced by the
selector, which lists the skins the same way. `http3-service` refuses a skin
before writing anything: its generated source registers no static document root,
so the files would never be served.

`--frontend none` means the same workspace as omitting both flags: no page, no
`public/` directory, and no `frontends` field in `uvp.json`. The selection is
recorded in `uvp.json` in canonical order (the order of the table above), so two
requests naming the same skins in another order generate the same files. The
result reports `frontends` beside `routes`; a workspace that serves skins
registers the document root once — `GET /`, `HEAD /`, `GET /*path`, `HEAD
/*path` — whether that registration comes from the template, the
`static-console` module, or the skin selection.

Refused before a file is written: an unknown or repeated skin, `--frontend`
together with `--frontends`, and `none` listed beside a skin in `--frontends`.

### Frontend apps

The same flags also select one Node frontend app — `vue3`, `react`, or
`svelte` — which writes a separate Vite project under `frontend/` instead of a
page set under `public/`:

```bash
uvp init ./svc --name svc --template rest-api --frontend vue3
```

The generated project is pinned, not ranged: `package.json` names exact
versions, and a `package-lock.json` generated from those versions is written
beside it, so `npm ci` installs the same tree without contacting a registry for
resolution. It contains `vite.config.js`, `index.html`, `src/main.*`,
`src/App.*`, `src/style.css`, a `.gitignore`, and a README. The page loads
nothing remote — no CDN, no external font, no network call — and needs one of
the Node lines uvp itself accepts (`^22.19.0`, `^24.11.0`, or `>=26.0.0`), but
only inside `frontend/`.

`uvp build` still never runs Node, and the generated `CMakeLists.txt` is
unchanged. At startup the service checks for `frontend/dist/index.html` and,
only when it exists, registers the built output with
`app.serve_static("/", "./frontend/dist", options)` and SPA fallback. Until
then `GET /` answers `503` with the instruction to run `npm ci && npm run
build` in `frontend/` and restart; the template's exact routes answer
normally either way, because the static root is registered after them.

```bash
uvp frontend build ./svc   # npm ci + npm run build in frontend/, writes frontend/dist/
```

The same thing by hand is `cd frontend && npm ci && npm run build`.

A workspace selects at most one frontend app, and an app and a static skin
cannot be combined: both own the document root. Those refusals, and the
`http3-service` refusal, happen before a file is written. So do the refusals on
`static-files`, `websocket-test`, and the `static-console` module, whose pages
already answer `/`. The selection is recorded in `uvp.json` as the app id and
reported beside `routes`; `--frontend none` means no frontend at all.

### Template packages

```bash
uvp init ./dashboard --name dashboard --template-package acme-dashboard@1.0.0
```

Renders a package imported with `uvp template import` instead of a built-in
template. The id and an exact version name the stored package; an `ID@VERSION`
that is missing either half, a version that is not SemVer, or a package that is
not in the store is refused with exit 2. A stored tree that no longer matches
its manifest is exit 1 (`artifact_modified`), and no partial workspace is
written.

One selector only: `--template` and `--template-package` are refused together,
and `--features`, `--modules`, `--event-payloads`, and `--frontend`/`--frontends`
are refused with a package, because they compose the built-in generators rather
than the package's source. The package's declared routes are printed as `route`
lines; when it declared none, uvp says so as a limitation rather than reporting
an empty list as an inspected fact. `uvp.json` records `template_package` with
the id, version, and digest. See [template packages](template-packages.md).

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

### Where the build happens

A workspace can pin the toolchain it is built with, in its `uvp.json`:

```json
{ "toolchain": { "kind": "container", "image": "localhost/uvp-base:12" } }
```

`uvp build` then runs inside that image, which **starts a container on this
host**. The image has to be present already — uvp never pulls one — and the
workspace is mounted at its own absolute path, so the paths in the diagnostics
and the artifact list are the paths you can open. `--toolchain` never names an
image; it only chooses a side:

```bash
uvp build ./svc --toolchain container   # insist on one the workspace named
uvp build ./svc --toolchain local       # refuse the one it named
```

`--toolchain container` fails with `missing_requirement` when `uvp.json` names
no image, and a `toolchain` field that cannot be read is `invalid_request`
rather than a build on this host. `uvp verify` refuses a container-declared
workspace with `unsupported_toolchain` before compiling anything — a pass runs
what it builds, and a binary built in an image carries an in-image `RUNPATH` —
so checking one on this host means `uvp verify ./svc --toolchain local`.

## `uvp frontend build`

```bash
uvp frontend build ./svc
uvp frontend build ./svc --timeout 1200000 --json
```

The explicit build for a workspace generated with a Node frontend app. It runs
`npm ci --no-audit --no-fund` and then `npm run build` in `frontend/`, and
reports each step's exit code, duration, and the last 4096 characters of its
output. It never runs as part of `uvp build`, and nothing else in uvp needs
Node.

The tool call succeeds even when the build does not: `steps_succeeded` is
`false`, the CLI exits `1`, and the failing step's output tail says why. `2` is
reserved for a question that could not be put — a path that is not a workspace,
a workspace whose `uvp.json` records no app, a `frontend/` project missing its
`package.json` or its committed `package-lock.json`, or a host where Node or
npm is absent, broken, or did not answer the version probe.

`built` is a claim about the filesystem, not about this run: it is true when
`frontend/dist/index.html` exists after the build, which can be a leftover from
an earlier build when this run failed. `steps_succeeded` is the claim about
this run, and the two together are what the verdict reads.

Node and npm are checked before anything is installed: a `node --version` or
`npm --version` that cannot be started, exits non-zero, or prints no version is
a `missing_requirement` naming the executable, not a failed build. The
generated project accepts the same Node lines as uvp itself.

Effects: reads and writes the filesystem (inside `frontend/`: its
`node_modules/` and `dist/`; npm may also write its own cache outside the
workspace), spawns processes, and may contact the registry
named in the lockfile. It runs on this host even when `uvp.json` names a
container for the C++ build; the result says so when it does.

A framework build that exits `0` without producing `frontend/dist/index.html`
is reported as such: `steps_succeeded` is true and `built` is false, which
means the project's output directory was changed from the generated default.

## `uvp run` and `uvp stop`

```bash
uvp run ./svc --port 8080
uvp stop --all
```

`uvp run` starts the binary, waits until the port answers, and prints a handle
and the startup output. It does not return until the service is listening or the
startup timeout expires — a service that is about to fail does not get reported
as running.

An interrupt during that wait is a cancellation rather than a timeout. The call
stops the service it had already started and fails with `cancelled` instead of
waiting out the timeout and reporting `ready: false` — a bound the caller had
stopped waiting for is not a finding about the service. A call that arrives
already cancelled starts nothing at all. This path exits 1, the code every
`cancelled` failure earns; the 130 and 143 below belong to the foreground hold,
where the process is staying alive on purpose.

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

The `\` continuation is POSIX shell syntax. On `cmd.exe` (and in PowerShell,
where single quotes are fine too) use one line; double quotes keep the JSONPath
intact in every shell:

```bat
uvp verify ./svc --port 8080 --request GET /items/1 --assert status=200 --assert "json:$.value=first"
```

Ask for a route the template actually registers — `uvp init` printed them as
`route` lines. `GET /` against `hello-http` is answered 404 and that is the
correct answer, because `/` is not a route; `GET /hello` is.

On Git Bash (Git for Windows) and MSYS2, the shell rewrites an argument that
begins with `/` into a Windows path before `uvp` runs: `--request GET /healthz`
arrives as `C:/Program Files/Git/healthz`, the pass asks for a path the service
does not answer, and every assertion fails even though the service is ready. The
request is built from the argument uvp received, so the report is accurate about
what was sent. Turn the conversion off for the command: `export
MSYS_NO_PATHCONV=1` in Git Bash, or `export MSYS2_ARG_CONV_EXCL='*'` in MSYS2.

If the service was started earlier with `uvp run`, it may still be listening: a
detached run (the default) leaves the process running after the CLI exits, and a
later `uvp stop --all` is a new process whose registry is empty, so it cannot
stop it. A verify on that port then talks to the older listener — the report's
limitation says listeners on the loopback interface were assumed to be this
workspace's service. Stop the pid `uvp run` printed, or verify on a fresh port;
`--no-detach`, described under `uvp run` below, keeps the service in the
foreground so an interrupt stops it.

`--http-version` applies to the `--request` before it, defaulting to `auto`, so
one pass can put the same question to the same service over two protocols:

```bash
uvp verify ./svc --port 8080 \
  --request GET /hello --http-version 2 --assert http_version=2.0 \
  --request GET /hello --assert http_version=1.1
```

That is what establishes "this port serves both" rather than assuming it: an
h2c-capable service shares one port between HTTP/1.1 and HTTP/2, tells them apart
by the connection preface RFC 9113 defines, and needs no second listener. A
pinned `--http-version 2` against a service that answers HTTP/1.1 anyway is
reported as `unsupported_target` — non-retryable, with the remediation naming
`uvp init --features http2` — rather than as an unreachable endpoint, because the
service answered and the caller is being sent to inspect the one thing that
works.

`--http-version 3` is a different case, because it is not this process that
answers it. A pass never silently downgrades: the exchange records no status and
no `http_version`, and the reason lands in `unverified`. Two things decide which
reason. A pass builds its URL from the workspace's own scheme, so against a
workspace generated without `--features tls` the request is `http://` and `3` is
refused with `invalid_request` naming the `https://` requirement — QUIC has no
cleartext mode. Against a TLS workspace the request reaches libuvcpp's QUIC client
in a separate probe process, which needs a probe binary on this host. To actually
ask a service over HTTP/3, use `uvp http --http-version 3 --no-tls` against a
workspace generated from the `http3-service` template.

`--tls` does the same for a certificate, and its default is the other way round:
a pass reports what the certificate was on every exchange (`tls_verification`,
and `tls_reason` when OpenSSL recorded one) without making it part of the verdict
unless you ask. See [Certificates](#certificates) below, and the README of any
workspace generated with `--features tls` for the certificate the service serves
and the environment it takes it from.

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
| `http_version=2.0`                     | The protocol the response arrived in |

The short forms cover the common cases; `--assert '{"kind": …}'` takes a JSON
object and reaches the whole evaluator vocabulary, which is also how the kinds
that need a set rather than a single value are written — `{"kind":"status_in",
"expected":[200,201]}`, where `status=2xx` would have to do.

`~=` matches a regular expression, so a plain substring is a valid pattern. It is
only accepted against a header and the raw body: no assertion in the vocabulary
matches a regular expression against a JSON path, so `json:$.value~=^a` is
refused rather than quietly widened to a whole-body check. Use `json:$.value=<v>`
to compare the parsed value.

`http_version` is the one assertion that says whether a _transport_ was
exercised rather than whether the service answered, so it is spelled for what
happened and not for what was asked for. It compares the version the response
arrived in — `"1.1"`, `"2.0"`, as the wire spells it — while `--http-version`
names the version to _attempt_ (`auto`, `1.1`, `2`, `3`). The two spellings differ
deliberately: `--assert http_version=2.0` against a pass that ran `--http-version
2` is a check on the wire, and one that ran `auto` against an HTTP/1.1-only
service fails it, which is exactly the case a single spelling would hide. Both
values are reported per exchange in the bundle, as `http_version` — what came
back — beside the request that was made.

A request that never completed records no `http_version` at all. That is not
`"1.1"`: nothing negotiated anything, and filling in a default would report a
protocol the exchange never used. The assertion fails and says so.

Negation is the one thing the two assertion surfaces do not share. A leading `!`
negates any form, including a JSON object, and `uvp assert` accepts it. `uvp
verify` refuses it: `uvp_verify` evaluates every assertion affirmatively and
reports the value it observed, so a negated check would be a check the bundle
described as one thing and ran as another. Both the CLI and the tool contract
refuse it — the contract declares `negate` in order to reject it, because
dropping the field silently is the failure mode being avoided.

A header the client never looked at is a third answer, and it is not `is absent`.
Some clients read a response's headers one name at a time — libuvcpp's C ABI is
one — so an exchange can be recorded with a narrower set of header names than the
response carried. An assertion on a name outside that set says **`was not looked
at`** and names the headers that were, because "the service does not send
`x-request-id`" is a finding about the service and "uvp did not ask" is a finding
about uvp. A record whose header set was read in full has no such gap, and an
absent list means the whole response, which is what everything that reads a
record without the field assumes.

A JSON path that does not exist is a failure with the path and `is absent` in the
message — not an error, and not a `= undefined` that reads as a value the body
held. The difference matters: "the field is absent" is an answer, and it is the
answer an agent needs to distinguish a missing field from a malformed body, which
says `not valid JSON` instead. Each failure names both what was there and what
was asked for, because in a bundle `failures` is a list of strings and nothing
else in the output repeats the expectation. (`uvp assert exchange` carries the
same pair as structured `observed` and `expected` fields.)

## `uvp bundle diff`

```bash
uvp verify ./svc --port 8080 --json > before.json
# … change something …
uvp verify ./svc --port 8080 --json > after.json
uvp bundle diff --before before.json --after after.json
```

Two reports from earlier passes, compared. The unit is a report `uvp_verify`
wrote, addressed by the file it is in, because a bundle is the one artifact
carrying a semantic digest — and a comparison built on anything else would answer
a different question from the one the digest answers.

The report separates three things a reader would otherwise conflate:

| Field               | What it says                                                                           |
| ------------------- | -------------------------------------------------------------------------------------- |
| `outcome`           | `identical`, `changed`, or `incomparable`                                              |
| `exchanges.entries` | Per request: `added`, `absent`, `changed`, or (with `--include-unchanged`) `unchanged` |
| `changed_fields`    | Which fields of that request moved                                                     |
| `verdict_changed`   | Whether any of them is a field `bundle_digest` reads                                   |
| `same_digest`       | Whether the two passes' own digests agree                                              |
| `digest_consistent` | Whether each supplied digest matches its own contents                                  |
| `not_compared`      | The fields that were reported and deliberately not judged                              |

`changed_fields` beside `verdict_changed: false` is the case worth knowing:
`bundle_digest` covers the verdict and not the sentence explaining it, so two
passes can share a digest while the failure text moved. That pairing is reported
rather than smoothed over, and `limitations` says it in words. `http_version` is
a field of the same kind, and for a related reason: the same assertions put to
the same service over HTTP/1.1 and over HTTP/2 reach the same verdict, so they
hash the same, and the comparison reports that the two passes were different
experiments. Both sides' versions are carried in `before` and `after`, so
`changed_fields: ["http_version"]` can be read without going back to the two
command lines that produced the files.

Identifiers and the clock are never compared — `bundle_id`, `exchange_id`,
`elapsed_ms`, `service.run_id`, `service.endpoint`. Each is minted per pass or
belongs to the run rather than to the subject, so a repeat pass over an unchanged
service reads as `identical` however the two files were produced. Order _is_
compared, because the sequence of exchanges and questions is part of what the
digest covers; a reordering is reported as `order_changed` rather than left to be
discovered by noticing two different digests.

Both files are read whole, and a file above the size limit is refused rather than
truncated. A path that is not JSON, JSON that is not a report, a directory, a
missing file, and a report whose `bundle_digest` does not match its own contents
are all `invalid_request` naming what was found. "JSON that is not a report" and
"not JSON at all" are distinguished, because the repairs differ.

Exit `0` is `identical`, exit `1` is `changed`, and exit `2` is `incomparable` or
a refusal: two reports that cannot be read as one subject — a different
workspace, a digest that does not describe what arrived with it — have not had
their question answered. A different workspace is two subjects rather than two
moments, and equality between two self-inconsistent digests would be a
coincidence rather than a finding.

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
uvp capture replay --target http://127.0.0.1:8080
uvp assert --exchange ex_… --assert status=200
```

`uvp load` reports percentiles. Those are `derived`; the individual timings they
came from are `observed` and come back with them, in the order they were taken,
under `samples` — a p99 nobody can trace back to a sample is a number, not a
measurement. `--max-samples` (default 10000) bounds how many are kept and
`samples_dropped` says how many were timed and not kept; every number in the
distribution is computed from exactly the samples returned, so a run that dropped
some is a `partial` scope rather than a quiet approximation.

### Certificates

`uvp http`, `uvp ws`, `uvp load`, and `uvp capture replay` all check the peer's
certificate; `--no-tls` turns that check off for the call. `uvp verify` is the
exception in both directions and says so in its own `--help`: it does **not**
check the certificate unless you pass `--tls`. A verification pass is about the
service's behaviour, and the workspaces uvp generates for `--features tls` serve a
development certificate — a default that failed against the workspace uvp had just
generated would make the tool's own output unusable. What the certificate was is
reported either way: each exchange in the bundle carries `tls_verification` and
`tls_reason`, so the default is visible rather than silent, and `--tls` is what
makes a rejected chain land in `unverified` instead of in a note.

`uvp http` is the one that reports what it saw, under `tls`: the negotiated
protocol, the cipher, the
subject and issuer, the validity window, and `verification`, which is four states
rather than a boolean. `verified` means the check ran and the chain validated.
`not_checked` means the caller turned the check off — the chain was still
validated and `reason` still says what OpenSSL found, which is what turning the
check off is for. `undetermined` means the check was required and its answer could
not be read, kept distinct from the fourth state, `failed`, for the same reason a
probe that cannot run is kept distinct from an absent feature. `failed` is
modelled and not produced today: an unaccepted chain ends the exchange, so it
arrives as the failure below rather than as a result carrying a field. `reason`
is OpenSSL's own spelling — `DEPTH_ZERO_SELF_SIGNED_CERT`, `CERT_HAS_EXPIRED`,
`ERR_TLS_CERT_ALTNAME_INVALID` — because the messages for those three are prose
that names none of them, and they want three different things done about them.

**HTTP/3 is the one transport whose certificate is never examined**, and its
`not_checked` means something narrower than the state above. The QUIC client in
libuvcpp's C ABI verifies against a CA bundle it is handed or not at all — there
is no system-trust-store path in that layer — and `uvp_http_request` has no input
for a bundle. So the call is refused before anything is spawned when `verify_tls`
is on, and when it is off the result says `not_checked` with a `reason` saying no
certificate was examined. It does not say `verified`, and it is not the "the chain
was still validated" case: nothing was validated. `--http-version 3` therefore
requires `--no-tls`, and `uvp http`'s `--help` says so rather than leaving the
refusal to be discovered.

A certificate this client will not accept exits `2` with `target_unavailable`,
and not `endpoint_unreachable`: the service is listening, the handshake
completed, and the certificate is what failed, so the remedy is not to go and
check the host and port. It is not `retryable` either — a target does not become
acceptable by being asked again. The remedy names both directions, because uvp
cannot tell a private CA the caller meant to trust from a development certificate
nobody means to: hand this client the CA (`NODE_EXTRA_CA_CERTS`), or say
`--no-tls`.

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

`uvp capture replay` is the other direction: it reads the record back and asks
the same requests again of a `--target` of your choosing, so a capture taken
against one build can be replayed against the next. It is the one web command
that does not probe the subject — it probes the record, and the target answers
for it.

Only `GET`, `HEAD`, and `OPTIONS` are ever sent. A capture that recorded a `POST`
holds the bytes that were sent, and re-sending them would turn a regression suite
into a second, quieter write; those exchanges come back `skipped` with the method
named in `skipped_methods`. The same reasoning is why the contract declares no
target mutation: the absence of the request is the guarantee, not a hope about
what the request would have done.

A request the capture cut short is skipped for a second reason, and shares the
list: if the session's recording limit stored only a prefix of a request body,
sending it would be a request the captured client never made, presented as the
same one. The per-exchange `reason` says which of the two applies and, for a
prefix, the byte limit that cut it.

Each exchange is `matched`, `differs`, `skipped`, or `not_comparable`, and the
run's `outcome` is `verified` only when every exchange it replayed was compared
and matched. `partial` covers a run that compared fewer facts than the record
holds — a skipped method, an exchange whose recorded body was cut by the
recording limit — and `unknown` covers a run that compared nothing at all, which
includes a target that never answered. Exit `1` is a difference; exit `2` is a
run whose question could not be put, and `unknown` is `2` rather than `0` because
"nothing was compared" is not a pass.

Bodies are compared by digest and never returned. A side reports a digest only
when that side's bytes are whole, because a digest of a truncated prefix printed
beside a digest of a whole body invites exactly the wrong comparison; `compared`
says which fields the exchange was judged on, and `reason` says why it was judged
on fewer of them.

`uvp ws` with no `--send` performs the handshake and stops. A `101` is a success
and is reported as one, separately from the frame log, so "the upgrade was
rejected" and "it opened and then said nothing" are different results.

Every frame carries `at_ms`, stamped when that frame crossed the socket rather
than at the end of the probe — otherwise a greeting that arrived at 1 ms and a
reply that arrived at 900 ms would both read as the probe's total duration.
`--expect-frame` is matched by uvp, once, whatever `--stack` ran the probe, and
against received frames only; it returns one `expectations` entry per value,
naming the frame that answered it (`matched_frame_index`). The CLI reads that
verdict rather than re-matching the frame log, and exits 1 when an expectation
went unmet. A frame uvp sent is never the answer: on an echo server the sent and
expected strings are identical, which is exactly the case that would otherwise
pass against a server that never replied. A closing handshake the peer started is
reported as `close.code` and `close.reason` with `closed_cleanly`; a peer that
hung up with no close frame reports `closed_cleanly: false` and no `close`, which
is an observation and not an error.

`--stack libuvcpp` runs the same probe through libuvcpp's own WebSocket client
instead of Node's, as a separate process (`uvcpp-probe`). It exists because two
clients that both claim RFC 6455 can disagree about everything the RFC leaves
open, so "a Node client reached the service" and "the stack this service was
generated for reached it" are different findings. What that stack cannot do is
refused before anything is spawned, and exits 2: `wss://` URLs (the C ABI's
client has no TLS), `--header`, `--subprotocol`, and a `send[].wait_ms` that is
not zero. What it cannot _see_ is reported instead: no `handshake` object at all,
and the blind spots are listed in `not_observable` — the upgrade response's
status line and headers, ping and pong frames, and others. A run whose client
loop never returned is marked `abandoned`, which on this stack is the ordinary
ending for a connection the peer leaves idle: the frame log ends where its
evidence ends, and what came after is unknown rather than absent.

The probe binary is not vendored. `npm run build:native-probe` builds it against
an installed libuvcpp with `UVCPP_ENABLE_CAPI=ON`, `UVP_NATIVE_PROBE` points at a
build somewhere else, and a host with neither exits 2 with `toolchain_unavailable`
— a fact about the host, not about the service, and one that says which of the
three it was: `unavailable` when there is no binary, `unavailable` with the
probe's own sentence when the binary answered but does not carry the exchange that
was asked for — `--http-version 3` against a probe built without an HTTP/3-capable
libuvcpp, where the remedy is the install and not a rebuild — and `undetermined`
when there is a binary that did not answer its version check at all.

## `uvp template`

```bash
uvp template search [--text TEXT] [--category C] [--framework F] [--tags a,b] \
  [--tag-mode all|any] [--features websocket,ssl] [--version 1.2.0] [--all-versions] \
  [--limit 20] [--offset 0]
uvp template get acme-dashboard@1.2.0
uvp template validate ./acme-dashboard [--allow-unverified]
uvp template import ./acme-dashboard [--replace] [--allow-unverified] [--dry-run]
uvp template export acme-dashboard@1.2.0 --target ./exported
uvp template remove acme-dashboard[@1.2.0]
```

The six commands read and write the local template store. The store root is
`$UVP_TEMPLATE_HOME` when set, otherwise `~/.uvp/templates`; it is not a flag,
so a person and an agent reached through MCP use the same store.

`search` answers with the matching packages and what matched each one. An empty
query lists the store. It reads metadata only — no file bytes and no network.
A store entry that cannot be read is reported under `corrupt`, never omitted:
a corrupt entry is not an absent one.

`get` names one exact `id@version`, re-verifies every file against the
manifest, and returns the store path. A missing package and a tampered package
are different failures — `template_not_found` and `artifact_modified` — because
the remedies differ.

`validate` runs the import's format check without writing. It does not consult
the store, so a package already installed still validates here and is refused
later by `import`. A malformed package is `invalid_request` with every problem
in `details.problems`; a directory that cannot be read is `execution_failure`.

`import` validates, scans, and copies. The scan is a bounded locator for
credential- and PII-shaped content: a finding is reported but does not refuse
the package, and "no findings" is not "clean". An existing `id@version` is
refused unless `--replace` is explicit. `--dry-run` writes nothing and reports
`would_import`, `would_replace`, and, when the real call would be refused,
`conflict`; that check is a snapshot taken without the store lock.

`export` copies a stored package into a directory that must be absent or empty,
re-verifying the exported bytes before reporting success. `remove` takes
`id@version` for one version or a bare `id` for every version; `id@` is a usage
error, so a typo cannot widen a removal into a whole-id one.

A missing package, a malformed source, a duplicate import without `--replace`,
an export target that is not empty, or a bad flag exits 2 — the question could
not be put, and the caller can put it again by changing the input. A store that
is unreadable, or whose tree no longer matches its manifest, exits 1 — the
question was asked and the answer is no, so the same input needs a change first.
A locked store also exits 1, but retrying is the remedy: another uvp process
holds the lock, the failure is `resource_constraint` with `retryable: true`, and
the same call succeeds once that process finishes.

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
