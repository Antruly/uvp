import { FEATURE_REQUIREMENTS } from "./ToolchainProvider.js";
import type { UvpFeature } from "../domain/features.js";

/**
 * Workspace templates.
 *
 * A generated workspace is a plain CMake project, not a uvp artifact. It must
 * build with `cmake -S . -B build && cmake --build build` and nothing else
 * installed but libuvcpp. That constraint is what lets a user keep the code
 * after they stop using uvp, and it is the reason nothing here depends on a uvp
 * runtime library being present.
 *
 * Everything below is written against libuvcpp 1.7.0's real headers —
 * `uvcpp_web_app` and friends, whose naming is snake_case and whose methods are
 * chainable. Two details are easy to get wrong and worth stating: the umbrella
 * `<uvcpp.h>` header installs at the include root and covers only handles and
 * requests, so a web service includes `<webapp/...>` directly; and the exported
 * CMake target is namespaced (`uvcpp::uvcpp`), because libuvcpp installs its
 * export set with `NAMESPACE uvcpp::`.
 */

export const TEMPLATE_IDS = [
  "hello-http",
  "rest-api",
  "websocket-echo",
  "soap-service",
  "static-files",
  "http3-service",
] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

/**
 * The features a template can honour, for the templates where that is a question.
 *
 * The web templates leave it open, and that is not laxity: they are written
 * against `uvcpp_web_app`, which serves whichever modules the build has, so a
 * feature they do not name in the source is still a real build requirement
 * recorded in `uvp.json` and still checkable against the install.
 *
 * `http3-service` is different for a reason that is not taste. It is written
 * against `uvcpp_http_server`, because `uvcpp_web_app` cannot serve HTTP/3 at
 * all: the web-app layer installs a stream-claim hook for its middleware chain,
 * and the h3 leg refuses that hook — a request that reaches one is answered 500
 * with a line on stderr rather than routed. So this template's feature list is
 * fixed by which headers it includes, and a request for a feature it does not
 * write code for would be a manifest claiming a module the source never touches.
 *
 * `tls` and `http3` are *required* rather than allowed, because h3 runs on QUIC
 * and QUIC has no cleartext mode: an h3 service without a certificate is not a
 * lesser service, it is not an h3 service.
 */
export const TEMPLATE_FEATURE_RULES: Partial<
  Record<
    TemplateId,
    { readonly required: readonly UvpFeature[]; readonly allowed: readonly UvpFeature[] }
  >
> = {
  "http3-service": {
    required: ["tls", "http3"],
    allowed: ["tls", "http3", "http2"],
  },
};

/**
 * Why this template cannot be asked for these features, or `undefined`.
 *
 * The message is the whole of what the caller needs to act on, and it names the
 * command that would work — a rule stated as "unsupported feature" leaves the
 * caller to work out which combination is supported by trying them.
 */
export const templateFeatureProblem = (
  template: TemplateId,
  features: readonly UvpFeature[],
): string | undefined => {
  const rule = TEMPLATE_FEATURE_RULES[template];
  if (rule === undefined) return undefined;

  const missing = rule.required.filter((feature) => !features.includes(feature));
  if (missing.length > 0) {
    return (
      `the ${template} template serves HTTP/3 over QUIC, which has no cleartext mode, so it ` +
      `needs the ${missing.join(" and ")} feature${missing.length === 1 ? "" : "s"}: ` +
      `pass --features ${[...features, ...missing].join(",")}`
    );
  }

  const refused = features.filter((feature) => !rule.allowed.includes(feature));
  if (refused.length > 0) {
    return (
      `the ${template} template writes code for ${rule.allowed.join(", ")} and nothing else, ` +
      `so ${refused.join(", ")} would be recorded in uvp.json without any code behind it: ` +
      `pass --features ${rule.allowed.join(",")}`
    );
  }

  return undefined;
};

export interface TemplateInput {
  readonly name: string;
  readonly port: number;
  readonly features: readonly UvpFeature[];
}

export interface GeneratedFile {
  readonly path: string;
  readonly content: string;
}

/** The libuvcpp version a generated workspace declares and requires. */
export const LIBUVCPP_BASELINE = "1.7.0";

/**
 * A compile-time guard.
 *
 * libuvcpp always defines its `UVCPP_*_ENABLE` macros, to 0 or 1. Checking one
 * turns "the headers are missing" or "the module is stubbed out" into a single
 * readable error naming the CMake option to rebuild with, instead of a cascade
 * of unknown-identifier errors inside libuvcpp's own headers.
 */
const featureGuard = (input: TemplateInput): string => {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const feature of input.features) {
    for (const symbol of FEATURE_REQUIREMENTS[feature].configSymbols) {
      if (seen.has(symbol)) continue;
      seen.add(symbol);
      lines.push(
        `#if !${symbol}`,
        `#  error "This service needs libuvcpp built with ${feature} support (${symbol} is 0)."`,
        `#endif`,
      );
    }
  }
  return lines.length === 0 ? "" : `\n${lines.join("\n")}\n`;
};

const cmakeLists = (input: TemplateInput): string => {
  // The switches that would have to be passed to a libuvcpp *source* build. They
  // are emitted as instructions rather than as `option()` calls because a
  // feature cannot be retrofitted into an installed library: this is the one
  // piece of configuration the generated project cannot do for itself.
  const switches = new Set<string>();
  for (const feature of input.features) {
    for (const option of FEATURE_REQUIREMENTS[feature].cmakeOptions) switches.add(option);
  }
  const featureBlock =
    switches.size === 0
      ? `# No optional libuvcpp modules were requested.`
      : `# Modules requested at generation time. libuvcpp has to have been built with
# these on; if you are building it from source, configure it with:
#
#   cmake -S libuvcpp -B build-libuvcpp \\
${[...switches]
  .sort()
  .map((option) => `#     -D${option}=ON \\`)
  .join("\n")}
#     -DCMAKE_INSTALL_PREFIX=/path/to/prefix
#
set(UVP_REQUESTED_FEATURES ${input.features.join(";")})`;

  return `cmake_minimum_required(VERSION 3.20)
project(${input.name} LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 14)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

${featureBlock}

# libuvcpp is found two ways, because it ships two ways and neither covers the
# other:
#
#   - \`cmake --install\` writes a package config (lib/cmake/uvcpp), so
#     \`find_package(uvcpp)\` works and yields the namespaced target
#     \`uvcpp::uvcpp\`.
#   - The prebuilt release archives ship pkg-config and *no* CMake config file,
#     so for those the only way in is \`uvcpp.pc\`.
#
# The version floor is enforced on both routes. It is deliberately a floor and
# not a pin: libuvcpp follows semver and the generated code uses API that has
# been stable across the 1.x line.
#
# Point UVCPP_ROOT or CMAKE_PREFIX_PATH at an unpacked release if it is not
# installed in a standard prefix.
find_package(uvcpp ${LIBUVCPP_BASELINE} CONFIG QUIET)

