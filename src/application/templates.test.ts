import { describe, expect, it } from "vitest";

import { TEMPLATE_IDS, renderTemplate } from "./templates.js";
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

/** Every template that starts a `uvcpp_web_app`, which is all of them today. */
const WEB_TEMPLATES: readonly TemplateId[] = TEMPLATE_IDS;

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
    expect(source).toContain("app.enable_ssl(cert_file, key_file);");
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
    expect(source.indexOf("app.enable_ssl(cert_file, key_file);")).toBeLessThan(started);
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
    expect(source.indexOf("if (cert_file != nullptr)")).toBeLessThan(
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

describe("requesting a feature no template can exercise", () => {
  it("records http3 in the manifest and writes no HTTP/3 code for it", () => {
    // Stated rather than left implicit, because the two are different facts and
    // the manifest is what a later `uvp doctor --workspace` reads. libuvcpp
    // 1.7.0's web layer has no HTTP/3 listener — `uvcpp_web_app` documents the
    // switch as arriving "when there is h3" — so what the feature buys today is
    // a build requirement and a compile-time guard, not a protocol.
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
