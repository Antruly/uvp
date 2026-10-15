import { afterAll, describe, expect, it } from "vitest";

import { EXIT_OK, EXIT_WRONG } from "../../src/cli/exitCodes.js";
import { NativeProbeRunner } from "../../src/toolchains/native/NativeProbeRunner.js";
import {
  buildWorkspace,
  cleanup,
  createWorkspace,
  realLibuvcpp,
  resultOrThrow,
  runCli,
  skipReason,
  startService,
} from "../support/realLibuvcpp.js";

/**
 * The native probe, end to end: a real probe binary, built against a real
 * libuvcpp, probing a service uvp generated and a real CMake built.
 *
 * This is the lane the whole native branch exists for. Everything else about it
 * can be proved with an injected process — that the request is what the probe
 * expects, that a refusal becomes the right failure, that a report maps to the
 * right output — and none of that establishes the one claim worth making: that
 * libuvcpp's *own* WebSocket client can talk to a libuvcpp service uvp generated.
 * Two clients that both claim RFC 6455 can disagree about everything the RFC
 * leaves open, so a Node client reaching `websocket-echo` says nothing about this
 * question, and only this lane can answer it.
 *
 * **What is real, and what is not.** The probe is the binary `npm run
 * build:native-probe` produced; the service is a generated workspace built by the
 * CMake on this host; the wire is a real loopback socket. What is *not* tested
 * here is a browser, a proxy, or TLS: the C ABI's client does not do `wss://`, and
 * the refusal of that is asserted in the conformance lane where it costs nothing.
 *
 * **The probe is not built by this lane.** A missing binary is a fact about the
 * host, so this file skips and says so — building here would make a test run
 * depend on a C++ compiler and a libuvcpp with `UVCPP_ENABLE_CAPI=ON`, which is
 * the same condition `UVP_NATIVE_PROBE` exists to route around. CI builds it
 * before this lane runs, and a developer runs `npm run build:native-probe`.
 *
 * **Where the probe is, is the runner's answer.** The path and the skip reason
 * both come from `NativeProbeRunner.availability` — the module that will be doing
 * the locating when the CLI runs — rather than from a second search order written
 * here. A helper that looked in its own order could skip a lane that would have
 * worked, or pass a path the runner would have rejected, and either way the two
 * would disagree about a host neither of them described.
 */

/**
 * The port `websocket-echo` is generated with.
 *
 * The same number the reference table's row uses, because it is the same
 * template — and the `toolchain` project runs its files serially
 * (`fileParallelism: false`), so the two tests never hold it at once. A number
 * invented for this file would be a second fact about the same service.
 */
const PORT = 8092;

/** The CLI's own view: where the probe is, or why it could not be located. */
const availability = await new NativeProbeRunner().availability(new AbortController().signal);

const probeReason =
  availability.state === "available" ? "" : `${availability.state}: ${availability.reason}`;

/**
 * Why this file is skipped, or `""` to run it.
 *
 * Both conditions are named separately: "no libuvcpp" and "no probe binary" are
 * different problems with different fixes, and a lane that reported the first
 * when the second was true would send a reader to the wrong file.
 */
const guard =
  realLibuvcpp === undefined
    ? skipReason
    : availability.state === "available"
      ? ""
      : `the native probe could not be located (${probeReason}) — build it with \`npm run build:native-probe\` against a libuvcpp installed with UVCPP_ENABLE_CAPI=ON`;

/** The located binary, as a value. `describe.skipIf` is not a narrowing TS can see. */
const probe = (): string => {
  if (availability.state !== "available")
    throw new Error("unreachable: this file is skipped without a probe");
  return availability.path;
};

/** A build failure, quoted, so the reader has the compiler's own words. */
const why = (result: Record<string, unknown>): string =>
  JSON.stringify(result["diagnostics"] ?? result).slice(0, 2_000);

/** The frame log, as the output carries it. */
const framesOf = (result: Record<string, unknown>): { direction: string; text?: string }[] =>
  (result["frames"] ?? []) as { direction: string; text?: string }[];

/**
 * The arguments every probe in this file is run with: `hello` sent to the
 * generated echo service through libuvcpp's own client, with a deadline short
 * enough that the run ends at it.
 *
 * One place, because the assertions below are about *this* request — the frames
 * it produced, the expectation it answers, the rendering a person reads. A
 * second copy of the argument list would be a second request, and a test that
 * kept passing against it would be describing a run nobody made.
 */
