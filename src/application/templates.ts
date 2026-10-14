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
] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

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
const webPreamble = (input: TemplateInput, extra: readonly string[] = []): string =>
  `#include <webapp/uvcpp_web_app.h>
#include <webapp/uvcpp_web_request.h>
#include <webapp/uvcpp_web_response.h>
${extra.map((line) => `${line}\n`).join("")}
#include <iostream>
#include <string>
${featureGuard(input)}
using namespace uvcpp;
`;

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

const helloHttpMain = (input: TemplateInput): string =>
  `${webPreamble(input)}
// A single route, wired by hand. Everything uvp generates ends up looking like
// this: ordinary libuvcpp code that a C++ developer would recognise.
//
// The handler takes a third parameter, next. Leaving it uncalled and ending the
// response is the normal case; calling it would pass the request on to the next
// matching handler.
int main() {
  uvcpp_web_app app;
  app.set_port(${String(input.port)});

  app.get("/hello", [](uvcpp_web_request&, uvcpp_web_response& resp, uvcpp_web_next) {
    resp.status(200).json_str(R"({"message":"Hello, AI"})");
    resp.end();
  });
${webTail(input)}`;

const restApiMain = (input: TemplateInput): string =>
  `${webPreamble(input, ["#include <unordered_map>"])}
namespace {

// An in-memory store, so the template is runnable with no database. Replace it
// with the db module when the service needs durability.
std::unordered_map<std::string, std::string> g_items = {{"1", "first"}, {"2", "second"}};

std::string JsonItem(const std::string& id, const std::string& value) {
  return std::string(R"({"id":")") + id + R"(","value":")" + value + R"("})";
}

}  // namespace

int main() {
  uvcpp_web_app app;
  app.set_port(${String(input.port)});

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

const websocketEchoMain = (input: TemplateInput): string =>
  `${webPreamble(input, ["#include <web/uvcpp_ws_connection.h>"])}
// Registering a WebSocket route implicitly enables WS support, so there is no
// separate enable call. The connection outlives this handler, and the framework
// owns it — never delete it.
int main() {
  uvcpp_web_app app;
  app.set_port(${String(input.port)});

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
  uvcpp_web_app app;
  app.set_port(${String(input.port)});

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
  uvcpp_web_app app;
  app.set_port(${String(input.port)});

  app.get("/healthz", [](uvcpp_web_request&, uvcpp_web_response& resp, uvcpp_web_next) {
    resp.status(200).json_str(R"({"status":"ok"})");
    resp.end();
  });

  app.serve_static("/", "./public");

  std::cout << "serving ./public — start this binary from the project root, or "
               "static routes will return 500\\n" << std::flush;
${webTail(input)}`;

const MAIN_BY_TEMPLATE: Record<TemplateId, (input: TemplateInput) => string> = {
  "hello-http": helloHttpMain,
  "rest-api": restApiMain,
  "websocket-echo": websocketEchoMain,
  "soap-service": soapServiceMain,
  "static-files": staticFilesMain,
};

/**
 * The workspace manifest.
 *
 * uvp reads this to learn the project's declared port and binary without
 * guessing at CMake. It is deliberately small and additive.
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

The service listens on port ${String(input.port)}. If that port is busy, edit
\`set_port\` in \`src/main.cpp\` — the port is also recorded in \`uvp.json\` so
tooling can find it.

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
    { path: ".gitignore", content: "build/\ncompile_commands.json\n" },
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
