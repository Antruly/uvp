import { describe, expect, it } from "vitest";

import { FEATURE_REQUIREMENTS, assessFeatures } from "./ToolchainProvider.js";
import type { HeaderProbe } from "./ToolchainProvider.js";
import { UVP_FEATURES } from "../domain/features.js";
import type { UvpFeature } from "../domain/features.js";

/**
 * The feature assessment is the answer to "will my service compile against this
 * libuvcpp?", and it is where the evidence model is most easily broken. A probe
 * that could not run must not be reported as an absence, and a switch that does
 * not exist must not be invented: either mistake sends the caller to rebuild a
 * library for a reason that is not true.
 */

/** Features decided by the generated config header, with the macros that decide them. */
const CONFIG_DECIDED: readonly (readonly [UvpFeature, readonly string[]])[] = [
  ["tls", ["UVCPP_OPENSSL_ENABLE"]],
  ["http2", ["UVCPP_NGHTTP2_ENABLE"]],
  ["http3", ["UVCPP_HTTP3_ENABLE", "UVCPP_QUIC_ENABLE", "UVCPP_WEB_ENABLE"]],
  ["websocket", ["UVCPP_WEB_ENABLE", "UVCPP_WEBAPP_ENABLE"]],
  ["soap", ["UVCPP_WEB_ENABLE", "UVCPP_WEBAPP_ENABLE"]],
  ["db", ["UVCPP_DB_ENABLE"]],
];

const probeAnswering =
  (answer: boolean | undefined): HeaderProbe =>
  async () =>
    answer;

describe("FEATURE_REQUIREMENTS", () => {
  it("has a requirement for every feature the vocabulary declares, and no others", () => {
    expect(Object.keys(FEATURE_REQUIREMENTS).sort()).toEqual([...UVP_FEATURES].sort());
  });

  it("names a header that is a relative path under the include root", () => {
    // An absolute or parent-relative header would be resolved against whatever
    // the process's cwd happened to be, so the probe would answer about a path
    // the caller never named.
    for (const feature of UVP_FEATURES) {
      const { header } = FEATURE_REQUIREMENTS[feature];
      expect(header.length, feature).toBeGreaterThan(0);
      expect(header.startsWith("/"), feature).toBe(false);
      expect(header.startsWith(".."), feature).toBe(false);
    }
  });

  it("gates the WebSocket server on both the web and webapp layers", () => {
    // The server lives in web and is routed in webapp. There is no
    // UVCPP_ENABLE_WEBSOCKET, so "tidying" this to a single switch would produce
    // a build that configures cleanly and then fails to install the headers.
    expect(FEATURE_REQUIREMENTS.websocket.cmakeOptions).toEqual([
      "UVCPP_BUILD_WEB",
      "UVCPP_BUILD_WEBAPP",
    ]);
    expect(FEATURE_REQUIREMENTS.websocket.configSymbols).toEqual([
      "UVCPP_WEB_ENABLE",
      "UVCPP_WEBAPP_ENABLE",
    ]);
  });

  it("gates SOAP on the same two layers, without requiring the WSDL module", () => {
    // SOAP is XML over the ordinary HTTP stack; the WSDL generator is not a
    // prerequisite for serving a hand-written envelope.
    expect(FEATURE_REQUIREMENTS.soap.cmakeOptions).toEqual([
      "UVCPP_BUILD_WEB",
      "UVCPP_BUILD_WEBAPP",
    ]);
  });

  it("gates HTTP/3 on QUIC and on the web layer, because each without the others is a header with nothing under it", () => {
    // QUIC for the transport — h3 is dialect-over-QUIC, and a build with the h3
    // headers and no QUIC under them cannot carry one byte.
    //
    // Web for the *server* half, which is the one that is easy to miss: h3's
    // client lives in `http3/` and installs its headers whatever else the build
    // did, while `uvcpp_http_server` — the only h3 listener libuvcpp has — is in
    // the web layer behind `#if UVCPP_WEB_ENABLE`. So a build with HTTP3 and QUIC
    // on and web off satisfies a two-symbol check and then offers nothing that
    // can accept a connection, which is a satisfied feature whose generated
    // workspace does not compile.
    expect(FEATURE_REQUIREMENTS.http3.cmakeOptions).toEqual([
      "UVCPP_ENABLE_HTTP3",
      "UVCPP_ENABLE_QUIC",
      "UVCPP_BUILD_WEB",
    ]);
    expect(FEATURE_REQUIREMENTS.http3.configSymbols).toEqual([
      "UVCPP_HTTP3_ENABLE",
      "UVCPP_QUIC_ENABLE",
      "UVCPP_WEB_ENABLE",
    ]);
  });

  it("gates HTTP/2 on the nghttp2 switch, which is the only way the module is built", () => {
    // The config symbol decides whether *this* install has http2; `cmakeOptions`
    // is what the gap record tells a caller to turn on to get one. Without the
    // switch the record says http2 is missing and names nothing to change, which
    // is an absence the caller cannot act on. Pin the whole row so the switch,
    // the symbol, and the header move together.
    expect(FEATURE_REQUIREMENTS.http2).toEqual({
      cmakeOptions: ["UVCPP_ENABLE_NGHTTP2"],
      configSymbols: ["UVCPP_NGHTTP2_ENABLE"],
      header: "http2/uvcpp_h2_common.h",
    });
  });

  it("gates db on its single switch, which is the whole requirement", () => {
    // db is the one feature whose requirement is a single switch and a single
    // symbol. There is no second layer to notice a mistake here, so the row is
    // pinned whole: a build that drops `UVCPP_ENABLE_DB` installs no db module,
    // and the gap record has to name that exact switch.
    expect(FEATURE_REQUIREMENTS.db).toEqual({
      cmakeOptions: ["UVCPP_ENABLE_DB"],
      configSymbols: ["UVCPP_DB_ENABLE"],
      header: "db",
    });
  });

  it("gives grpc no switches at all, because libuvcpp declares none", () => {
    // The empty list means "nothing to turn on", not "nothing needed": grpc is
    // decided by whether its header ships, which is why it takes the other path.
    expect(FEATURE_REQUIREMENTS.grpc.cmakeOptions).toEqual([]);
    expect(FEATURE_REQUIREMENTS.grpc.configSymbols).toEqual([]);
  });
});

