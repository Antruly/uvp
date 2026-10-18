import { describe, expect, it } from "vitest";

import { TEMPLATE_IDS, renderTemplate, templateRoutes } from "./templates.js";
import type { TemplateId } from "./templates.js";
import { UVP_FEATURES } from "../domain/features.js";
import type { UvpFeature } from "../domain/features.js";

/**
 * What a generated workspace says, and what the code it writes actually does.
 *
 * A workspace's `uvp.json` names the libuvcpp modules it needs, and `uvp doctor
 * --workspace` is asked about that list. So the list is a claim, and the test
 * here is the one that keeps it from being a claim with nothing behind it: a
 * feature that changes nothing in the generated C++ is a build requirement, and
 * a feature that does change it is a protocol the service speaks.
 *
 * `http2` is the first feature in the second category. It is checked here rather
 * than in the lane that builds a real service because the question — does the
 * requested feature reach the generated source at all — is a question about a
 * string, and the lane that compiles takes minutes to answer it.
 */

const render = (template: TemplateId, features: readonly UvpFeature[]): string => {
  const files = renderTemplate(template, { name: "svc", port: 8080, features });
  const main = files.find((file) => file.path === "src/main.cpp");
  if (main === undefined) throw new Error(`${template} produced no src/main.cpp`);
  return main.content;
};

const manifest = (
  template: TemplateId,
  features: readonly UvpFeature[],
): Record<string, unknown> => {
  const files = renderTemplate(template, { name: "svc", port: 8080, features });
  const file = files.find((entry) => entry.path === "uvp.json");
  if (file === undefined) throw new Error(`${template} produced no uvp.json`);
  return JSON.parse(file.content) as Record<string, unknown>;
};

const cmakeLists = (template: TemplateId, features: readonly UvpFeature[]): string => {
  const files = renderTemplate(template, { name: "svc", port: 8080, features });
  const file = files.find((entry) => entry.path === "CMakeLists.txt");
  if (file === undefined) throw new Error(`${template} produced no CMakeLists.txt`);
  return file.content;
};

describe("the generated CMake tells MSVC what character set the sources use", () => {
  it.each(TEMPLATE_IDS)("%s compiles its UTF-8 sources on a non-UTF-8 code page", (template) => {
    // MSVC decodes a source without a BOM in the system code page. On a Chinese
    // Windows install that is 936/GBK, so a UTF-8 source with Chinese comments or
    // string literals is decoded as GBK and fails to compile. `/utf-8` is the
    // switch that makes the bytes mean what this writer wrote.
    const cmake = cmakeLists(template, template === "http3-service" ? ["tls", "http3"] : []);
    expect(cmake).toContain("/permissive- /utf-8");
  });

  it("keeps the MSVC switch out of the GCC and Clang branch", () => {
    // The file has other if/else pairs (the libuvcpp discovery route is one), so
    // split from the compiler branch rather than from the first `else()`.
    const cmake = cmakeLists("hello-http", []);
    const compilerBranch = cmake.indexOf("if (MSVC)");
    expect(compilerBranch).toBeGreaterThanOrEqual(0);
    const [msvcBranch = "", otherBranch = ""] = cmake.slice(compilerBranch).split("else()");
    expect(msvcBranch).toContain("/utf-8");
    expect(otherBranch).toContain("target_compile_options(svc PRIVATE -Wall -Wextra -Wpedantic)");
    expect(otherBranch).not.toContain("/utf-8");
  });
});

/**
 * Every template that starts a `uvcpp_web_app` — which is no longer all of them.
 *
 * `http3-service` is written against the plain `uvcpp_http_server`, because the
 * web-app layer's stream-claim hook is refused by the h3 leg and a request that
 * reaches one is answered 500 rather than routed. Every assertion in the two
 * blocks below is about a `uvcpp_web_app` method, so looping the h3 template in
 * would assert that it calls functions it must not call. Leaving it out and
 * saying nothing would be worse in the other direction — it is the one template
 * with a transport the others do not have — so it has its own block underneath.
 */