if(uvcpp_FOUND)
  set(UVP_UVCPP_TARGET uvcpp::uvcpp)
  set(UVP_UVCPP_ROUTE "CMake package (\${uvcpp_DIR})")
else()
  find_package(PkgConfig REQUIRED)
  pkg_check_modules(UVCPP REQUIRED IMPORTED_TARGET "uvcpp>=${LIBUVCPP_BASELINE}")
  set(UVP_UVCPP_TARGET PkgConfig::UVCPP)
  set(UVP_UVCPP_ROUTE "pkg-config (\${UVCPP_VERSION})")
endif()

message(STATUS "uvp: libuvcpp via \${UVP_UVCPP_ROUTE}")

add_executable(${input.name}
  src/main.cpp
)

# The manifest names the executable, and uvp resolves it as build/<name>.
# Multi-configuration generators (Visual Studio, Xcode) would otherwise append a
# per-configuration directory and put it in build/Debug/<name>, so the project
# would build and then not be startable by the tool that generated it. The base
# property covers single-configuration generators; the per-configuration
# properties override its configuration subdirectory on multi-config ones.
set_target_properties(${input.name} PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "\${CMAKE_BINARY_DIR}")
foreach(uvp_config \${CMAKE_CONFIGURATION_TYPES})
  string(TOUPPER "\${uvp_config}" uvp_config_upper)
  set_target_properties(${input.name} PROPERTIES
    "RUNTIME_OUTPUT_DIRECTORY_\${uvp_config_upper}" "\${CMAKE_BINARY_DIR}")
endforeach()

target_link_libraries(${input.name} PRIVATE \${UVP_UVCPP_TARGET})

if (MSVC)
  target_compile_options(${input.name} PRIVATE /W4 /permissive-)
else()
  target_compile_options(${input.name} PRIVATE -Wall -Wextra -Wpedantic)
endif()
`;
};

/**
 * The shared preamble.
 *
 * `uvcpp_web_app` declares the handler types in terms of `uvcpp_web_request` and
 * `uvcpp_web_response`, so those headers are included explicitly rather than
 * relied on transitively.
 *
 * Every libuvcpp type lives in `namespace uvcpp`, and the library's own
 * documented examples open with `using namespace uvcpp;`. This file is a
 * translation unit, never a header, so the directive is contained; spelling
 * `uvcpp::` at every use site would add noise to code that is meant to be read
 * as the shape of the service.
 */
const webPreamble = (input: TemplateInput, extra: readonly string[] = []): string => {
  // `std::getenv`, for the TLS and database setups below. Included only when one
  // of them is emitted, so a workspace with neither carries no include it cannot
  // explain. One condition rather than one include per feature, because two
  // features that both read the environment read it the same way and a repeated
  // `#include` is a line a reader has to stop and account for.
  const readsEnvironment = input.features.includes("tls") || input.features.includes("db");
  const featureIncludes = readsEnvironment ? ["#include <cstdlib>"] : [];
  return `#include <webapp/uvcpp_web_app.h>
#include <webapp/uvcpp_web_request.h>
#include <webapp/uvcpp_web_response.h>
${[...featureIncludes, ...extra].map((line) => `${line}\n`).join("")}
#include <iostream>
#include <string>
${featureGuard(input)}
using namespace uvcpp;
`;
};

/**
 * The start/join tail every HTTP template shares.
 *
 * `start()` runs the server on a background thread and returns once bind has
 * resolved, so the port is known — and `bound_port()` reports the port actually
 * taken, which matters when the requested port was 0. Printing before `join()`
 * keeps the readiness line useful to a supervisor that is watching stdout.
 */
const webTail = (input: TemplateInput): string => `
  const int rc = app.start();
  if (rc != 0) {
    std::cerr << "failed to start on port ${String(input.port)}: libuv error " << rc << "\\n";
    return 1;
  }

  std::cout << "listening on " << app.bound_port() << "\\n" << std::flush;
  app.join();
  return 0;
}
`;

/**
 * Which certificate the environment names, and the refusal when it names half of
 * one.
 *
 * Emitted once and used by both certificate setups — the `uvcpp_web_app` one and
 * the `uvcpp_http_server` one — because it is one interpretation of two
 * environment variables, and two copies of it would be two chances to disagree
 * about what an empty value means. The setups differ in what they do with the
 * pair; they do not differ in how they read it.
 */
const certificateFromEnvironment = (): string => `
  const char* cert_file = std::getenv("UVP_TLS_CERT");
  const char* key_file = std::getenv("UVP_TLS_KEY");
  // An empty value counts as "not naming a certificate": \`UVP_TLS_CERT=$CERT\`
  // with CERT unset in the caller's shell is a mistake, and reading it as "no
  // certificate" would quietly do something else instead of reporting it.
  const char* cert = (cert_file != nullptr && cert_file[0] != '\\0') ? cert_file : nullptr;
  const char* key = (key_file != nullptr && key_file[0] != '\\0') ? key_file : nullptr;
  if ((cert == nullptr) != (key == nullptr)) {
    // Half a pair is not a configuration to guess at. The missing half could be
    // the other half of a real certificate or of the self-signed fallback, and
    // only one of those is what the operator meant, so neither is assumed.
    std::cerr << "UVP_TLS_CERT and UVP_TLS_KEY are given together or not at all; "
              << (cert == nullptr ? "UVP_TLS_CERT" : "UVP_TLS_KEY")
              << " is missing or empty. Refusing to start rather than serve something else.\\n";
    return 1;
  }
`;

/**
 * HTTPS, when the workspace declared the `tls` module.
 *
 * A workspace that asked for TLS must not come up serving cleartext. That is the
 * failure this block is built around, and it is the one nobody can see from the
 * outside: a caller who asked for HTTPS and got HTTP has traffic that looks
 * protected from their side and is not. So the two ways to be misconfigured — a
 * half-supplied certificate pair, and a certificate libuvcpp cannot read — both
 * end in `return 1` before `start()`, with the reason naming the file.
 *
 * Where the certificate comes from is the environment's business, because a
 * generated project cannot know where a deployment keeps one, and hardcoding a
 * path into generated source is how a template ends up wrong in every
 * environment but the one it was written in. `enable_self_signed` is the
 * fallback rather than the rule: libuvcpp documents it as for tests and
 * controlled intranets, and it is what makes a freshly generated workspace
 * runnable — a certificate no client should accept without being told to, which
 * uvp's own client refuses rather than trusts.
 *
 * `set_tls_handshake_timeout_ms` is set explicitly, at the framework's own
 * default. It is emitted because the hole it fills is invisible: the framework
 * hands a connection to the application only once the handshake is done, and the
 * idle scan walks the connections it was handed — so a peer that opens a socket
 * and dribbles bytes without ever finishing the handshake is not covered by
 * `idle_timeout_ms` at all. A reader of this file should not have to open
 * libuvcpp's header to learn that the bound exists.
 */
