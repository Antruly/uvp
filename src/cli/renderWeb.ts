import { bytes, clip, millis, oneLine, row, table } from "./format.js";
import { at, bool, list, num, obj, str, strings, yesNo } from "./readOutput.js";

/**
 * Human renderings for the network primitives.
 *
 * Each of these prints content that came from the target host — a response body,
 * a frame payload, a SOAP fault — and every one of them says so. A terminal that
 * renders a remote server's text next to uvp's own verdict, with nothing marking
 * which is which, is how a response body ends up being read as an instruction.
 */

const CONTENT_WARNING = "the text below came from the target host";

/**
 * What `text_lossy` means, in words, for the two tools whose output carries it.
 *
 * Both sentences say whose doing the loss is, because that is the whole
 * distinction: a cap cutting a body in half is the caller's, and bytes that are
 * not UTF-8 are the peer's. A value a future contract adds prints as itself
 * rather than as nothing, which is the direction to be wrong in for a field whose
 * presence means "do not trust the text below".
 */
const LOSSY_TEXT: Record<string, string> = {
  truncated: "the byte cap cut a character in half, so the last one is not what the peer sent",
  "invalid-utf8": "the peer sent bytes that are not UTF-8, so this is not the response's text",
};

/**
 * What both renderers say when a lossy decode comes with its bytes.
 *
 * The bytes are base64 of the same buffer the text was decoded from, and printing
 * them here would put a blob under a body the tool has just decoded as text — and
 * double a reader's output for what is usually one bad byte in an otherwise
 * readable page. A reader who wants them can ask, so the line says how rather
 * than spending the terminal on them.
 */
const BYTES_ALSO = "the bytes it is not came with this answer as base64; --json prints them";

export const renderHttp = (output: Record<string, unknown>): string[] => {
  const request = obj(output["request"]);
  const body = obj(output["body"]);
  const timing = obj(output["timing"]);

  const lines = [
    row(
      "request",
      `${str(request["method"], "GET")} ${str(request["url"])} (${str(output["request_http_version"], "?")})`,
    ),
    row(
      "response",
      `${String(num(output["status"]) ?? 0)} ${str(output["status_text"])} (${str(output["http_version"], "?")})`,
    ),
    row("timing", timingLine(timing)),
  ];

  for (const [name, value] of Object.entries(obj(output["headers"]))) {
    lines.push(row("", `${name}: ${value}`));
  }

  for (const redirect of list(output["redirects"])) {
    lines.push(
      row(
        "redirect",
        `${String(num(at(redirect, "status")) ?? 0)} → ${str(at(redirect, "location"))}`,
      ),
    );
  }

  const tls = output["tls"];
  if (tls !== undefined && tls !== null) {
    // The four states are spelled out rather than folded into a yes/no. A
    // terminal that prints "verified: no" for a request the caller made with
    // --no-tls is telling them their service failed a check they had turned off,
    // which is the reading the boolean this replaced produced.
    const verification = str(at(tls, "verification"), "undetermined");
    lines.push(
      row(
        "tls",
        `${str(at(tls, "protocol"), "?")} ${str(at(tls, "cipher"), "")}  certificate: ${verification}`,
      ),
    );
    const reason = str(at(tls, "reason"));
    if (reason !== "") lines.push(row("", reason));
  }

  lines.push(
    row(
      "body",
      `${bytes(num(body["bytes"]) ?? 0)}, ${str(body["content_type"], "no content-type")}`,
    ),
  );
  if (bool(body["truncated"]) === true) {
    lines.push(row("", `truncated: only the first ${bytes(num(body["bytes"]) ?? 0)} were read`));
  }
  // The text below is what a reader will take at face value, so the one line that
  // says it is not the response's bytes goes above it rather than after 8000
  // characters of it. Absent is the ordinary case and prints nothing.
  const lossy = str(body["text_lossy"]);
  if (lossy !== "") lines.push(row("", `text is a lossy decode: ${LOSSY_TEXT[lossy] ?? lossy}`));

  const text = str(body["text"]);
  const base64 = str(body["base64"]);
  if (lossy !== "" && base64 !== "") lines.push(row("", BYTES_ALSO));
  if (text !== "") lines.push("", `# ${CONTENT_WARNING}`, clip(text, 8_000));
  // Only when there is no text: `base64` beside a text is the text's own bytes,
  // which `text_lossy` has already accounted for above.
  if (base64 !== "" && text === "")
    lines.push("", `# ${CONTENT_WARNING}, binary, base64:`, clip(base64, 2_000));

  return lines;
};

