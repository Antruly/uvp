# Security Policy

## Supported versions

Security fixes are provided for the latest published version of uvp. Upgrade to
the latest release before reporting a problem that may already have been
resolved. uvp is pre-1.0; until the first release, fixes land on `main`.

## Reporting a vulnerability

Do not disclose vulnerabilities in a public issue.

Use **Report a vulnerability** in the repository's **Security** tab to submit the
report privately. Do not open a public issue to request a private contact
channel.

Include the affected uvp version, operating system, the compiler and CMake
versions, the libuvcpp version and how it was installed, the impact, and the
reproduction conditions, with any suggested mitigation. Remove credentials,
tokens, private paths, and any captured traffic containing data you are not free
to share.

The maintainer will acknowledge the report, assess its scope, and coordinate
remediation and disclosure timing with the reporter.

## Security boundary

uvp is a local development tool. It generates, builds, and runs C++ services on
the machine it is invoked on, with that user's permissions. **It is not a
sandbox.**

What uvp does and does not do:

- **It builds and runs code you asked it to build and run.** A generated service
  is an ordinary process under your user account. It can open files, open
  sockets, and make outbound requests according to what you generated.
- **It does not install or upgrade libuvcpp, a compiler, or CMake.** These are
  bring-your-own. `uvp doctor` reports what it found; it does not fetch anything.
- **It does not run as a privileged user, and never invokes `sudo`.**
- **It does not contact a network service of its own.** The only outbound
  requests are the ones a caller asks for through `uvp_http_request`,
  `uvp_soap_call`, `uvp_websocket_probe`, and `uvp_load_test`.
- **It does not execute a command supplied as a string.** Build and run steps go
  through an argument vector to a named executable, without shell evaluation.

### Generated projects

A generated project's `CMakeLists.txt` finds libuvcpp through
`find_package(uvcpp CONFIG)` or `pkg-config` and links the target it finds. If
either resolution path can be influenced by a package in a directory you do not
control, the project links what that package provides — the same exposure as any
CMake project. Keep `CMAKE_PREFIX_PATH` and `PKG_CONFIG_PATH` pointed at
directories you trust.

### Static file serving

`serve_static` resolves its document root against the **process working
directory**, not the executable's location. A generated `static-files` project
uses a fixed literal root inside the workspace for exactly this reason. Treat a
static root computed from request input or from an environment variable as a
directory-traversal bug.

### Captured traffic

`uvp_capture_start` records exchanges, including headers and bodies. Captures can
contain `Authorization` headers, cookies, tokens, and request payloads. uvp
redacts a configurable header set by default, but **redaction by name is not
redaction by content** — a secret in a body or a query string is recorded as
sent. Captures are written to disk in the session's working directory. Treat them
as sensitive, and know where they land before running a capture against a
service you do not own.

### Request targets

`uvp_http_request` and the other web tools connect wherever they are told. There
is no allowlist and no egress restriction, because a development tool that
refuses to talk to `localhost` is useless. The tool contracts declare `network:
true`, and an agent's approval prompt reports it. What you point them at is your
decision and your responsibility.

## Dependency and supply-chain posture

- Every npm dependency is pinned to an exact version (`save-exact=true`).
- `npm ci` installs from the committed lockfile.
- Lifecycle scripts are denied by default and allowed by an explicit list in
  `package.json#allowScripts`.
- CI runs with `permissions: contents: read` except where a job needs more, and
  each job declares its own permissions rather than inheriting write access.
- Workflows currently reference third-party actions by major version tag
  (`actions/checkout@v4`). Moving to full commit-SHA pins is tracked in the
  [roadmap](docs/roadmap.md#hardening); until then, a tag is used rather than a
  pin whose identity has not been verified.