const tlsSetup = (input: TemplateInput): string => {
  if (!input.features.includes("tls")) return "";
  return `
  // HTTPS, because this workspace declared the tls module.
  //
  //   UVP_TLS_CERT=/path/cert.pem UVP_TLS_KEY=/path/key.pem ./${input.name}
  //
  // With neither variable set, a self-signed certificate is generated for
  // localhost. Clients that check certificates will refuse it, which is the
  // point: it is a development certificate, not a deployment one.
${certificateFromEnvironment()}
  if (cert != nullptr) {
    app.enable_ssl(cert, key);
    // enable_ssl reads and checks the pair where it is called, so a path that
    // does not exist or a key that does not match is reported here, naming the
    // file, rather than at the first handshake — where a client sees only a
    // refused connection and the operator sees nothing. It also marks the
    // service TLS-unavailable, so start() would return UV_EINVAL rather than
    // serve cleartext; this check is the one that can say why.
    if (!app.ssl_error().empty()) {
      std::cerr << "TLS is unusable, so this service will not start: " << app.ssl_error() << "\\n";
      return 1;
    }
    std::cout << "serving HTTPS with the certificate in " << cert << "\\n" << std::flush;
  } else {
    app.enable_self_signed("localhost");
    std::cout << "serving HTTPS with a generated self-signed certificate for localhost; "
                 "clients that verify will refuse it. Set UVP_TLS_CERT and UVP_TLS_KEY to "
                 "serve a real one.\\n" << std::flush;
  }
  app.set_tls_handshake_timeout_ms(10000);
`;
};

/**
 * The two lines every web template starts from: the port, and — when the
 * workspace asked for the `http2` module — cleartext HTTP/2.
 *
 * Shared rather than repeated in five templates because the point of the second
 * half is that it is a *consequence* of the declared feature list, and five
 * copies of a consequence is five places for the declaration and the code to
 * drift apart. The declaration is what `uvp doctor --workspace` is asked about,
 * so a workspace that says `http2` and compiles code that never mentions it is a
 * claim with nothing behind it.
 *
 * Only h2c is switched on. HTTP/2 over TLS is already advertised by default in
 * `uvcpp_web_app` and needs no line here; h2c is off by default because
 * recognising an HTTP/2 connection preface on an unencrypted socket is a change
 * in protocol behaviour rather than a negotiation that falls back when it fails.
 *
 * TLS is the same kind of consequence, and it is also what makes WebSocket
 * services in a `tls` workspace speak `wss://` — the TLS filter is in the
 * transport, and WS runs on top of it.
 */
const webAppSetup = (input: TemplateInput): string => {
  const h2c = input.features.includes("http2")
    ? `
  // Cleartext HTTP/2 on this same port, because this workspace declared the
  // http2 module. h1 and h2c share the port and are told apart by the 24-byte
  // connection preface RFC 9113 defines — byte for byte, not by sniffing, and
  // without needing a second port or an Upgrade handshake. Over TLS, h2 is
  // advertised through ALPN already; this is the unencrypted leg.
  app.set_h2c_enabled(true);`
    : "";

  return `  uvcpp_web_app app;
  app.set_port(${String(input.port)});${h2c}${tlsSetup(input)}
`;
};

const helloHttpMain = (input: TemplateInput): string =>
  `${webPreamble(input)}
// A single route, wired by hand. Everything uvp generates ends up looking like
// this: ordinary libuvcpp code that a C++ developer would recognise.
//
// The handler takes a third parameter, next. Leaving it uncalled and ending the
// response is the normal case; calling it would pass the request on to the next
// matching handler.
int main() {
${webAppSetup(input)}
  app.get("/hello", [](uvcpp_web_request&, uvcpp_web_response& resp, uvcpp_web_next) {
    resp.status(200).json_str(R"({"message":"Hello, AI"})");
    resp.end();
  });
${webTail(input)}`;

/**
 * `rest-api`'s store, chosen by whether the workspace declared the `db` module.
 *
 * This is the one template whose feature list changes *what the service keeps*
 * rather than how it talks, and it is the reason `db` is the only feature that
 * reaches a web template's route bodies. The alternative — a seventh template
 * that is this one with a database under it — would be two copies of one route
 * table, and the copy nobody edits is the one that drifts.
 *
 * The routes, the status codes and the JSON are the same either way. What the
 * feature buys is durability, which is a fact about where the bytes live and not
 * about what the service says, so a caller that swaps the store keeps their
 * client.
 *
 * On the other web templates `db` remains a build requirement and a guard and
 * nothing more: they have no store for it to back. That is stated in
 * [docs/libuvcpp-features.md](../../docs/libuvcpp-features.md) rather than left
 * for a reader to discover by diffing generated projects.
 */
const restApiMain = (input: TemplateInput): string =>
  input.features.includes("db") ? restApiDatabaseMain(input) : restApiMemoryMain(input);

/**
 * The in-memory store, which is what `rest-api` generates without `db`.
 *
 * A map in the process, so the workspace is runnable with nothing installed but
 * libuvcpp — and, just as much, so that the difference the `db` feature makes is
 * visible: the same requests against the same routes answer from a file instead.
 */
const restApiMemoryMain = (input: TemplateInput): string =>
  `${webPreamble(input, ["#include <unordered_map>"])}
namespace {

// An in-memory store, so the template is runnable with no database. Replace it
// with the db module when the service needs durability — \`uvp init --features db\`
// generates that version of this file.
std::unordered_map<std::string, std::string> g_items = {{"1", "first"}, {"2", "second"}};

std::string JsonItem(const std::string& id, const std::string& value) {
  return std::string(R"({"id":")") + id + R"(","value":")" + value + R"("})";
}

}  // namespace

int main() {
${webAppSetup(input)}
  app.get("/healthz", [](uvcpp_web_request&, uvcpp_web_response& resp, uvcpp_web_next) {
    resp.status(200).json_str(R"({"status":"ok"})");
    resp.end();
  });

  app.get("/items", [](uvcpp_web_request&, uvcpp_web_response& resp, uvcpp_web_next) {
    std::string body = "[";
    bool first = true;
    for (const auto& entry : g_items) {
      if (!first) body += ",";
      first = false;
      body += JsonItem(entry.first, entry.second);
    }
    body += "]";
    resp.status(200).json_str(body);
    resp.end();
  });

  // ":id" is a single-segment parameter. param() returns a pointer, and a
  // missing parameter is nullptr rather than an empty string — the two are
  // different requests.
  app.get("/items/:id", [](uvcpp_web_request& req, uvcpp_web_response& resp, uvcpp_web_next) {
    const std::string* id = req.param("id");
    if (id == nullptr) {
      resp.status(400).json_str(R"({"error":"missing id"})");
      resp.end();
      return;
    }
    const auto found = g_items.find(*id);
    if (found == g_items.end()) {
      resp.status(404).json_str(R"({"error":"not found"})");
      resp.end();
      return;
    }
    resp.status(200).json_str(JsonItem(found->first, found->second));
    resp.end();
  });
${webTail(input)}`;