const timingLine = (timing: Record<string, unknown>): string => {
  const parts: string[] = [];
  const dns = num(timing["dns_ms"]);
  const connect = num(timing["connect_ms"]);
  const tls = num(timing["tls_ms"]);
  const ttfb = num(timing["ttfb_ms"]);
  if (dns !== undefined) parts.push(`dns ${millis(dns)}`);
  if (connect !== undefined) parts.push(`connect ${millis(connect)}`);
  if (tls !== undefined) parts.push(`tls ${millis(tls)}`);
  if (ttfb !== undefined) parts.push(`ttfb ${millis(ttfb)}`);
  parts.push(`total ${millis(num(timing["total_ms"]) ?? 0)}`);
  return parts.join(", ");
};

/**
 * The payload column of a frame row.
 *
 * A frame that carries no text says why rather than showing an empty cell: an
 * empty cell reads as "the peer sent nothing", which is a different observation
 * from "this stack would not hand the bytes over".
 */
const payloadCell = (frame: unknown): string => {
  const text = str(at(frame, "text"));
  if (text !== "") return oneLine(text, 60);
  const base64 = str(at(frame, "base64"));
  if (base64 !== "") return `${String(base64.length)} base64 bytes`;
  const omitted = str(at(frame, "text_omitted"));
  return omitted === "" ? "" : `[no text: ${omitted}]`;
};

export const renderWebSocket = (output: Record<string, unknown>): string[] => {
  const handshake = obj(output["handshake"]);
  const stack = str(output["stack"]);
  const lines = [
    // Only when it is not the default: a line that says "node" on every probe
    // would be the same line every time, and the interesting case is the other one.
    ...(stack === "" || stack === "node" ? [] : [row("stack", stack)]),
    // A stack that cannot see the response has no status to report. Printing 0
    // would be a status this probe never observed.
    ...(Object.keys(handshake).length === 0
      ? [row("handshake", "not observed by this stack")]
      : [
          row(
            "handshake",
            `${String(num(at(handshake, "status")) ?? 0)}${str(at(handshake, "negotiated_subprotocol")) === "" ? "" : `  subprotocol ${str(at(handshake, "negotiated_subprotocol"))}`}`,
          ),
        ]),
    row("upgraded", yesNo(output["upgraded"])),
  ];

  const frames = list(output["frames"]);
  if (frames.length > 0) {
    lines.push(
      "",
      table(
        ["dir", "opcode", "bytes", "at", "payload"],
        frames.map((frame) => [
          str(at(frame, "direction")),
          str(at(frame, "opcode")),
          String(num(at(frame, "bytes")) ?? 0),
          millis(num(at(frame, "at_ms")) ?? 0),
          payloadCell(frame),
        ]),
      ),
    );
    if (frames.some((frame) => str(at(frame, "text")) !== "")) {
      // The warning is a standalone sentence, so it is joined with a dash rather
      // than the copula: "frame payloads are the text below came from the target
      // host" is not a sentence, and a rendering whose own words are broken is
      // read as noise at exactly the moment it is being asked to be read.
      lines.push("", `# frame payloads — ${CONTENT_WARNING}`);
    }
  }

  lines.push(row("closed", yesNo(output["closed_cleanly"])));

  if (bool(output["abandoned"]) === true) {
    lines.push(
      "",
      "# The probe's own deadline ended this run and its client loop never returned, so whatever",
      "# the peer sent after the last frame above is unknown rather than absent.",
    );
  }
  const notObservable = list(output["not_observable"]).map((entry) => str(entry));
  if (notObservable.length > 0) {
    lines.push(
      "",
      `# ${stack === "" ? "this" : stack} stack cannot observe:`,
      ...notObservable.map((entry) => `#   - ${entry}`),
    );
  }
  return lines;
};