const probeArgs = (...extra: readonly string[]): string[] => [
  "ws",
  `ws://127.0.0.1:${String(PORT)}/echo`,
  "--send",
  "hello",
  "--stack",
  "libuvcpp",
  "--max-frames",
  "2",
  "--idle-timeout",
  "1500",
  ...extra,
];

/**
 * The port `http3-service` is generated with.
 *
 * The same number the reference table's row uses, for the same reason `PORT` is:
 * it is the same template, and the two files never hold it at once.
 */
const HTTP3_PORT = 8095;

/** Generate, build, and start `websocket-echo`, the way a person would. */
const served = async () => {
  const workspace = await createWorkspace("websocket-echo", PORT);
  const result = resultOrThrow(await buildWorkspace(workspace));
  expect(result["succeeded"], `websocket-echo failed to build: ${why(result)}`).toBe(true);
  return await startService(workspace);
};

/**
 * The same, for `http3-service`, which has to be asked for its features.
 *
 * `tls` and `http3` are required rather than merely allowed — a QUIC service
 * without a certificate is not an h3 service — so a workspace generated without
 * them is one `uvp init` refuses to produce. The lane generates what a person
 * would have to generate.
 */
const servedOverQuic = async () => {
  const workspace = await createWorkspace("http3-service", HTTP3_PORT, ["tls", "http3"]);
  const result = resultOrThrow(await buildWorkspace(workspace));
  expect(result["succeeded"], `http3-service failed to build: ${why(result)}`).toBe(true);
  return await startService(workspace);
};

/**
 * The lane's second claim, and the one no other lane can make.
 *
 * Node has no HTTP/3 client, so `uvp http --http-version 3` is answered by the
 * probe — libuvcpp's own QUIC and h3 client, the same implementation the generated
 * service serves with. A client and a server from one project can still disagree
 * about the spec, so what this establishes is not "HTTP/3 works" but "these two
 * agree", which is the only form of the claim uvp is in a position to test.
 *
 * Named here rather than written inline in the `describe` below because the
 * lane's per-function budget is an error at 150 lines and this body plus the
 * three before it crosses it. It is a claim with a name, which is what it should
 * have been anyway.
 */
const overQuic = async (): Promise<void> => {
  const service = await servedOverQuic();
  try {
    const outcome = await runCli(
      [
        "http",
        `https://127.0.0.1:${String(HTTP3_PORT)}/hello`,
        "--http-version",
        "3",
        // The certificate is the template's own self-signed one, and the QUIC
        // client verifies only against a CA bundle it is handed — which this tool
        // has no input for. With verification left on the request is refused
        // before anything is spawned, which is the refusal the source lane pins;
        // here it is turned off, and the result is required to say so rather than
        // to stay silent.
        "--no-tls",
        "--json",
      ],
      { env: { UVP_NATIVE_PROBE: probe() } },
    );
    expect(outcome.exit, outcome.stderr).toBe(EXIT_OK);
    const result = resultOrThrow(outcome);

    // The transport, which is the whole point: `3` here is the version *used*,
    // not the one requested. A path that quietly sent HTTP/1.1 instead — over the
    // template's TCP leg, which would answer just as happily — would make the flag
    // a claim about a transport it never touched, and this assertion is what
    // catches it.
    expect(result["http_version"]).toBe("3");
    expect(result["request_http_version"]).toBe("3");
    expect(result["status"]).toBe(200);
    // HTTP/3 dropped the reason phrase, so there is no text to report and a
    // synthesised "OK" would be a string this stack never sent.
    expect(result["status_text"]).toBe("");

    const body = result["body"] as { text?: unknown };
    expect(body.text).toBe("hello over HTTP/3");

    // The certificate, in the four-state vocabulary rather than a yes. The request
    // was made without a CA bundle because that is the only way this layer can
    // make one, so nothing was examined and the result says `not_checked` — not
    // `verified`.
    const tls = result["tls"] as { verification?: unknown; reason?: unknown };
    expect(tls.verification).toBe("not_checked");
    expect(String(tls.reason)).toMatch(/[Nn]o certificate was examined/u);

    // The headers that were read, named, and the ones that were not, declared.
    // The C ABI reads one response header at a time and has no call that lists
    // them, so a full set is not something this path can honestly report — and a
    // reader who looks at the headers alone has no way to tell. Both places the
    // exchange states it are asserted here: the coverage, which names the headers
    // that went unread, and the limitation beside it, which says what that means.
    const evidence = result["evidence"] as {
      coverage?: { status?: unknown; note?: unknown };
      limitations?: unknown;
    }[];
    expect(evidence[0]?.coverage?.status).toBe("partial");
    expect(String(evidence[0]?.coverage?.note)).toMatch(/response headers/u);
    expect(
      (evidence[0]?.limitations as readonly string[] | undefined)?.some((line) =>
        /not looked at rather than absent/u.test(line),
      ),
      JSON.stringify(evidence[0]?.limitations),
    ).toBe(true);

    // The control: the same service, the same route, over its TCP leg. Without
    // this the assertions above would be satisfied by any exchange that happened
    // to return that body — the h3 half of the claim is that HTTP/3 carried *this*
    // response from *this* route table.
    const overTcp = resultOrThrow(
      await runCli([
        "http",
        `https://127.0.0.1:${String(HTTP3_PORT)}/hello`,
        "--http-version",
        "1.1",
        "--no-tls",
        "--json",
      ]),
    );
    expect(overTcp["http_version"]).toBe("1.1");
    expect(overTcp["status"]).toBe(200);
    expect((overTcp["body"] as { text?: unknown }).text).toBe(body.text);
  } finally {
    await service.stop();
  }
};