/**
 * The db module's headers, as the database-backed template includes them.
 *
 * Four of them, named individually: `<db/uvcpp_db.h>` is the single client and
 * this template uses the pool instead, because a handler that borrows the one
 * client serialises every request behind it. `uvcpp_db_params.h` is included for
 * the bound parameters, and the status and table headers for the two types the
 * callbacks are declared in terms of.
 */
const DATABASE_INCLUDES = [
  "#include <db/uvcpp_db_params.h>",
  "#include <db/uvcpp_db_pool.h>",
  "#include <db/uvcpp_db_status.h>",
  "#include <db/uvcpp_db_table.h>",
] as const;

/**
 * The database-backed service: the same routes as the in-memory template, over
 * `uvcpp_db_pool`.
 *
 * Three things here are about the shape of a request-routed query rather than
 * about SQL, and each is written down where it is used because each fails
 * silently: the handler must not run the query itself (it is on the loop
 * thread), the callback must resume the chain and not only end the response, and
 * the dispatch itself can fail without any callback ever arriving.
 *
 * The connection string is read once, at startup, and the schema is created
 * there too. A service that discovered a missing table on its first request
 * would be reporting a deployment problem as a 500, and the driver's own reason
 * — which is the part worth reading — would be in a log line nobody is looking
 * at yet.
 */
const restApiDatabaseMain = (input: TemplateInput): string =>
  `${webPreamble(input, DATABASE_INCLUDES)}
namespace {

// The schema, created at startup and idempotently, so a deployed service needs
// nothing but a connection string. \`VARCHAR(255)\` for the key rather than TEXT
// because MySQL cannot index a TEXT column without a prefix length; the other
// two dialects take it as written. A deployment with real migrations to run
// should drop this statement rather than keep it as the source of truth.
const char* const kSchema =
    "CREATE TABLE IF NOT EXISTS items (id VARCHAR(255) PRIMARY KEY, value TEXT NOT NULL)";

// A failure body. The status name is the driver's own code and not a guess at
// what went wrong: the enum carries one code for every failed execute, so "the
// key was already taken" and "the connection dropped" arrive here with the same
// name, and the template reports which one it got rather than inventing a
// distinction the layer underneath does not make.
std::string DbError(const char* what, uvcpp_db_status status) {
  return std::string(R"({"error":")") + what + R"(","status":")" +
         uvcpp_db_status_name(status) + R"("})";
}

// The read statements. No trailing semicolon: libuvcpp passes a statement to the
// driver as written, and the three dialects do not agree on whether to accept one.
const char* const kSelectAll = "SELECT id, value FROM items ORDER BY id";
const char* const kSelectOne = "SELECT id, value FROM items WHERE id = ?";

}  // namespace

int main() {
${webAppSetup(input)}
  // Where the database is, from the environment. A generated service cannot know
  // where a deployment keeps its database, and a path hardcoded in generated
  // source is how a template ends up wrong in every environment but the one it
  // was written in.
  //
  //   UVP_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/app ./${input.name}
  //
  // Unset, it opens a SQLite file in the working directory. That default is what
  // makes a freshly generated workspace runnable with nothing installed but
  // libuvcpp — SQLite is a library, not a server — and it is a development
  // default, printed below. The MySQL and PostgreSQL drivers are loaded at run
  // time, so pointing this at one of them needs no rebuild, only the client
  // library on the host.
  const char* url_env = std::getenv("UVP_DATABASE_URL");
  const std::string url = (url_env != nullptr && url_env[0] != '\\0')
                              ? std::string(url_env)
                              : std::string("sqlite://./${input.name}.db");

  // The pool, not the single client: a handler runs on the event loop thread and
  // may not wait on a connection another request is holding. \`init\` opens the
  // first connection here and now, so a connection string that cannot be opened
  // is reported at startup with the driver's own reason instead of as a 500 on
  // the first request that needs it.
  uvcpp_db_pool pool;
  const uvcpp_db_status opened = pool.init(url, 1, 4);
  if (!uvcpp_db_ok(opened)) {
    std::cerr << "cannot open " << url << ": " << uvcpp_db_status_name(opened) << ": "
              << pool.last_error() << "\\n";
    return 1;
  }

  // A bound on every statement the pool runs. Without one, a statement that never
  // returns holds its worker thread for as long as the process lives — and those
  // worker threads are libuv's own, shared with DNS and file IO. The pool is what
  // opens the connections, so it is the only place this can be set.
  pool.set_timeout_ms(5000);

  const uvcpp_db_status created = pool.execute(kSchema, uvcpp_db_params());
  if (!uvcpp_db_ok(created)) {
    std::cerr << "cannot create the items table in " << url << ": "
              << uvcpp_db_status_name(created) << ": " << pool.last_error() << "\\n";
    return 1;
  }

  std::cout << "serving from " << url << "\\n" << std::flush;

  app.get("/healthz", [](uvcpp_web_request&, uvcpp_web_response& resp, uvcpp_web_next) {
    // This route does not touch the database, on purpose: it answers whether the
    // process is serving. A database that is down is a fact about the routes that
    // need it, not a reason for the process to look dead.
    resp.status(200).json_str(R"({"status":"ok"})");
    resp.end();
  });

  // GET /items — every row, as the db module's own JSON
  // (\`{"table":…,"columns":[…],"rows":[…]}\`), so the escaping is libuvcpp's and
  // not a hand-rolled encoder's.
  //
  // The query is dispatched rather than run here. A handler runs on the event
  // loop thread and a database call blocks for as long as the server takes, so
  // the handler hands the work to the pool and returns; the callback runs on this
  // loop's thread, exactly once, and writes the response. Three things about that
  // hand-off are worth reading before changing this handler:
  //
  //   - \`next\` is captured **by value**, and that is what tells the framework
  //     this link will resume later, so the chain waits for it rather than
  //     finishing the request the moment the handler returns.
  //   - \`rp->end()\` marks the response written; \`next()\` is what resumes the
  //     chain and sends it. A callback that ends without resuming leaves the
  //     client waiting for a reply that is never sent.
  //   - When the pool cannot dispatch the query it returns non-zero and **never
  //     calls the callback**. That case is answered here, synchronously, or the
  //     request waits forever for a callback that does not exist.
  //
  // \`resp\` itself is not captured: \`rp\` points into the context that \`next\`
  // keeps alive, and it is the pointer the callback needs.
  app.get("/items",
          [&app, &pool](uvcpp_web_request&, uvcpp_web_response& resp, uvcpp_web_next next) {
            uvcpp_web_response* const rp = &resp;
            const int dispatched =
                pool.query(app.loop(), kSelectAll,
                           [rp, next](uvcpp_db_status status, const uvcpp_db_table& rows) {
                             if (uvcpp_db_ok(status)) {
                               rp->status(200).json_str(rows.to_json());
                             } else {
                               rp->status(500).json_str(DbError("query failed", status));
                             }
                             rp->end();
                             next();
                           });
            if (dispatched != 0) {
              resp.status(503).json_str(R"({"error":"the database is not accepting work"})");
              resp.end();
            }
          });

  // GET /items/:id — one row, or 404. The value is a bound parameter and never
  // string concatenation into the statement. \`?\` is the placeholder SQLite and
  // MySQL use, and libuvcpp passes it to the driver untranslated — so a
  // PostgreSQL connection string needs \`$1\` here instead, which is a change to
  // this line and to no other.
  app.get("/items/:id",
          [&app, &pool](uvcpp_web_request& req, uvcpp_web_response& resp, uvcpp_web_next next) {
            const std::string* const id = req.param("id");
            if (id == nullptr) {
              resp.status(400).json_str(R"({"error":"missing id"})");
              resp.end();
              return;
            }
            uvcpp_db_params params;
            params.add(*id);
            uvcpp_web_response* const rp = &resp;
            const int dispatched =
                pool.query(app.loop(), kSelectOne, params,
                           [rp, next](uvcpp_db_status status, const uvcpp_db_table& rows) {
                             if (!uvcpp_db_ok(status)) {
                               rp->status(500).json_str(DbError("query failed", status));
                             } else if (rows.empty()) {
                               rp->status(404).json_str(R"({"error":"not found"})");
                             } else {
                               rp->status(200).json_str(rows.to_json());
                             }
                             rp->end();
                             next();
                           });
            if (dispatched != 0) {
              resp.status(503).json_str(R"({"error":"the database is not accepting work"})");
              resp.end();
            }
          });

  // POST /items/:id — store the request body as this item's value.
  //
  // The body is the value verbatim, so this service parses no document format
  // and cannot fail on a malformed one. It is a POST and not a PUT because of
  // what the layer underneath can report: a failed execute carries one status
  // code whether the key was already taken or the connection dropped, so an
  // upsert would be a promise this code cannot keep, and a create that reports
  // the failure is the answer that is true.
  app.post("/items/:id",
           [&app, &pool](uvcpp_web_request& req, uvcpp_web_response& resp, uvcpp_web_next next) {
             const std::string* const id = req.param("id");
             if (id == nullptr) {
               resp.status(400).json_str(R"({"error":"missing id"})");
               resp.end();
               return;
             }
             const std::string value = req.body_str();
             if (value.empty()) {
               resp.status(400).json_str(R"({"error":"empty body"})");
               resp.end();
               return;
             }
             uvcpp_db_params params;
             params.add(*id);
             params.add(value);
             uvcpp_web_response* const rp = &resp;
             const int dispatched =
                 pool.execute(app.loop(), "INSERT INTO items (id, value) VALUES (?, ?)", params,
                              [rp, next](uvcpp_db_status status, int64_t affected) {
                                if (!uvcpp_db_ok(status)) {
                                  rp->status(500).json_str(DbError("not stored", status));
                                } else {
                                  // The driver's own count, passed on as a number
                                  // rather than read as a verdict.
                                  rp->status(201).json_str(
                                      std::string(R"({"stored":)") + std::to_string(affected) + "}");
                                }
                                rp->end();
                                next();
                              });
             if (dispatched != 0) {
               resp.status(503).json_str(R"({"error":"the database is not accepting work"})");
               resp.end();
             }
           });
${webTail(input)}`;