export const renderSoap = (output: Record<string, unknown>): string[] => {
  const lines = [
    row("outcome", str(output["outcome"])),
    row("response", `${String(num(output["status"]) ?? 0)} ${str(output["status_text"])}`),
    row("timing", `total ${millis(num(at(output["timing"], "total_ms")) ?? 0)}`),
  ];

  const fault = obj(output["fault"]);
  if (str(at(fault, "code")) !== "" || str(at(fault, "reason")) !== "") {
    lines.push(row("fault", `${str(at(fault, "code"), "-")} ${oneLine(str(at(fault, "reason")))}`));
    const detail = str(at(fault, "detail"));
    if (detail !== "") lines.push("", `# fault detail, ${CONTENT_WARNING}:`, clip(detail, 2_000));
  }

  const body = obj(output["body"]);
  const text = str(body["text"]);
  if (text !== "") lines.push("", `# response envelope, ${CONTENT_WARNING}:`, clip(text, 8_000));
  // Both caps — the cut `uvp_soap_call` makes at `max_body_bytes`, and the
  // transport's own read limit — are reported by `truncated`, which used to
  // say "the log is a prefix" here, a sentence about the log renderer copied into
  // the SOAP one.
  if (bool(body["truncated"]) === true)
    lines.push(row("truncated", "yes — only a prefix is shown"));
  const lossy = str(body["text_lossy"]);
  if (lossy !== "") lines.push(row("", `text is a lossy decode: ${LOSSY_TEXT[lossy] ?? lossy}`));
  if (lossy !== "" && str(body["base64"]) !== "") lines.push(row("", BYTES_ALSO));
  return lines;
};

export const renderLoad = (output: Record<string, unknown>): string[] => {
  const latency = obj(output["latency_ms"]);
  const lines = [
    row(
      "requests",
      `${String(num(output["requests_completed"]) ?? 0)}/${String(num(output["requests_sent"]) ?? 0)} completed, ` +
        `${String(num(output["requests_failed"]) ?? 0)} failed`,
    ),
    row(
      "throughput",
      `${(num(output["throughput_rps"]) ?? 0).toFixed(1)} req/s over ${millis(num(output["duration_ms"]) ?? 0)}`,
    ),
    row(
      "latency",
      ["min", "p50", "p90", "p95", "p99", "max", "mean", "stddev"]
        .map((key) => `${key} ${millis(num(latency[key]) ?? 0)}`)
        .join(", "),
    ),
    row(
      "ended by",
      bool(output["completed_by_count"]) === true ? "request count" : "the time budget",
    ),
  ];

  // The timings the row above was computed from. Printed as a count rather than
  // as a list: the JSON has them, and a terminal does not want ten thousand
  // numbers in it. What matters at a glance is whether any were dropped.
  const retained = num(output["samples_retained"]) ?? 0;
  const dropped = num(output["samples_dropped"]) ?? 0;
  lines.push(
    row(
      "samples",
      dropped === 0
        ? `${String(retained)} kept, one per completed request`
        : `${String(retained)} kept, ${String(dropped)} dropped by --max-samples — the numbers above describe the kept ones`,
    ),
  );

  const histogram = Object.entries(obj(output["status_histogram"]));
  if (histogram.length > 0) {
    lines.push(
      row("statuses", histogram.map(([status, count]) => `${status}:${String(count)}`).join("  ")),
    );
  }

  const errors = list(output["errors"]);
  if (errors.length > 0) {
    lines.push(
      "",
      table(
        ["error", "count", "sample"],
        errors.map((entry) => [
          str(at(entry, "kind")),
          String(num(at(entry, "count")) ?? 0),
          oneLine(str(at(entry, "sample")), 60),
        ]),
      ),
    );
  }
  return lines;
};

