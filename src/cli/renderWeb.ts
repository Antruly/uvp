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
    const verified = bool(at(tls, "verified"));
    lines.push(
      row(
        "tls",
        `${str(at(tls, "protocol"), "?")} ${str(at(tls, "cipher"), "")}  verified: ${yesNo(verified)}`,
      ),
    );
    for (const error of strings(at(tls, "errors"))) lines.push(row("", error));
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

  const text = str(body["text"]);
  if (text !== "") lines.push("", `# ${CONTENT_WARNING}`, clip(text, 8_000));
  const base64 = str(body["base64"]);
  if (base64 !== "") lines.push("", `# ${CONTENT_WARNING}, binary, base64:`, clip(base64, 2_000));

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

export const renderWebSocket = (output: Record<string, unknown>): string[] => {
  const handshake = obj(output["handshake"]);
  const lines = [
    row(
      "handshake",
      `${String(num(at(handshake, "status")) ?? 0)}${str(at(handshake, "negotiated_subprotocol")) === "" ? "" : `  subprotocol ${str(at(handshake, "negotiated_subprotocol"))}`}`,
    ),
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
          str(at(frame, "text")) === "" ? "" : oneLine(str(at(frame, "text")), 60),
        ]),
      ),
    );
    if (frames.some((frame) => str(at(frame, "text")) !== "")) {
      lines.push("", `# frame payloads are ${CONTENT_WARNING}`);
    }
  }

  lines.push(row("closed", yesNo(output["closed_cleanly"])));
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
  if (bool(body["truncated"]) === true) lines.push(row("truncated", "yes — the log is a prefix"));
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
  row("next", `uvp capture read --capture-id ${str(output["capture_id"])}`),
];

export const renderCaptureRead = (output: Record<string, unknown>): string[] => {
  const exchanges = list(output["exchanges"]);
  const lines = [
    row("capture", `${str(output["capture_id"])}  running: ${yesNo(output["running"])}`),
    row(
      "recorded",
      `${String(num(output["total_recorded"]) ?? 0)} total, ${String(num(output["withheld_by_limit"]) ?? 0)} withheld by the read limit`,
    ),
  ];
  if (exchanges.length === 0) return [...lines, row("exchanges", "none matched")];

  lines.push(
    "",
    table(
      ["method", "status", "ms", "bytes", "url"],
      exchanges.map((entry) => [
        str(at(entry, "method")),
        num(at(entry, "status")) === undefined ? "-" : String(num(at(entry, "status"))),
        String(num(at(entry, "duration_ms")) ?? 0),
        `${String(num(at(entry, "request_bytes")) ?? 0)}/${String(num(at(entry, "response_bytes")) ?? 0)}`,
        oneLine(str(at(entry, "url")), 80),
      ]),
    ),
  );
  if (exchanges.some((entry) => str(at(entry, "error")) !== "")) {
    for (const entry of exchanges) {
      const error = str(at(entry, "error"));
      if (error !== "") lines.push(`  ${str(at(entry, "exchange_id"))}: ${error}`);
    }
  }
  if (exchanges.some((entry) => str(at(entry, "response_body")) !== "")) {
    lines.push("", `# payloads below are ${CONTENT_WARNING}`);
    for (const entry of exchanges) {
      const body = str(at(entry, "response_body"));
      if (body !== "")
        lines.push("", `${str(at(entry, "exchange_id"))} response:`, clip(body, 2_000));
    }
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
  uvp_assert_exchange: renderAssert,
} as const;