const websocketEchoMain = (input: TemplateInput): string =>
  `${webPreamble(input, ["#include <web/uvcpp_ws_connection.h>"])}
// Registering a WebSocket route implicitly enables WS support, so there is no
// separate enable call. The connection outlives this handler, and the framework
// owns it — never delete it.
int main() {
${webAppSetup(input)}
  app.get("/healthz", [](uvcpp_web_request&, uvcpp_web_response& resp, uvcpp_web_next) {
    resp.status(200).json_str(R"({"status":"ok"})");
    resp.end();
  });

  app.websocket("/echo", [](uvcpp_web_ws_request& ws) {
    uvcpp_ws_connection* conn = ws.connection();
    if (conn == nullptr) return;
    conn->on_text([conn](const std::string& message) {
      conn->send_text(message.data(), message.size());
    });
    conn->on_close([](ws_close_code code, const std::string& reason) {
      std::cout << "closed: " << static_cast<int>(code) << " " << reason << "\\n" << std::flush;
    });
  });
${webTail(input)}`;

const soapServiceMain = (input: TemplateInput): string =>
  `${webPreamble(input)}
namespace {

// A hand-written envelope. The wsdl module can generate this from a real WSDL;
// the template keeps it explicit so the shape is visible.
std::string QuoteEnvelope(const std::string& symbol) {
  return std::string(
             R"(<?xml version="1.0" encoding="utf-8"?>)"
             R"(<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">)"
             R"(<soap:Body><GetQuoteResponse xmlns="urn:example:quote">)"
             R"(<Symbol>)") +
         symbol +
         R"(</Symbol><Price>42.00</Price>)"
         R"(</GetQuoteResponse></soap:Body></soap:Envelope>)";
}

}  // namespace

// SOAP 1.1 posts to a single endpoint and dispatches on the SOAPAction header.
// Both the header and the envelope body are the caller's to validate; this
// template answers every request so that the transport is what gets exercised.
int main() {
${webAppSetup(input)}
  app.post("/ws", [](uvcpp_web_request&, uvcpp_web_response& resp, uvcpp_web_next) {
    resp.status(200);
    resp.set_header("content-type", "text/xml; charset=utf-8");
    resp.body(QuoteEnvelope("ACME"));
    resp.end();
  });
${webTail(input)}`;