export const renderCaptureStart = (output: Record<string, unknown>): string[] => [
  row("capture", str(output["capture_id"])),
  row("proxy", `${str(output["proxy_url"])} → ${str(output["upstream"], "no upstream")}`),
  row("started", str(output["started_at"])),
  row(
    "bodies",
    `${bytes(num(output["max_body_bytes"]) ?? 0)} recorded per direction; forwarded whole regardless`,
  ),
  row("next", `uvp capture read --capture-id ${str(output["capture_id"])}`),
];

export const renderCaptureRead = (output: Record<string, unknown>): string[] => {
  const exchanges = list(output["exchanges"]);
  const limit = num(output["body_limit_bytes"]);
  const cut = num(output["bodies_truncated"]) ?? 0;
  const dropped = num(output["withheld_by_retention"]) ?? 0;
  const lines = [
    row("capture", `${str(output["capture_id"])}  running: ${yesNo(output["running"])}`),
    row(
      "recorded",
      `${String(num(output["total_recorded"]) ?? 0)} total, ${String(num(output["withheld_by_limit"]) ?? 0)} withheld by the read limit` +
        (dropped === 0 ? "" : `, ${String(dropped)} dropped by the session's retention caps`) +
        (cut === 0 ? "" : `, ${String(cut)} with a body cut at ${String(limit ?? 0)} bytes`),
    ),
  ];
  if (exchanges.length === 0) return [...lines, row("exchanges", "none matched")];

  // The byte counts are what was recorded, not what crossed the wire; a cut body
  // would otherwise print a number about the limit as if it were the payload's.
  const truncated = (entry: unknown): boolean =>
    bool(at(entry, "request_body_truncated")) === true ||
    bool(at(entry, "response_body_truncated")) === true;

  lines.push(
    "",
    table(
      ["method", "status", "ms", "bytes", "url"],
      exchanges.map((entry) => [
        str(at(entry, "method")),
        num(at(entry, "status")) === undefined ? "-" : String(num(at(entry, "status"))),
        String(num(at(entry, "duration_ms")) ?? 0),
        `${String(num(at(entry, "request_bytes")) ?? 0)}/${String(num(at(entry, "response_bytes")) ?? 0)}${truncated(entry) ? "*" : ""}`,
        oneLine(str(at(entry, "url")), 80),
      ]),
    ),
  );
  if (cut > 0) {
    lines.push(
      "",
      `* recorded bytes are a prefix: this session keeps ${String(limit ?? 0)} bytes per direction ` +
        "and forwards whole regardless",
    );
  }
  if (exchanges.some((entry) => str(at(entry, "error")) !== "")) {
    for (const entry of exchanges) {
      const error = str(at(entry, "error"));
      if (error !== "") lines.push(`  ${str(at(entry, "exchange_id"))}: ${error}`);
    }
  }
  if (exchanges.some((entry) => str(at(entry, "response_body")) !== "")) {
    lines.push("", `# payloads below — ${CONTENT_WARNING}`);
    for (const entry of exchanges) {
      const body = str(at(entry, "response_body"));
      if (body !== "")
        lines.push("", `${str(at(entry, "exchange_id"))} response:`, clip(body, 2_000));
    }
  }
  return lines;
};