const WEB_TEMPLATES: readonly TemplateId[] = TEMPLATE_IDS.filter(
  (template) => template !== "http3-service",
);

describe("the http2 feature reaches the generated service", () => {
  it.each(WEB_TEMPLATES)("%s turns on cleartext HTTP/2 on its port", (template) => {
    expect(render(template, ["http2"])).toContain("app.set_h2c_enabled(true);");
  });

  it.each(WEB_TEMPLATES)("%s leaves it off when the feature was not requested", (template) => {
    // The negative control. Without it, a template that emitted the call
    // unconditionally would pass every assertion above — and the feature list
    // would be decoration again, which is the thing this whole file is about.
    expect(render(template, ["websocket"])).not.toContain("set_h2c_enabled");
    expect(render(template, [])).not.toContain("set_h2c_enabled");
  });

  it.each(WEB_TEMPLATES)("%s enables it before start(), where it takes effect", (template) => {
    // `set_h2c_enabled` is read at accept time and is a no-op after `start()`.
    // A call placed after the server is listening is a line that compiles, runs,
    // and changes nothing.
    const source = render(template, ["http2"]);
    const enabled = source.indexOf("set_h2c_enabled(true)");
    const started = source.indexOf("app.start()");
    expect(enabled).toBeGreaterThan(-1);
    expect(started).toBeGreaterThan(-1);
    expect(enabled).toBeLessThan(started);
  });

  it.each(WEB_TEMPLATES)("%s still sets the port exactly once", (template) => {
    // The setup block replaced five hand-written copies of these two lines, so
    // the way it can go wrong is by writing the port twice — which would compile
    // and then serve on whichever call came last.
    const source = render(template, ["http2"]);
    expect(source.match(/app\.set_port\(/gu)).toHaveLength(1);
    expect(source).toContain("app.set_port(8080);");
  });

  it("asks the build for the module the code now uses", () => {
    // The other half of the same claim: the guard is what turns "this libuvcpp
    // has no nghttp2" into one readable compile error instead of a cascade.
    expect(render("hello-http", ["http2"])).toContain("#if !UVCPP_NGHTTP2_ENABLE");
    expect(manifest("hello-http", ["http2"])["features"]).toEqual(["http2"]);
  });
});

describe("the tls feature reaches the generated service", () => {
  /** The generated README, which is where a deployment fact has to be written down. */
  const readme = (template: TemplateId, features: readonly UvpFeature[]): string => {
    const files = renderTemplate(template, { name: "svc", port: 8080, features });
    const file = files.find((entry) => entry.path === "README.md");
    if (file === undefined) throw new Error(`${template} produced no README.md`);
    return file.content;
  };

  it.each(WEB_TEMPLATES)("%s serves TLS instead of cleartext", (template) => {
    const source = render(template, ["tls"]);
    expect(source).toContain("app.enable_ssl(cert, key);");
    expect(source).toContain("app.set_tls_handshake_timeout_ms(10000);");
    expect(source).toContain("#include <cstdlib>");
    expect(manifest(template, ["tls"])["features"]).toEqual(["tls"]);
  });

  it.each(WEB_TEMPLATES)("%s writes no TLS code without the feature", (template) => {
    // The negative control, and the reason it is not decoration: a template that
    // emitted `enable_ssl` unconditionally would link against OpenSSL in every
    // workspace and fail to build wherever libuvcpp was configured without it.
    for (const features of [[], ["websocket"], ["http2"]] as const) {
      expect(render(template, features)).not.toContain("enable_ssl");
      expect(render(template, features)).not.toContain("#include <cstdlib>");
    }
  });

  it.each(WEB_TEMPLATES)("%s refuses to start rather than serve cleartext", (template) => {
    // The failure this whole block exists to prevent, and the only one nobody
    // can see from outside: a caller who asked for HTTPS and got HTTP has
    // traffic that looks protected from their side and is not. So both
    // misconfigurations — half a certificate pair, and a pair libuvcpp cannot
    // read — must return before `start()`, which is what makes them refusals
    // rather than messages printed next to a running plaintext server.
    const source = render(template, ["tls"]);
    const started = source.indexOf("app.start()");
    expect(started).toBeGreaterThan(-1);
    // Read as a block, because `return 1;` appears elsewhere in these templates
    // for reasons that have nothing to do with certificates — counting them in
    // the whole file would be counting the wrong thing and passing by accident
    // on whichever count happened to match.
    const setup = source.slice(
      source.indexOf('std::getenv("UVP_TLS_CERT")'),
      source.indexOf("set_tls_handshake_timeout_ms"),
    );
    expect(setup).not.toBe("");
    expect(setup.match(/return 1;/gu)).toHaveLength(2);
    expect(source.indexOf("set_tls_handshake_timeout_ms")).toBeLessThan(started);
    expect(source.indexOf("app.enable_ssl(cert, key);")).toBeLessThan(started);
  });

  it.each(WEB_TEMPLATES)("%s hands the pair over before it checks it", (template) => {
    // `enable_ssl` is where libuvcpp reads and validates the pair, so a check
    // placed before the call would be reading an empty `ssl_error()` and calling
    // every certificate good.
    const source = render(template, ["tls"]);
    expect(source.indexOf("app.enable_ssl(")).toBeLessThan(source.indexOf("app.ssl_error()"));
  });

  it.each(WEB_TEMPLATES)("%s generates a certificate only when it was given none", (template) => {
    // The self-signed fallback is the *else* branch. Reached in the wrong order
    // it would silently replace a real certificate the operator supplied, and
    // the service would come up on one no client accepts — with the operator
    // holding a certificate file that nothing reads.
    const source = render(template, ["tls"]);
    expect(source.indexOf("if (cert != nullptr)")).toBeLessThan(
      source.indexOf("app.enable_self_signed"),
    );
    expect(source).toContain('app.enable_self_signed("localhost");');
  });

  it.each(WEB_TEMPLATES)("%s says in its README what the certificate will be", (template) => {
    const text = readme(template, ["tls"]);
    expect(text).toContain("## TLS");
    expect(text).toContain("UVP_TLS_CERT=/etc/ssl/private/svc.crt");
    expect(text).toContain("self-signed");
    expect(text).toContain("--tls");
    // A workspace that did not ask for TLS must not describe a certificate it
    // does not serve either.
    expect(readme(template, ["http2"])).not.toContain("## TLS");
  });
});

describe("the http3-service template, which is not a uvcpp_web_app", () => {
  const H3: readonly UvpFeature[] = ["tls", "http3"];

  /** The generated README, which is where a deployment fact has to be written down. */
  const readme = (features: readonly UvpFeature[]): string => {
    const files = renderTemplate("http3-service", { name: "svc", port: 8080, features });
    const file = files.find((entry) => entry.path === "README.md");
    if (file === undefined) throw new Error("http3-service produced no README.md");
    return file.content;
  };

  it("puts one route table on two transports, with no web app anywhere", () => {
    const source = render("http3-service", H3);
    // The shape a reader has to get right: `uvcpp_http_server` runs both legs on
    // one loop and one table, so the routes are registered once and reached over
    // any of them. The handler's third parameter is the `uvcpp_tcp_client*` that
    // is null on the h3 leg.
    expect(source).toContain("uvcpp_http_server server;");
    expect(source.match(/server\.get\("/gu)).toHaveLength(2);
    expect(source).not.toContain("uvcpp_web_app");
  });

  it("installs the QUIC context before it listens, and listens before it runs", () => {
    // The header's own required order, and each edge of it is a line that
    // compiles and does nothing if it is wrong: a QUIC endpoint whose context is
    // missing is refused with `UV_EINVAL` rather than opened, and a port is only
    // connectable after `listen`.
    const source = render("http3-service", H3);
    const context = source.indexOf("set_quic_ssl_context");
    const listenQuic = source.indexOf("server.listen_quic(");
    const listen = source.indexOf("server.listen();");
    const run = source.indexOf("server.run()");
    for (const at of [context, listenQuic, listen, run]) expect(at).toBeGreaterThan(-1);
    expect(context).toBeLessThan(listenQuic);
    expect(listenQuic).toBeLessThan(listen);
    expect(listen).toBeLessThan(run);
  });

  it("gives both legs the same certificate, and says which port each is on", () => {
    const source = render("http3-service", H3);
    expect(source).toContain("server.get_tcp_server()->set_ssl_context(&tls);");
    expect(source).toContain("server.set_quic_ssl_context(&tls);");
    // The UDP port is the one the caller cannot check by connecting, so it is
    // read back and printed rather than assumed to be the number passed in.
    expect(source).toContain("server.quic_listen_port()");
    expect(source).toContain('server.bind("0.0.0.0", 8080)');
    expect(source).toContain("server.listen_quic(8080,");
  });

  it("refuses to start rather than serve something a caller cannot verify", () => {
    // This template has no cleartext mode to fall back to, so every way of being
    // misconfigured ends in a return before the listeners are opened: half a
    // certificate pair, a pair libuvcpp cannot read, and a self-signed
    // certificate that could not be generated. A service that came up anyway
    // would be one no client can verify, which is the failure the whole
    // certificate block exists for.
    const source = render("http3-service", H3);
    const start = source.indexOf("uvcpp_http_server server;");
    expect(start).toBeGreaterThan(-1);
    // Read as a block, because `return 1;` appears elsewhere in this file's
    // generated source for reasons that have nothing to do with certificates.
    const setup = source.slice(source.indexOf('std::getenv("UVP_TLS_CERT")'), start);
    expect(setup.match(/return 1;|return Fail\(/gu)).toHaveLength(3);
    expect(source.indexOf("tls.load_certificate_file")).toBeLessThan(start);
  });

  it("generates a certificate only when it was given none", () => {
    const source = render("http3-service", H3);
    expect(source.indexOf("if (cert != nullptr)")).toBeLessThan(
      source.indexOf("tls.generate_self_signed"),
    );
    // `generate_self_signed` returns a bool here — unlike `uvcpp_web_app`'s
    // `enable_self_signed`, which returns nothing — so a certificate that could
    // not be generated is a case this service can refuse rather than a line it
    // prints and then serves on.
    expect(source).toContain('if (!tls.generate_self_signed("localhost"))');
  });

  it("turns on HTTP/2 for the TCP leg, and never h2c", () => {
    const source = render("http3-service", H3.concat("http2"));
    // Both halves are load-bearing and neither is the default on the plain
    // server, which is the opposite of `uvcpp_web_app`: ALPN is how a TLS client
    // and this server agree on h2, and `set_http2_enabled` is what lets them.
    expect(source).toContain('tls.set_alpn_select_protos({"h2", "http/1.1"});');
    expect(source).toContain("server.set_http2_enabled(true);");

    // h2c is deliberately absent, and this is the assertion that says so. h2c is
    // HTTP/2 over a *cleartext* connection, and this server installs a TLS
    // context on its only TCP listener — so no cleartext connection can reach
    // h2c's 24-byte preface check, and the call would be a line that compiles,
    // runs, and decides nothing.
    expect(source).not.toContain("set_h2c_enabled(true)");

    // The negative control: without the feature, neither line is there at all.
    const cleartext = render("http3-service", H3);
    expect(cleartext).not.toContain("set_http2_enabled");
    expect(cleartext).not.toContain("alpn_select_protos");
    expect(manifest("http3-service", H3)["features"]).toEqual(["tls", "http3"]);
  });

  it("guards every module its headers need, including the web layer", () => {
    // The guard is what turns "this libuvcpp has no QUIC" into one readable
    // compile error. `UVCPP_WEB_ENABLE` is the one a reader would not expect
    // here: the h3 *client* headers install without the web layer, so a check
    // that stopped at HTTP3 and QUIC would pass on a build with no h3 listener.
    const source = render("http3-service", H3);
    for (const symbol of [
      "UVCPP_OPENSSL_ENABLE",
      "UVCPP_HTTP3_ENABLE",
      "UVCPP_QUIC_ENABLE",
      "UVCPP_WEB_ENABLE",
    ]) {
      expect(source, `${symbol} produced no guard`).toContain(`#if !${symbol}`);
    }
  });

  it("says in its README which transport a reader's tools will use", () => {
    const text = readme(H3);
    expect(text).toContain("## HTTP/3");
    expect(text).toContain("HTTP/3 over QUIC");
    // The instruction that would otherwise be wrong: this project has no
    // `set_port`, and the other templates' README says to edit one.
    expect(text).toContain("`server.bind` and `server.listen_quic`");
    expect(text).not.toContain("edit\n`set_port`");
    // The command a reader would copy, with the flag the self-signed default
    // makes necessary. A README that omitted it would hand out a call that is
    // refused before it runs.
    expect(text).toContain("--http-version 3 --no-tls");
  });
});

describe("the db feature reaches the generated service", () => {
  it("replaces the in-memory store with the db module's pool", () => {
    const source = render("rest-api", ["db"]);
    expect(source).toContain("#include <db/uvcpp_db_pool.h>");
    expect(source).toContain("uvcpp_db_pool pool;");
    expect(source).toContain("uvcpp_db_params params;");
    // The connection string is the caller's, and the pool is opened where a
    // failure can be reported at startup rather than on the first request.
    expect(source).toContain("UVP_DATABASE_URL");
    expect(source).toContain("pool.init(url, 1, 4)");
    // The store it replaced, gone rather than left beside the new one.
    expect(source).not.toContain("unordered_map");
    expect(manifest("rest-api", ["db"])["features"]).toEqual(["db"]);
  });

  it("leaves the in-memory store alone when the feature was not requested", () => {
    // The other half, and the one that would catch a branch that always took the
    // database path: a workspace that never asked for a database must not open
    // one, and must not read an environment variable to find out where it is.
    const source = render("rest-api", []);
    expect(source).toContain("std::unordered_map<std::string, std::string> g_items");
    expect(source).not.toContain("uvcpp_db_");
    expect(source).not.toContain("UVP_DATABASE_URL");
    expect(source).not.toContain("getenv");
  });

  it("answers the same routes with either store", () => {
    // The feature changes where the bytes live, not what the service says — so
    // the route table is the same one in both files. A caller who swaps the
    // store keeps their client.
    const memory = render("rest-api", []);
    const database = render("rest-api", ["db"]);
    for (const source of [memory, database]) {
      for (const route of ['"/healthz"', '"/items"', '"/items/:id"']) {
        expect(source, `${route} missing`).toContain(route);
      }
    }
    // The write route is new, because a store that cannot be written to has no
    // durability to test.
    expect(memory).not.toContain("app.post(");
    expect(database).toContain('app.post("/items/:id"');
  });

  it("resumes the chain after every dispatched query, and answers when it cannot dispatch", () => {
    // Three properties of the async shape, each of which fails silently and each
    // of which this template asserts about itself rather than leaving to a lane
    // that takes minutes to run.
    //
    // 1. One `rv->end()` + `next()` pair per dispatch. Ending without resuming
    //    leaves the client waiting for a reply nobody sends, and there is no
    //    error anywhere to say so.
    // 2. The `next` in each callback captured by value — that is what tells the
    //    framework this link resumes later, so the chain waits instead of
    //    finishing the request when the handler returns.
    // 3. The synchronous 503 for a dispatch that never happens: when the pool
    //    returns non-zero it **never calls the callback**, so a handler that did
    //    not answer for that case would leave the request open for good.
    // The dispatched calls are the ones given a loop. The schema statement at
    // startup is deliberately not one of them: it runs before `app.start()`, on
    // a thread that is not the loop's, which is the only place the synchronous
    // pool methods are allowed.
    const source = render("rest-api", ["db"]);
    const dispatches = source.match(/pool\.(?:query|execute)\(app\.loop\(/gu) ?? [];
    expect(dispatches.length).toBeGreaterThan(0);
    expect(source.match(/rp->end\(\);\n\s+next\(\);/gu) ?? []).toHaveLength(dispatches.length);
    expect(source.match(/\[rp, next\]\(/gu) ?? []).toHaveLength(dispatches.length);
    expect(source.match(/if \(dispatched != 0\)/gu) ?? []).toHaveLength(dispatches.length);
    expect(source).toContain('"the database is not accepting work"');
  });

  it("documents the database in the generated README, and only when it is one", () => {
    const readme = (features: readonly UvpFeature[]): string => {
      const files = renderTemplate("rest-api", { name: "svc", port: 8080, features });
      const file = files.find((entry) => entry.path === "README.md");
      if (file === undefined) throw new Error("no README.md");
      return file.content;
    };
    const text = readme(["db"]);
    expect(text).toContain("## Database");
    // The facts a reader cannot get from the source without opening libuvcpp's
    // headers: where the connection string comes from, which dialects exist,
    // which of them needs nothing on the host, and that the placeholders are the
    // dialect's business.
    expect(text).toContain("UVP_DATABASE_URL");
    expect(text).toContain("sqlite://");
    expect(text).toContain("postgres://");
    expect(text).toContain("$1");
    // A database file is where the running service writes, so it is ignored —
    // the same reason the build directory is.
    const gitignore = renderTemplate("rest-api", {
      name: "svc",
      port: 8080,
      features: ["db"],
    }).find((entry) => entry.path === ".gitignore");
    expect(gitignore?.content).toContain("*.db");
    expect(readme([])).not.toContain("## Database");
  });
});

describe("requesting a feature a web-app template has no code for", () => {
  it("records http3 in the manifest and writes no HTTP/3 code for it", () => {
    // Stated rather than left implicit, because the two are different facts and
    // the manifest is what a later `uvp doctor --workspace` reads. `uvcpp_web_app`
    // has no HTTP/3 listener — it documents the switch as arriving "when there is
    // h3" — so on a web-app template the feature buys a build requirement and a
    // compile-time guard, not a protocol. The transport exists in libuvcpp, which
    // is why `http3-service` is written against the plain server instead; this
    // test is about what happens when a caller asks a web-app template for it.
    const source = render("hello-http", ["http3"]);
    expect(manifest("hello-http", ["http3"])["features"]).toEqual(["http3"]);
    expect(source).toContain("#if !UVCPP_HTTP3_ENABLE");
    // Every entry point libuvcpp offers for serving or speaking h3, none of them
    // reachable from a generated service.
    for (const api of ["uvcpp_h3_", "set_http3", "listen_quic", "uvcpp_quic_"]) {
      expect(source).not.toContain(api);
    }
  });

  it("turns every feature into the guard its module actually admits", () => {
    // The vocabulary and the requirement table are two hand-maintained lists that
    // have to agree, and this is where they are checked against each other: a
    // feature whose requirements entry is missing renders no guard at all, which
    // is a request that silently does nothing.
    //
    // `grpc` is the one feature that legitimately renders none. libuvcpp has no
    // `UVCPP_ENABLE_GRPC` and no `UVCPP_GRPC_ENABLE` — see
    // docs/libuvcpp-features.md — so there is no symbol for a guard to name, and
    // the only evidence that exists is whether the headers were installed. A
    // template cannot check that at compile time, and inventing a symbol would
    // produce a build that fails on a feature that is in fact present.
    const withGuard = UVP_FEATURES.filter((feature) => feature !== "grpc");
    const withoutGuard = UVP_FEATURES.filter((feature) => feature === "grpc");
    expect(withoutGuard).toEqual(["grpc"]);

    for (const feature of withGuard) {
      const source = render("hello-http", [feature]);
      expect(source, `${feature} produced no guard`).toContain("#if !UVCPP_");
      expect(manifest("hello-http", [feature])["features"]).toEqual([feature]);
    }

    for (const feature of withoutGuard) {
      expect(render("hello-http", [feature])).not.toContain("#if !UVCPP_");
      expect(manifest("hello-http", [feature])["features"]).toEqual([feature]);
    }
  });
});

describe("the routes `uvp init` reports", () => {
  it("names the one route of the smallest template", () => {
    // The first-run failure this table exists for: `hello-http` answers
    // `GET /hello`, and a natural first request to `GET /` gets a correct 404
    // from a working service.
    expect(templateRoutes("hello-http", [])).toEqual(["GET /hello"]);
  });

  it("reports the db feature's extra route, because the source gains it", () => {
    expect(templateRoutes("rest-api", [])).toEqual([
      "GET /healthz",
      "GET /items",
      "GET /items/:id",
    ]);
    expect(templateRoutes("rest-api", ["db"])).toEqual([
      "GET /healthz",
      "GET /items",
      "GET /items/:id",
      "POST /items/:id",
    ]);
    // The route and the registration move together: one without the other is a
    // caller told to ask a service for something it does not serve.
    expect(render("rest-api", [])).not.toContain('app.post("/items/:id"');
    expect(render("rest-api", ["db"])).toContain('app.post("/items/:id"');
  });

  it("names every registration in the rendered source, in both directions", () => {
    // `serve_static` is one call that registers four routes; the four entries in
    // the table are the four registrations, and this is the call behind them.
    const STATIC_ROUTES: ReadonlySet<string> = new Set([
      "GET /",
      "HEAD /",
      "GET /*path",
      "HEAD /*path",
    ]);
    const registrationOf = (route: string, template: TemplateId): string => {
      if (STATIC_ROUTES.has(route)) return 'app.serve_static("/", "./public")';
      const [method, path] = route.split(" ") as [string, string];
      const call = method === "WS" ? "websocket" : method.toLowerCase();
      // `http3-service` is written against `uvcpp_http_server`, so its routes are
      // registered on `server` rather than on a `uvcpp_web_app`.
      const receiver = template === "http3-service" ? "server" : "app";
      return `${receiver}.${call}("${path}"`;
    };
    // The registrations the source spells out itself. `serve_static` is the one
    // call that registers routes without naming them, so it is counted
    // separately; that is the only place this pair of checks is not mechanical.
    const explicitCalls = (source: string): readonly string[] =>
      [...source.matchAll(/(?:app|server)\.(?:get|post|websocket)\(/gu)].map((match) => match[0]);

    const variants: readonly (readonly [TemplateId, readonly UvpFeature[]])[] = [
      ...TEMPLATE_IDS.map((template): readonly [TemplateId, readonly UvpFeature[]] => [
        template,
        template === "http3-service" ? ["tls", "http3"] : [],
      ]),
      ["rest-api", ["db"]],
    ];

    for (const [template, features] of variants) {
      const source = render(template, features);
      const routes = templateRoutes(template, features);
      const registrations = new Set(routes.map((route) => registrationOf(route, template)));
      for (const registration of registrations) {
        expect(source, `${template} does not register ${registration}`).toContain(registration);
      }

      // The reverse direction: a registration in the source that the table omits
      // would tell the caller about fewer routes than the service answers. A
      // count catches that even when the extra route has no table entry to
      // search for.
      const tableCalls = routes.filter((route) => !STATIC_ROUTES.has(route)).length;
      expect(
        explicitCalls(source).length,
        `${template} registers a route the table does not name`,
      ).toBe(tableCalls);
      if (template === "static-files") {
        expect(source.match(/app\.serve_static\(/gu)?.length ?? 0).toBe(1);
      }
    }
  });
});