const staticFilesMain = (input: TemplateInput): string =>
  `${webPreamble(input)}
// Serve ./public as the document root. serve_static registers four routes — the
// prefix and prefix/*path, each for GET and HEAD — and is a fallback: it always
// answers (404 included) rather than passing the request on. Routes registered
// before it still win on a literal match.
//
// The root is resolved against this process's *working directory*, not against
// the executable's location. Started from anywhere else, every static route
// answers 500 and the reason is not visible in the response, so the expectation
// is printed at startup. Keep the root inside the workspace; a static root
// computed from user input is how directory traversal happens.
int main() {
${webAppSetup(input)}
  app.get("/healthz", [](uvcpp_web_request&, uvcpp_web_response& resp, uvcpp_web_next) {
    resp.status(200).json_str(R"({"status":"ok"})");
    resp.end();
  });

  app.serve_static("/", "./public");

  std::cout << "serving ./public — start this binary from the project root, or "
               "static routes will return 500\\n" << std::flush;
${webTail(input)}`;

/**
 * The preamble of the one template that does not use `uvcpp_web_app`.
 *
 * `http3-service` is written against `uvcpp_http_server` because the web-app
 * layer's stream-claim hook is refused by the h3 leg — see the note on
 * `TEMPLATE_FEATURE_RULES`. The consequence for this file is that the web-app
 * headers, which carry the config macros into every other template, are not here
 * at all, so `<uvcpp/uvcpp_config.h>` is included explicitly and first: the
 * guards below are the first thing in the file that needs those macros, and a
 * missing include would turn each of them into a compile error about an
 * undefined identifier rather than the guard's own message.
 */
const http3Preamble = (input: TemplateInput): string => `#include <uvcpp/uvcpp_config.h>
#include <ssl/uvcpp_ssl_context.h>
#include <web/uvcpp_http_server.h>
#include <cstdlib>
#include <iostream>
#include <string>
${featureGuard(input)}
using namespace uvcpp;
`;

/**
 * The certificate, for a service that has no cleartext mode to fall back to.
 *
 * It is the same reading of the same two variables that `tlsSetup` does, and
 * deliberately not a second one: `certificateFromEnvironment` owns that
 * interpretation, including what an empty value means. What differs is what
 * happens next. `uvcpp_web_app` is handed the pair through `enable_ssl`, which
 * defers the read to the framework and reports through `ssl_error()`; the plain
 * server wants an `uvcpp_ssl_context` the operator builds, so the loads and the
 * `check_private_key` call are here and each failure names the file it came
 * from. Both refuse to start rather than serve something else, which is the
 * property that matters and the reason these are two spellings of one decision
 * rather than two decisions.
 *
 * The self-signed fallback is kept for the same reason `tlsSetup` keeps it: it
 * is what makes a freshly generated workspace runnable, and it is a certificate
 * no verifying client should accept — which uvp's own h3 probe does not, unless
 * it was told to.
 */
const http3CertificateSetup = (): string => `  uvcpp_ssl_context tls(tls_mode::SERVER);
${certificateFromEnvironment()}
  if (cert != nullptr) {
    if (!tls.load_certificate_file(cert) || !tls.load_private_key_file(key) || !tls.check_private_key()) {
      return Fail("TLS is unusable with " + std::string(cert) + " and " + std::string(key) +
                  ": HTTP/3 runs on QUIC, which has no cleartext mode, so this service will not "
                  "start rather than serve something a caller cannot verify.");
    }
    std::cout << "serving HTTPS with the certificate in " << cert << "\\n" << std::flush;
  } else {
    if (!tls.generate_self_signed("localhost")) {
      return Fail("no UVP_TLS_CERT/UVP_TLS_KEY were given and a self-signed certificate could "
                  "not be generated, so there is nothing for the QUIC leg to present.");
    }
    std::cout << "serving HTTPS with a generated self-signed certificate for localhost; clients "
                 "that verify will refuse it. Set UVP_TLS_CERT and UVP_TLS_KEY to serve a real "
                 "one.\\n" << std::flush;
  }
`;

/**
 * The HTTP/2 lines, when the workspace declared the `http2` module.
 *
 * Both are load-bearing and neither is the default. ALPN is how a TLS client and
 * this server agree on h2 — without a selector the TCP leg answers h1.1 to
 * everyone — and `set_http2_enabled` is off by default on the plain server,
 * which is the opposite of `uvcpp_web_app`. A selector set here applies to the
 * TCP leg only: the QUIC leg negotiates `h3` inside QUIC's own TLS handshake and
 * is not affected by it.
 */
const http3Http2Setup = (input: TemplateInput): string =>
  input.features.includes("http2")
    ? `
  // ALPN for the TCP leg, because this workspace declared the http2 module.
  // Without a selector the TLS listener answers h1.1 to everyone. This affects
  // the TCP leg only: the QUIC leg negotiates h3 inside QUIC's own handshake.
  tls.set_alpn_select_protos({"h2", "http/1.1"});
`
    : "";

/**
 * The `set_http2_enabled` call, and the note about the call that is not beside it.
 *
 * The omission is the interesting half, and it is written into the generated
 * source rather than only into this comment: a reader who knows the other
 * templates will look for `set_h2c_enabled` there, and finding nothing needs to
 * be told why nothing is the answer. h2c is HTTP/2 over a connection *without*
 * TLS, and the only TCP listener this service has carries a TLS context — so no
 * cleartext connection ever reaches the 24-byte preface check that decides h2c,
 * and the call would be a line that compiles, runs, and decides nothing.
 */
const http3Http2Enable = (input: TemplateInput): string =>
  input.features.includes("http2")
    ? `
  // HTTP/2 over TLS on the TCP leg. Off by default on the plain server, which is
  // the opposite of uvcpp_web_app, so it is stated here or h2 never happens. There
  // is no set_h2c_enabled beside it, and that is the decision rather than an
  // omission: h2c is HTTP/2 over a connection *without* TLS, while this listener
  // installs a TLS context — so no cleartext connection reaches h2c's preface
  // check, and the call would compile, run, and decide nothing.
  server.set_http2_enabled(true);`
    : "";

/**
 * An HTTP/3 service: one route table, two listeners.
 *
 * The shape is the point, and it is not obvious from either header alone.
 * `uvcpp_http_server` runs both transports on one loop and one route table, so
 * the routes are registered once and reachable over h1.1, h2 and h3 — the
 * handlers cannot tell which leg a request arrived on, and for a service that
 * only reads a path and writes a body that is the whole story. The two legs are
 * configured separately (`get_tcp_server()->set_ssl_context` and
 * `set_quic_ssl_context`) and can be given different contexts; this template
 * gives them the same one, because a service that presents two certificates is a
 * decision an operator should make deliberately rather than inherit from a
 * template.
 *
 * `bind` is the TCP half and `listen_quic` is the QUIC half; both must be done
 * before `run()`, and `listen()` is what makes the TCP port connectable. The
 * order below is the required one: the QUIC leg needs its TLS context installed
 * before `listen_quic` or it returns `UV_EINVAL` — the framework refuses to open
 * a QUIC endpoint it could not secure.
 */