afterAll(() => {
  cleanup();
});

describe.skipIf(guard !== "")(
  guard === ""
    ? "the native probe, against a generated service"
    : `the native probe — skipped: ${guard}`,
  () => {
    /**
     * How long one of these may take.
     *
     * The lane's default is the cold-cache figure for a *single* template build,
     * and this file pays for a build and two probes. Bounded rather than
     * unlimited, and generous rather than tight: a deadline that fires during a
     * compile reads as "uvp hung" when the machine was merely busy.
     */
    const TIMEOUT = 180_000;

    it(
      "probes a generated service with libuvcpp's own client stack",
      async () => {
        const service = await served();
        try {
          const outcome = await runCli(probeArgs("--expect-frame", "hello", "--json"), {
            env: { UVP_NATIVE_PROBE: probe() },
          });
          expect(outcome.exit, outcome.stderr).toBe(EXIT_OK);
          const result = resultOrThrow(outcome);

          // The stack is named in the output, because which client made an
          // observation is part of the observation: a caller reading `upgraded`
          // needs to know that libuvcpp's client, and not Node's, saw it.
          expect(result["stack"]).toBe("libuvcpp");
          expect(result["upgraded"]).toBe(true);

          // The absences, asserted as absences. The C ABI does not expose the
          // upgrade response, so a `handshake` object here — even one carrying
          // what a 101 usually looks like — would be a value nobody observed.
          expect("handshake" in result).toBe(false);
          expect(result["not_observable"]).toContain(
            "the upgrade response's status line and headers",
          );

          // The exchange itself. Both directions, so "the frame came back" cannot
          // be satisfied by the frame the client sent.
          const frames = framesOf(result);
          expect(frames.filter((frame) => frame.direction === "sent").map((f) => f.text)).toEqual([
            "hello",
          ]);
          expect(
            frames.filter((frame) => frame.direction === "received").map((f) => f.text),
          ).toContain("hello");

          // An expectation is answered by uvp and not by the probe, on this stack
          // as on the other one. The index names the frame that answered, and it
          // has to be a frame the peer sent — matching a frame uvp itself sent
          // would pass this expectation against a service that never replied.
          expect(result["expectations_met"]).toBe(true);
          const expectations = result["expectations"] as {
            text: string;
            matched: boolean;
            matched_frame_index?: number;
          }[];
          expect(expectations).toEqual([
            { text: "hello", matched: true, matched_frame_index: expect.any(Number) },
          ]);
          const answered = frames[expectations[0]?.matched_frame_index ?? -1];
          expect(answered?.direction).toBe("received");

          // The blind spots are stated, in both places a caller might look: the
          // envelope points at `not_observable`, and the evidence record says in
          // words that the handshake half of the report is missing. A caller who
          // reads only `upgraded: true` and never opens either would be reading a
          // thinner observation than this one is.
          expect((result["limitations"] as string[]).join(" ")).toContain("not_observable");
          const evidence = result["evidence"] as { limitations?: string[] }[];
          expect((evidence[0]?.limitations ?? []).join(" ")).toMatch(/handshake/iu);
        } finally {
          await service.stop();
        }
      },
      TIMEOUT,
    );

    it(
      "renders the same run for a person, absences included",
      async () => {
        // A second pass over the same stack, without `--json`, because the human
        // rendering is where a result is most likely to say something the JSON
        // does not: it is written by hand, it drops fields on purpose, and this
        // stack is the one whose answer is partly made of absences. A rendering
        // that quietly printed `handshake 0` — or omitted the note explaining
        // why the frame log stops where it does — would leave a person reading a
        // thinner observation than the machine got, with nothing to say so.
        const service = await served();
        try {
          // No `--json`: this is the rendering a person reads.
          const outcome = await runCli(probeArgs(), {
            env: { UVP_NATIVE_PROBE: probe() },
          });
          expect(outcome.exit, outcome.stderr).toBe(EXIT_OK);
          const text = outcome.stdout;

          // Which client made the observation. Printed only when it is not the
          // default, so this line is itself evidence that the default is not
          // being dressed up as a finding.
          expect(text).toMatch(/^stack\s+libuvcpp$/mu);
          // The absence, in words rather than as the `0` that a reader would
          // take for a status this probe observed.
          expect(text).toMatch(/^handshake\s+not observed by this stack$/mu);
          expect(text).toMatch(/^upgraded\s+yes$/mu);

          // The exchange, in both directions: `hello` is in the log twice, and
          // the rendering cannot pass this by printing only the frame uvp wrote.
          expect(text).toMatch(/^sent\s+text\b/mu);
          expect(text).toMatch(/^received\s+text\b/mu);
          // The payload warning, which is uvp's own words about text that came
          // from the target host, and has to be a sentence to be read.
          expect(text).toMatch(/^# frame payloads — the text below came from the target host$/mu);

          // Why the run ended where it did. Without this the frame log reads as a
          // quiet ending, which is the one reading `abandoned` exists to prevent.
          expect(text).toMatch(/^# .*\bdeadline\b.*$/mu);
          expect(text).toMatch(/^# .*unknown rather than absent\.$/mu);
          // And the blind spots, listed rather than left to be inferred from a
          // missing line above.
          expect(text).toMatch(/^#\s+libuvcpp stack cannot observe:$/mu);
          expect(text).toContain("the upgrade response's status line and headers");

          // The envelope's own record of the gap: the question this run left
          // open, with what blocked it — the part a person skimming to the end
          // would otherwise walk away without.
          expect(text).toContain(
            "What did the far end send after the probe's last recorded frame?",
          );
          expect(text).toMatch(/^unknowns\s+1 unanswered$/mu);
        } finally {
          await service.stop();
        }
      },
      TIMEOUT,
    );

    it(
      "reports an expectation the service did not answer, and exits 1",
      async () => {
        // The positive control for the test above. An `expectations_met: true`
        // that a matcher produced by matching anything would satisfy is worth
        // nothing, so the same call is made with text the service does not send:
        // the exit code changes, the frame log still shows the echo, and the
        // caller is left with the evidence for why the answer was no.
        const service = await served();
        try {
          const outcome = await runCli(probeArgs("--expect-frame", "never-spoken", "--json"), {
            env: { UVP_NATIVE_PROBE: probe() },
          });
          // 1, not 2: the probe ran and the answer is no. A caller that retried on
          // this would be retrying a question the far end already answered.
          expect(outcome.exit).toBe(1);
          const result = resultOrThrow(outcome);
          expect(result["upgraded"]).toBe(true);
          expect(result["expectations_met"]).toBe(false);
          expect(
            framesOf(result)
              .filter((frame) => frame.direction === "received")
              .map((frame) => frame.text),
          ).toContain("hello");
        } finally {
          await service.stop();
        }
      },
      TIMEOUT,
    );

    it(
      "completes an HTTP/3 exchange with a generated service, both legs answering alike",
      overQuic,
      // Larger than the file's default: this test pays for a template build that
      // compiles TLS, the QUIC stack and the h3 route table — several times the
      // headers of the WebSocket template — plus a QUIC handshake and a probe
      // start on top of it.
      300_000,
    );

    it(
      "refuses what this stack cannot do before anything is probed",
      async () => {
        // Nothing is listening on this port and nothing needs to be: the refusal
        // happens in uvp, before the probe process exists. That is the point — a
        // request carrying headers the C ABI cannot send must fail as a refusal
        // rather than as a probe of a *different* request that quietly dropped them.
        const outcome = await runCli(
          [
            "ws",
            "ws://127.0.0.1:9/echo",
            "--stack",
            "libuvcpp",
            "--header",
            "X-Trace: 1",
            "--json",
          ],
          { env: { UVP_NATIVE_PROBE: probe() } },
        );
        // 2: the question could not be put to the service at all. Whether it is
        // listening was never asked.
        expect(outcome.exit).toBe(EXIT_WRONG);
        expect(`${outcome.stdout}${outcome.stderr}`).toMatch(/request headers/iu);
      },
      TIMEOUT,
    );
  },
);