describe("assessFeatures", () => {
  it("returns three empty buckets for an empty request", async () => {
    expect(await assessFeatures([], [])).toEqual({ satisfied: [], unmet: [], undetermined: [] });
  });

  it.each(CONFIG_DECIDED)(
    "satisfies %s when every config symbol it needs is defined",
    async (feature, symbols) => {
      const assessment = await assessFeatures([feature], symbols);
      expect(assessment.satisfied).toEqual([feature]);
      expect(assessment.unmet).toEqual([]);
      expect(assessment.undetermined).toEqual([]);
    },
  );

  it("reports an absent config symbol as a gap, with the switch that would have set it", async () => {
    const assessment = await assessFeatures(["tls"], []);
    expect(assessment.satisfied).toEqual([]);
    expect(assessment.unmet).toEqual([
      {
        feature: "tls",
        detection: "config_symbol",
        absentSymbols: ["UVCPP_OPENSSL_ENABLE"],
        cmakeOptions: ["UVCPP_ENABLE_OPENSSL"],
      },
    ]);
  });

  it("names only the symbols that are actually absent", async () => {
    // The caller is about to hand the missing switches to CMake. Listing a symbol
    // that is already defined would send them to reconfigure for no reason.
    const assessment = await assessFeatures(["http3"], ["UVCPP_HTTP3_ENABLE"]);
    expect(assessment.unmet).toHaveLength(1);
    expect(assessment.unmet[0]?.absentSymbols).toEqual(["UVCPP_QUIC_ENABLE", "UVCPP_WEB_ENABLE"]);
    expect(assessment.unmet[0]?.cmakeOptions).toEqual([
      "UVCPP_ENABLE_HTTP3",
      "UVCPP_ENABLE_QUIC",
      "UVCPP_BUILD_WEB",
    ]);
  });

  it("never consults the header probe for a feature a config symbol decides", async () => {
    // The config header is the stronger evidence; falling through to a header
    // probe would let an unreadable install downgrade a known-present module.
    const probed: string[] = [];
    const probe: HeaderProbe = async (header) => {
      probed.push(header);
      return false;
    };
    const assessment = await assessFeatures(["tls", "websocket"], ["UVCPP_OPENSSL_ENABLE"], probe);
    expect(probed).toEqual([]);
    expect(assessment.satisfied).toEqual(["tls"]);
    expect(assessment.unmet).toHaveLength(1);
  });

  it("assesses a feature that was requested twice exactly once", async () => {
    const assessment = await assessFeatures(["tls", "tls"], ["UVCPP_OPENSSL_ENABLE"]);
    expect(assessment.satisfied).toEqual(["tls"]);
  });

  it("orders the satisfied features by the request, not by the requirements table", async () => {
    // The table lists tls before db; a caller reading the answer beside its own
    // request should see the same order it asked in.
    const assessment = await assessFeatures(
      ["db", "tls"],
      ["UVCPP_DB_ENABLE", "UVCPP_OPENSSL_ENABLE"],
    );
    expect(assessment.satisfied).toEqual(["db", "tls"]);
  });

  describe("features libuvcpp has no switch for", () => {
    it("satisfies grpc when the header probe finds its header", async () => {
      const probed: string[] = [];
      const probe: HeaderProbe = async (header) => {
        probed.push(header);
        return true;
      };
      const assessment = await assessFeatures(["grpc"], [], probe);
      expect(assessment.satisfied).toEqual(["grpc"]);
      expect(probed).toEqual([FEATURE_REQUIREMENTS.grpc.header]);
    });

    it("reports grpc unmet when the probe looked and the header was not there", async () => {
      const assessment = await assessFeatures(["grpc"], [], probeAnswering(false));
      expect(assessment.satisfied).toEqual([]);
      expect(assessment.unmet).toEqual([
        { feature: "grpc", detection: "header", absentSymbols: [], cmakeOptions: [] },
      ]);
      expect(assessment.undetermined).toEqual([]);
    });

    it("reports grpc undetermined, never unmet, when the probe could not tell", async () => {
      // The single most important outcome in this file. `undefined` means "I
      // could not look", which is not the same finding as "I looked and it was
      // absent". Folding it into `unmet` would tell the caller to rebuild a
      // library for a reason nobody established.
      const assessment = await assessFeatures(["grpc"], [], probeAnswering(undefined));
      expect(assessment.unmet).toEqual([]);
      expect(assessment.satisfied).toEqual([]);
      expect(assessment.undetermined).toEqual([
        {
          feature: "grpc",
          reason:
            "libuvcpp has no configuration switch for grpc, and grpc could not be inspected under the install root.",
        },
      ]);
    });

    it("reports grpc undetermined when no probe was supplied at all", async () => {
      // An install uvp does not know how to read is the same third state as an
      // unreadable one. The absence of a probe is a limit on uvp, not on libuvcpp.
      //
      // The reason is pinned exactly, because it is the only thing that tells a
      // caller *which* third state this is: no probe existed to run, as against
      // a probe that ran and could not answer. The two sentences below differ in
      // exactly that clause, and a caller that gets the wrong one goes looking
      // for a broken install instead of supplying the probe it forgot.
      const assessment = await assessFeatures(["grpc"], []);
      expect(assessment.unmet).toEqual([]);
      expect(assessment.satisfied).toEqual([]);
      expect(assessment.undetermined).toEqual([
        {
          feature: "grpc",
          reason:
            "libuvcpp has no configuration switch for grpc, and no header probe was supplied to check for grpc.",
        },
      ]);
    });
  });

  it("keeps undetermined disjoint from satisfied and unmet in the same answer", async () => {
    // A caller partitions on the bucket a feature lands in, so a feature must be
    // in exactly one of them.
    const assessment = await assessFeatures(["grpc", "tls", "http2"], ["UVCPP_OPENSSL_ENABLE"]);
    expect(assessment.satisfied).toEqual(["tls"]);
    expect(assessment.unmet.map((gap) => gap.feature)).toEqual(["http2"]);
    expect(assessment.undetermined.map((entry) => entry.feature)).toEqual(["grpc"]);

    const placed = [
      ...assessment.satisfied,
      ...assessment.unmet.map((gap) => gap.feature),
      ...assessment.undetermined.map((entry) => entry.feature),
    ];
    expect(new Set(placed).size).toBe(placed.length);
  });
});