const http3ServiceMain = (input: TemplateInput): string => `${http3Preamble(input)}
namespace {

/** A response body as text, with the header a caller needs to read it as text. */
void SendText(uvcpp_http_response& resp, http_status status, const std::string& body,
              const char* content_type) {
  resp.status_code = status;
  resp.headers.push_back(http_header{"content-type", content_type});
  resp.body = uvcpp_buf(body);
}

int Fail(const std::string& what) {
  std::cerr << what << "\\n";
  return 1;
}

}  // namespace

// There is no cleartext mode to fall back to and no second port for one: QUIC
// carries its TLS handshake inside the transport, so this service has a
// certificate before it has anything else, and the two listeners below share the
// port number — UDP for HTTP/3, TCP for HTTP/1.1${input.features.includes("http2") ? " and HTTP/2" : ""}.
int main() {
${http3CertificateSetup()}${http3Http2Setup(input)}
  uvcpp_http_server server;

  // One route table for both legs. A handler receives a uvcpp_tcp_client* that is
  // nullptr on the h3 leg, because on that leg there is no TCP connection behind
  // the request — code that uses that pointer has to check it, and this template
  // does not use it at all.
  server.get("/hello", [](uvcpp_http_request&, uvcpp_http_response& resp, uvcpp_tcp_client*) {
    SendText(resp, http_status::OK, "hello over HTTP/3", "text/plain; charset=utf-8");
  });
  server.get("/healthz", [](uvcpp_http_request&, uvcpp_http_response& resp, uvcpp_tcp_client*) {
    SendText(resp, http_status::OK, R"({"status":"ok"})", "application/json");
  });

  // The TCP leg. The handshake timeout is set explicitly, at the framework's own
  // default, because it is the bound that covers the case idle_timeout_ms does
  // not: a peer that opens a connection and never finishes the handshake is not
  // idle by the framework's reckoning.
  server.get_tcp_server()->set_ssl_context(&tls);
  server.get_tcp_server()->set_tls_handshake_timeout_ms(10000);${http3Http2Enable(input)}
  if (server.bind("0.0.0.0", ${String(input.port)}) != 0) {
    return Fail("could not bind TCP port ${String(input.port)}");
  }

  // The QUIC leg. QUIC has no cleartext mode, so this is the call that fails if
  // the context above was not installed.
  server.set_quic_ssl_context(&tls);
  const int quic = server.listen_quic(${String(input.port)}, "0.0.0.0");
  if (quic != 0) {
    return Fail("could not listen for HTTP/3 on UDP ${String(input.port)}: libuv error " +
                std::to_string(quic));
  }

  const int tcp = server.listen();
  if (tcp != 0) return Fail("could not listen: libuv error " + std::to_string(tcp));

  std::cout << "listening on https://127.0.0.1:${String(input.port)} (TCP HTTP/1.1${
    input.features.includes("http2") ? " and HTTP/2" : ""
  }) "
               "and HTTP/3 over QUIC on UDP "
            << server.quic_listen_port() << "\\n" << std::flush;

  const int rc = server.run();
  std::cerr << "the server loop ended with " << rc << "\\n";
  return rc == 0 ? 0 : 1;
}
`;

const MAIN_BY_TEMPLATE: Record<TemplateId, (input: TemplateInput) => string> = {
  "hello-http": helloHttpMain,
  "rest-api": restApiMain,
  "websocket-echo": websocketEchoMain,
  "soap-service": soapServiceMain,
  "static-files": staticFilesMain,
  "http3-service": http3ServiceMain,
};

/**
 * The workspace manifest.
 *
 * uvp reads this to learn the project's declared port and binary without
 * guessing at CMake. It is deliberately small and additive.
 *
 * There is no `scheme` field, and that is a decision rather than an omission:
 * the transport is a consequence of the feature list directly below, so a second
 * field stating it could state it differently. `readWorkspaceManifest` — the one
 * owner of this file's meaning — reads the scheme out of `features`.
 */
const manifest = (input: TemplateInput, template: TemplateId): string =>
  `${JSON.stringify(
    {
      uvp: 1,
      name: input.name,
      template,
      binary: input.name,
      port: input.port,
      features: input.features,
      requirements: { libuvcpp: `>=${LIBUVCPP_BASELINE}` },
    },
    null,
    2,
  )}\n`;

/**
 * The section a `tls` workspace's README needs and the others must not carry.
 *
 * It is here rather than only in the generated source because it is a deployment
 * fact: a service that comes up on a self-signed certificate is something the
 * person running it has to know before a client refuses it, and `uvp.json` says
 * `tls` without saying which kind of certificate that implies.
 */
const tlsReadme = (input: TemplateInput): string => {
  if (!input.features.includes("tls")) return "";
  return `
## TLS

This service serves **HTTPS**, and refuses to start rather than fall back to
cleartext. It takes its certificate from the environment:

\`\`\`bash
UVP_TLS_CERT=/etc/ssl/private/svc.crt UVP_TLS_KEY=/etc/ssl/private/svc.key ./build/${input.name}
\`\`\`

With neither variable set it generates a self-signed certificate for
\`localhost\` and prints a line saying so. That is a development certificate:
every client that checks certificates, uvp's own included, will refuse it.
Setting only one of the two variables is an error and stops the service, because
the missing half could belong to either arrangement.

\`uvp verify\` does not check the certificate unless you pass \`--tls\`, so a
freshly generated workspace verifies out of the box. Passing \`--tls\` makes the
certificate part of the verdict, and a self-signed service then fails the pass
with the reason OpenSSL gave — which is the honest result, and what
\`NODE_EXTRA_CA_CERTS\` is the way out of.
`;
};

/**
 * The section a `db` workspace's README needs and the others must not carry.
 *
 * Four facts here are not visible from the generated source without reading
 * libuvcpp's headers: which connection strings work, that only one of the three
 * dialects needs nothing installed on the host, that the placeholder syntax is
 * the dialect's business rather than the library's, and that the async call
 * shares libuv's default worker pool with DNS and file IO. All four are
 * deployment facts, and the second and fourth are the ones that turn into a
 * mystery at three in the morning.
 */