export const renderCaptureReplay = (output: Record<string, unknown>): string[] => {
  const exchanges = list(output["exchanges"]);
  const outcome = str(output["outcome"], "unknown");
  const differed = num(output["differed"]) ?? 0;
  const skipped = num(output["skipped"]) ?? 0;
  const notComparable = num(output["not_comparable"]) ?? 0;
  const skippedMethods = strings(output["skipped_methods"]);

  // The verdict first, and the counts under it, because the one thing a caller
  // must not do is read a green-looking table as a pass. `unknown` says so in the
  // same place a `verified` would.
  const lines = [
    row("outcome", outcome),
    row(
      "replayed",
      `${String(num(output["matched"]) ?? 0)} matched, ${String(differed)} differ` +
        (skipped === 0 ? "" : `, ${String(skipped)} skipped`) +
        (notComparable === 0 ? "" : `, ${String(notComparable)} not comparable`),
    ),
    row("target", str(output["target"])),
    row("capture", `${str(output["capture_id"])}  running: ${yesNo(output["running"])}`),
  ];

  if (outcome === "unknown") {
    lines.push(
      row(
        "note",
        "nothing was compared, so this is not a pass — see the reasons below, or `uvp capture read`",
      ),
    );
  }

  if (exchanges.length === 0) return [...lines, row("exchanges", "none in the window")];

  lines.push(
    "",
    table(
      ["method", "outcome", "compared", "recorded", "observed", "url"],
      exchanges.map((entry) => [
        str(at(entry, "method")),
        str(at(entry, "outcome")),
        strings(at(entry, "compared")).join("+") || "-",
        num(at(entry, "recorded_status")) === undefined
          ? "-"
          : String(num(at(entry, "recorded_status"))),
        num(at(entry, "observed_status")) === undefined
          ? "-"
          : String(num(at(entry, "observed_status"))),
        oneLine(str(at(entry, "replayed_url")), 72),
      ]),
    ),
  );

  // Every exchange that named a reason, including the ones that matched on the
  // status alone: a `compared` column reading `status` is a shorter answer than a
  // caller asked for, and the reason is why.
  const reasoned = exchanges.filter((entry) => str(at(entry, "reason")) !== "");
  if (reasoned.length > 0) {
    lines.push("");
    for (const entry of reasoned) {
      lines.push(`  ${str(at(entry, "exchange_id"))}: ${str(at(entry, "reason"))}`);
    }
  }
  if (skipped > 0) {
    lines.push(
      "",
      `${String(skipped)} exchange(s) were not sent at all (${skippedMethods.join(", ")}): replaying a ` +
        "method that writes would write a second time. Use `uvp http` to put that request deliberately.",
    );
  }
  const withheld = num(output["withheld_by_limit"]) ?? 0;
  if (withheld > 0) {
    lines.push(
      `${String(withheld)} recorded exchange(s) were held back by the limit — a larger one covers them, ` +
        "because the window is taken oldest-first.",
    );
  }
  return lines;
};

export const renderAssert = (output: Record<string, unknown>): string[] => {
  const results = list(output["results"]);
  const lines = [
    row(
      "assertions",
      `${String(num(output["passed"]) ?? 0)} passed, ${String(num(output["failed"]) ?? 0)} failed over ${str(output["exchange_id"])}`,
    ),
  ];
  if (results.length === 0) return lines;
  lines.push(
    "",
    table(
      ["", "kind", "target", "observed", "expected"],
      results.map((entry) => [
        bool(at(entry, "passed")) === true ? "ok" : "FAILED",
        str(at(entry, "kind")),
        str(at(entry, "target"), "-"),
        oneLine(describe(at(entry, "observed")), 40),
        oneLine(describe(at(entry, "expected")), 40),
      ]),
    ),
  );
  for (const entry of results) {
    if (bool(at(entry, "passed")) !== true) lines.push(`  ${str(at(entry, "message"))}`);
  }
  return lines;
};

const describe = (value: unknown): string => {
  if (value === undefined) return "-";
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "-");
};

/** The `uvp_verify` bundle's own exchange table is rendered by the project renderer. */
export const webRenderers = {
  uvp_http_request: renderHttp,
  uvp_websocket_probe: renderWebSocket,
  uvp_soap_call: renderSoap,
  uvp_load_test: renderLoad,
  uvp_capture_start: renderCaptureStart,
  uvp_capture_read: renderCaptureRead,
  uvp_capture_replay: renderCaptureReplay,
  uvp_assert_exchange: renderAssert,
} as const;