const databaseReadme = (input: TemplateInput): string => {
  if (!input.features.includes("db")) return "";
  return `
## Database

This service keeps its items in a database, which it reaches through libuvcpp's
db module. The connection string comes from the environment:

\`\`\`bash
UVP_DATABASE_URL=sqlite:///var/lib/${input.name}/app.db ./build/${input.name}
\`\`\`

With it unset the service opens \`./${input.name}.db\` in the working directory
and prints the path it is serving from at startup. That default is a SQLite file
— a library, not a server — and it is what makes a generated workspace runnable
with nothing installed but libuvcpp. \`uvp verify\` starts this service with no
environment, so it verifies against that default.

Three connection strings are accepted:

| Dialect    | Example                                    | Needs on this host     |
| ---------- | ------------------------------------------ | ---------------------- |
| SQLite     | \`sqlite:///var/lib/app.db\`                 | the library only       |
| MySQL      | \`mysql://user:pass@127.0.0.1:3306/app\`     | the client library     |
| PostgreSQL | \`postgres://user:pass@127.0.0.1:5432/app\`  | the client library     |

The drivers are loaded **at run time**, so the project itself still links nothing
but \`uvcpp\` and pointing it at MySQL or PostgreSQL needs no rebuild — but the
client library has to be on the host, and its absence is reported at startup
rather than on the first request.

Two things to know before pointing this at PostgreSQL:

- The placeholders in \`src/main.cpp\` are \`?\`. PostgreSQL wants \`$1\`, \`$2\`, and
  libuvcpp passes a statement to the driver untranslated, so the three statements
  in that file are the lines to change.
- The schema is created at startup with \`CREATE TABLE IF NOT EXISTS\`. That is
  what keeps a fresh deployment to one environment variable; a deployment with
  migrations of its own should drop the statement.

The pool opens at most 4 connections and sets a 5 s statement timeout on each.
Both are set in \`src/main.cpp\`, on \`pool.init\` and \`pool.set_timeout_ms\`.

Queries run on libuv's worker pool — 4 threads unless \`UV_THREADPOOL_SIZE\` says
otherwise — and that pool is shared with DNS and file IO. A service with more
concurrent database work than that should raise it with \`UV_THREADPOOL_SIZE\` or
\`uvcpp_set_threadpool_size(n)\` **before the first query is dispatched**; after
that the size is fixed for the life of the process.
`;
};

/**
 * The section an HTTP/3 workspace's README needs and the others must not carry.
 *
 * Two things about this service are not visible from the source in the way they
 * are for the others: that it answers on two transports with one route table,
 * and that the ordinary tools a reader would reach for do not speak the second
 * one. Both are deployment facts, so both are stated here.
 */
const http3Readme = (input: TemplateInput): string => `
## HTTP/3

This service puts **one route table on two transports**:

| Transport | Protocol | Port |
| --------- | ------------------------- | ---- |
| UDP | HTTP/3 over QUIC | ${String(input.port)} |
| TCP | HTTP/1.1${input.features.includes("http2") ? " and HTTP/2" : ""} over TLS | ${String(input.port)} |

A handler cannot tell which leg a request arrived on, so the routes above are
reachable over any of them. The TCP leg is what the port number in \`uvp.json\`
refers to, and it is the one a browser or \`curl\` will use without being told
anything.

Talking to the QUIC leg takes a client that speaks HTTP/3 — \`curl\` does not
unless it was built with \`--http3\`. \`uvp http\` does, through the probe it
keeps for exactly this:

\`\`\`bash
uvp http https://127.0.0.1:${String(input.port)}/hello --http-version 3 --no-tls
\`\`\`

Both legs present the same certificate, which here is the generated self-signed
one — so a client that verifies refuses it, and \`--no-tls\` is what a request
against a freshly generated service needs. uvp does not skip the check on the
caller's behalf: with it on, the request is refused before anything is spawned,
and with it off the result says \`verification: not_checked\` rather than
claiming a chain it never examined.
`;

/**
 * How to change the port, which is not the same instruction for every template.
 *
 * The web-app templates take theirs from `set_port`; `http3-service` is written
 * against the plain server and binds it in `bind` and `listen_quic`. A README
 * that named the wrong function would send a reader to edit a line their project
 * does not contain — and the reader most likely to follow it is the one whose
 * port is already busy, which is exactly when nothing else works either.
 */
const portNote = (template: TemplateId, input: TemplateInput): string => {
  const recorded = "the port is also recorded in `uvp.json` so tooling can find it.";
  return template === "http3-service"
    ? `The service listens on port ${String(input.port)} over both transports. If that port is
busy, change the number in \`server.bind\` and \`server.listen_quic\` in \`src/main.cpp\` —
${recorded}`
    : `The service listens on port ${String(input.port)}. If that port is busy, edit
\`set_port\` in \`src/main.cpp\` — ${recorded}`;
};

const readme = (input: TemplateInput, template: TemplateId): string => `# ${input.name}

Generated by [uvp](https://github.com/Antruly/uvp) from the \`${template}\` template.
This is an ordinary CMake project that links against
[libuvcpp](https://github.com/Antruly/libuvcpp) ${LIBUVCPP_BASELINE} or newer; you
do not need uvp to build or run it.

## Build

\`\`\`bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build
\`\`\`

If libuvcpp is not in a standard prefix:

\`\`\`bash
cmake -S . -B build -DCMAKE_PREFIX_PATH=/path/to/libuvcpp
\`\`\`

## Run

Run from the project root — a relative path in \`src/main.cpp\` (the static
document root, for instance) is resolved against the working directory, not the
binary's location:

\`\`\`bash
./build/${input.name}
\`\`\`

${portNote(template, input)}
${tlsReadme(input)}${databaseReadme(input)}${template === "http3-service" ? http3Readme(input) : ""}
## Verify

\`\`\`bash
uvp verify ${input.name} --port ${String(input.port)}
\`\`\`
`;

export const renderTemplate = (
  template: TemplateId,
  input: TemplateInput,
): readonly GeneratedFile[] => {
  const files: GeneratedFile[] = [
    { path: "CMakeLists.txt", content: cmakeLists(input) },
    { path: "src/main.cpp", content: MAIN_BY_TEMPLATE[template](input) },
    { path: "uvp.json", content: manifest(input, template) },
    { path: "README.md", content: readme(input, template) },
    {
      path: ".gitignore",
      // A database-backed workspace has a database in it, and a SQLite database
      // is several files beside the one named in the connection string. Ignored
      // because it is where the *running* service writes, not source — the same
      // reason the build directory is.
      content:
        "build/\ncompile_commands.json\n" +
        (input.features.includes("db") ? "*.db\n*.db-journal\n*.db-wal\n*.db-shm\n" : ""),
    },
  ];
  if (template === "static-files") {
    files.push({
      path: "public/index.html",
      content: `<!doctype html>\n<title>${input.name}</title>\n<h1>${input.name}</h1>\n`,
    });
  }
  return files;
};

// A second manifest reader used to live here, parsing the port out of the text
// `manifest()` had just written. It is gone: `readWorkspaceManifest` in
// workspaceManifest.ts reads a manifest from disk and validates every field, and
// two readers that agree today are two readers that will disagree later.
