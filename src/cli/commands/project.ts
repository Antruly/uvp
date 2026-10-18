import {
  asBoolean,
  asList,
  asNumber,
  asString,
  flagError,
  parseHeaders,
  requirePositional,
} from "../args.js";
import type { ParsedArgv } from "../args.js";
import type { CommandSpec } from "../commandSpec.js";
import { EXIT_NO, EXIT_WRONG } from "../exitCodes.js";
import { parseAssertionList } from "../assertionSyntax.js";
import type { AssertionInput } from "../assertionSyntax.js";
import { bool, str } from "../readOutput.js";
import { TOOLCHAIN_KINDS, isToolchainKind } from "../../domain/toolchain.js";

/**
 * The build, run, stop, and verify commands.
 *
 * The exit codes here carry the most weight of anywhere in the CLI, because this
 * is where a script decides whether to keep going. Two of them are worth stating
 * outright:
 *
 *   - A compile failure is **exit 1, not an error**. The tool call succeeded; the
 *     compiler's answer was no, and the diagnostics on stdout are the result. A
 *     fix-and-retry loop reads them.
 *   - `uvp verify` exits 2 when the status is `unknown`. Nothing was evaluated —
 *     the service never came up — so a script that treats 1 as "the assertions
 *     failed" would misread a service that was never asked.
 */

const buildType = (parsed: ParsedArgv): string | undefined => asString(parsed, "build-type");
const generator = (parsed: ParsedArgv): string | undefined => asString(parsed, "generator");

/**
 * `--toolchain`, checked here rather than by the contract.
 *
 * The contract's refusal would name `toolchain` as a field of a JSON object the
 * caller never typed. It is the same reason `--http-version` is checked in this
 * file: a flag's error should be about the flag. The values come from the shared
 * vocabulary rather than a second literal list, so a kind added there cannot be
 * one this flag refuses to pass.
 */
const toolchainKind = (parsed: ParsedArgv): string | undefined => {
  const kind = asString(parsed, "toolchain");
  if (kind === undefined) return undefined;
  if (!isToolchainKind(kind)) {
    flagError(
      `--toolchain ${kind} is not a toolchain uvp has. Use ${TOOLCHAIN_KINDS.join(" or ")}.`,
    );
  }
  return kind;
};

/**
 * `--tls` / `--no-tls` for a verification pass.
 *
 * Local to this file rather than shared with the web commands, because the two
 * defaults are opposites and one description cannot honestly say both. There,
 * checking is the default and `--no-tls` is the exception; here, the pass is
 * about the service's behaviour and the workspaces uvp generates serve a
 * development certificate, so not checking is the default and `--tls` is the
 * exception. A shared flag saying "on by default" on a command where it is off
 * is worse than a duplicated literal: it is a flag whose own help text is false
 * about what the command will do.
 */
const verifyTlsFlag = {
  name: "tls",
  type: "boolean" as const,
  description:
    "Require the certificate to verify. Off by default; the certificate is reported either way.",
};

const sharedBuildFlags = [
  {
    name: "build-dir",
    type: "string" as const,
    value: "PATH",
    description: "Build directory. Defaults to <workspace>/build.",
  },
  {
    name: "build-type",
    type: "string" as const,
    value: "TYPE",
    description: "Debug, RelWithDebInfo, or Release. Default Debug.",
  },
  {
    name: "generator",
    type: "string" as const,
    value: "NAME",
    description: "ninja, unix-makefiles, or msbuild. Default: whatever CMake prefers.",
  },
];

export const bundleDiffCommand: CommandSpec = {
  path: ["bundle", "diff"],
  tool: "uvp_bundle_diff",
  summary: "Compare two verification reports and say what changed.",
  usage: "uvp bundle diff --before FILE --after FILE [--include-unchanged] [--json]",
  flags: [
    {
      name: "before",
      type: "string",
      value: "FILE",
      description: "Report of the earlier pass, as written by `uvp verify --json`.",
    },
    {
      name: "after",
      type: "string",
      value: "FILE",
      description: "Report of the later pass.",
    },
    {
      name: "include-unchanged",
      type: "boolean",
      description: "List every request both reports have, not only the ones that differ.",
    },
  ],
  notes: [
    "The reports are files, which is what `uvp verify --json > pass.json` leaves behind. Both are",
    "read whole or not at all: a file above uvp's limit is refused rather than truncated, so a",
    "comparison never rests on part of a report.",
    "",
    "Exit codes: 0 identical, 1 changed, 2 incomparable — two reports of different workspaces, or a",
    "digest that does not match the contents it arrived with. Incomparable exits 2 rather than 1",
    "because the question could not be put to these two reports at all.",
    "",
    "Identifiers and timings are never compared. They are minted per pass, so treating them as",
    "findings would report every pair of passes as changed.",
  ],
  input: (parsed) => {
    const before = asString(parsed, "before");
    const after = asString(parsed, "after");
    if (before === undefined || after === undefined) {
      flagError("uvp bundle diff needs both reports to compare.", {
        usage: "uvp bundle diff --before before.json --after after.json",
      });
    }
    return {
      before,
      after,
      ...optional("include_unchanged", asBoolean(parsed, "include-unchanged")),
    };
  },
  verdict: (output) =>
    str(output["outcome"]) === "incomparable"
      ? EXIT_WRONG
      : str(output["outcome"]) === "changed"
        ? EXIT_NO
        : undefined,
};

export const buildCommand: CommandSpec = {
  path: ["build"],
  tool: "uvp_build",
  summary: "Configure and compile a workspace with CMake.",
  usage:
    "uvp build PATH [--build-dir PATH] [--build-type TYPE] [--generator NAME] [--toolchain KIND] [--clean] [--json]",
  positionals: [{ name: "PATH", description: "Workspace directory." }],
  flags: [
    ...sharedBuildFlags,
    {
      name: "toolchain",
      type: "string",
      value: "KIND",
      description:
        "Where to build: local or container. Defaults to what uvp.json declares, and to this host " +
        "when it declares nothing. The image itself is named in uvp.json, never here.",
    },
    { name: "target", type: "string", value: "NAME", description: "Build one target." },
    { name: "clean", type: "boolean", description: "Discard the build directory first." },
    { name: "jobs", type: "number", value: "N", description: "Parallel compile jobs." },
    {
      name: "timeout",
      type: "number",
      value: "MS",
      description: "Overall build budget in milliseconds.",
    },
    {
      name: "configure-only",
      type: "boolean",
      description: "Run CMake's configure step and stop before compiling.",
    },
  ],
  notes: [
    "A compile failure exits 1 and prints the diagnostics. It is not an error: the tool call",
    "succeeded and the compiler's answer was no.",
  ],
  input: (parsed) => {
    const path = requirePositional(parsed, 0, "a workspace path", "uvp build ./svc");
    return {
      path,
      ...optional("build_dir", asString(parsed, "build-dir")),
      ...optional("build_type", buildType(parsed)),
      ...optional("generator", generator(parsed)),
      ...optional("toolchain", toolchainKind(parsed)),
      ...optional("target", asString(parsed, "target")),
      ...optional("jobs", asNumber(parsed, "jobs")),
      ...optional("timeout_ms", asNumber(parsed, "timeout")),
      ...optional("clean", asBoolean(parsed, "clean")),
      ...optional("configure_only", asBoolean(parsed, "configure-only")),
    };
  },
  verdict: (output) => (bool(output["succeeded"]) === true ? undefined : EXIT_NO),
};

export const frontendBuildCommand: CommandSpec = {
  path: ["frontend", "build"],
  tool: "uvp_frontend_build",
  summary: "Install and build a workspace's Node frontend app.",
  usage: "uvp frontend build PATH [--timeout MS] [--json]",
  positionals: [{ name: "PATH", description: "Workspace directory." }],
  flags: [
    {
      name: "timeout",
      type: "number",
      value: "MS",
      description: "Overall budget for `npm ci` and `npm run build` together. Default 600000.",
    },
  ],
  notes: [
    "This runs `npm ci` and `npm run build` in frontend/, so it starts processes and may",
    "fetch packages from the registry named in the committed lockfile.",
    "`uvp build` never runs it. The generated service starts without it and answers GET / with",
    "503 until frontend/dist/index.html exists.",
    "A failed step exits 1 and prints its output tail. It is not an error: the install or the",
    "framework's build answered no, and the output says why.",
  ],
  input: (parsed) => {
    const path = requirePositional(parsed, 0, "a workspace path", "uvp frontend build ./svc");
    return { path, ...optional("timeout_ms", asNumber(parsed, "timeout")) };
  },
  verdict: (output) =>
    bool(output["steps_succeeded"]) === true && bool(output["built"]) === true
      ? undefined
      : EXIT_NO,
};

export const runCommand: CommandSpec = {
  path: ["run"],
  tool: "uvp_run",
  summary: "Start a built service under uvp supervision.",
  usage:
    "uvp run PATH [--port PORT] [--ready-path PATH] [--timeout MS] [--binary NAME] [--arg VALUE] [--no-detach] [--json]",
  positionals: [{ name: "PATH", description: "Workspace directory." }],
  flags: [
    ...sharedBuildFlags.slice(0, 1),
    { name: "binary", type: "string", value: "PATH", description: "Binary to launch." },
    {
      name: "port",
      type: "number",
      value: "PORT",
      description: "Wait until this port answers before returning.",
    },
    {
      name: "ready-path",
      type: "string",
      value: "PATH",
      description: "Readiness path. Default /.",
    },
    {
      name: "timeout",
      type: "number",
      value: "MS",
      description: "Readiness timeout. Default 10000.",
    },
    {
      name: "arg",
      type: "list",
      value: "VALUE",
      description: "An argument for the service. Repeatable.",
    },
    {
      name: "env",
      type: "list",
      value: "K=V",
      description: "An environment variable. Repeatable.",
    },
    {
      name: "detach",
      type: "boolean",
      description: "Leave the process running after the call. Default on; use --no-detach to wait.",
    },
  ],
  notes: [
    "Without --port the call returns as soon as the process is spawned, and no readiness question",
    "is asked — the result says so in `unknowns` rather than reporting `ready: false` as a finding.",
    "With --no-detach the call stays in the foreground for as long as the service runs, and an",
    "interrupt stops that service before returning — the port is free when the call ends, and the",
    "exit code is 130 for SIGINT or 143 for SIGTERM.",
    "An interrupt before the readiness probe answers is a cancellation rather than a timeout: the",
    "call stops the service it just started instead of waiting out the timeout, and fails with",
    "`cancelled` rather than reporting `ready: false` about a service nobody was waiting for. That",
    "path exits 1 like every other `cancelled` failure — the signal numbers above belong to the",
    "foreground hold, which is this process staying alive on purpose.",
  ],
  input: (parsed) => {
    const path = requirePositional(parsed, 0, "a workspace path", "uvp run ./svc --port 8080");
    const port = asNumber(parsed, "port");
    const args = asList(parsed, "arg");
    const env = asList(parsed, "env");
    const detach = asBoolean(parsed, "detach");
    return {
      path,
      ...optional("build_dir", asString(parsed, "build-dir")),
      ...optional("binary", asString(parsed, "binary")),
      ...(args.length === 0 ? {} : { args }),
      ...(env.length === 0 ? {} : { env: parseEnv(env) }),
      ...(port === undefined
        ? {}
        : {
            ready: {
              port,
              ...optional("path", asString(parsed, "ready-path")),
              ...optional("timeout_ms", asNumber(parsed, "timeout")),
            },
          }),
      ...optional("detach", detach),
    };
  },
  verdict: (output, parsed) =>
    asNumber(parsed, "port") !== undefined && bool(output["ready"]) !== true ? EXIT_NO : undefined,
  // `--no-detach` is the one spelling whose lifetime this process holds, and the
  // result says which case it is: `detached: true` means uvp let go of the pipes
  // and is about to exit, while a service that never came up leaves nothing to
  // hold either. The run id is what the runner stops when the wait is
  // interrupted — the same registry `uvp stop` reads, so there is one owner of
  // the process and not two.
  heldRun: (output) =>
    bool(output["detached"]) === true || bool(output["still_running"]) !== true
      ? undefined
      : str(output["run_id"]) || undefined,
};

export const stopCommand: CommandSpec = {
  path: ["stop"],
  tool: "uvp_run_stop",
  summary: "Stop services this session started.",
  usage: "uvp stop [--run-id ID] [--all] [--grace MS] [--force] [--json]",
  flags: [
    { name: "run-id", type: "string", value: "ID", description: "Stop one run by its run_id." },
    { name: "all", type: "boolean", description: "Stop everything this session started." },
    { name: "grace", type: "number", value: "MS", description: "Grace period before escalating." },
    {
      name: "force",
      type: "boolean",
      description: "Escalate to a hard kill after the grace period.",
    },
  ],
  notes: [
    "It can signal only processes uvp started; it is not a general process killer. A run that was",
    "already gone reports `already_gone`, which is not the same as one that refused to die.",
  ],
  input: (parsed) => {
    const runId = asString(parsed, "run-id");
    const all = asBoolean(parsed, "all");
    if (runId === undefined && all !== true) {
      flagError("uvp stop needs either --run-id ID or --all.", {
        usage: "uvp stop --all",
      });
    }
    return {
      ...optional("run_id", runId),
      ...optional("all", all),
      ...optional("grace_ms", asNumber(parsed, "grace")),
      ...optional("force", asBoolean(parsed, "force")),
    };
  },
  verdict: (output) => (bool(output["cleanup_complete"]) === true ? undefined : EXIT_NO),
};

export const verifyCommand: CommandSpec = {
  path: ["verify"],
  tool: "uvp_verify",
  summary: "Build, run, exercise, assert, and report — in one supervised pass.",
  usage:
    "uvp verify PATH --port PORT --request METHOD PATH [--assert ASSERTION]… [--json]\n" +
    "           [--build-type TYPE] [--generator NAME] [--ready-path PATH] [--timeout MS]\n" +
    "           [--keep-running] [--goal TEXT] [--toolchain KIND] [--tls] [--no-tls]",
  positionals: [{ name: "PATH", description: "Workspace directory." }],
  flags: [
    ...sharedBuildFlags.slice(1),
    {
      name: "port",
      type: "number",
      value: "PORT",
      description: "Port the service will listen on.",
    },
    {
      name: "ready-path",
      type: "string",
      value: "PATH",
      description: "Readiness path. Default /.",
    },
    {
      name: "timeout",
      type: "number",
      value: "MS",
      description: "Readiness timeout. Default 10000.",
    },
    {
      name: "request",
      type: "pair",
      value: "METHOD PATH",
      description:
        "A request to issue. Repeatable; --header, --data, and --assert attach to the last one.",
    },
    {
      name: "header",
      type: "list",
      value: "NAME:VALUE",
      description: "A header for the last --request. Repeatable.",
    },
    {
      name: "data",
      type: "string",
      value: "BODY",
      description: "A request body for the last --request.",
    },
    {
      name: "http-version",
      type: "string",
      value: "VERSION",
      description:
        "The protocol version to attempt for the last --request: auto, 1.1, 2, or 3. " +
        "Default auto.",
    },
    {
      name: "assert",
      type: "list",
      value: "ASSERTION",
      description: "An assertion on the last --request. Repeatable.",
    },
    {
      name: "keep-running",
      type: "boolean",
      description: "Leave the service running afterwards, for interactive follow-up.",
    },
    {
      name: "goal",
      type: "string",
      value: "TEXT",
      description: "What this pass is meant to establish.",
    },
    {
      name: "toolchain",
      type: "string",
      value: "KIND",
      description:
        "Where to build. Defaults to what uvp.json declares. `local` checks a container-declared " +
        "workspace with this host's compilers; a pass cannot use a container, because it runs " +
        "what it builds.",
    },
    verifyTlsFlag,
  ],
  notes: [
    "The status is one of verified, partial, failed, or unknown. `partial` means some assertions were",
    "never evaluated — a run whose process died before the last check is partial even if everything",
    "that did run passed.",
    "",
    "Exit codes: 0 verified, 1 failed or partial, 2 unknown (nothing was evaluated, so uvp could not",
    "put the question to the service at all).",
    "",
    "",
    "--tls makes a certificate that does not verify fail the exchange and so the pass. Without it the",
    "certificate is still reported per exchange as tls_verification (and tls_reason, in OpenSSL's own",
    "spelling), which is how a pass can say what it saw without making it a verdict. Pass",
    "NODE_EXTRA_CA_CERTS=/path/to/ca.pem to trust the CA a workspace's certificate was issued by.",
    "",
    "Assertion syntax: status=200, status=2xx, json:$.path=value, header:name=value, body~=regex,",
    "latency<250ms, body_bytes<1024, header:name or json:$.path on their own to check that the field",
    "is present, or a JSON object for the full evaluator vocabulary. `uvp verify` does not support",
    "negated assertions; use `uvp assert` for those.",
  ],
  input: (parsed) => {
    const path = requirePositional(parsed, 0, "a workspace path", "uvp verify ./svc --port 8080 …");
    const port = asNumber(parsed, "port");
    if (port === undefined) {
      flagError("uvp verify needs --port so it knows where the service will listen.", {
        usage: "uvp verify ./svc --port 8080 --request GET /health",
      });
    }

    const requests = collectRequests(parsed);
    if (requests.length === 0) {
      flagError("uvp verify needs at least one --request.", {
        usage: "uvp verify ./svc --port 8080 --request GET /health --assert status=200",
      });
    }

    return {
      path,
      ...optional("build", buildSection(parsed)),
      run: {
        port,
        ...optional("ready_path", asString(parsed, "ready-path")),
        ...optional("timeout_ms", asNumber(parsed, "timeout")),
      },
      requests: requests.map((request) => ({
        name: request.name,
        method: request.method,
        path: request.path,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(request.httpVersion === undefined ? {} : { http_version: request.httpVersion }),
        assertions: request.assertions,
      })),
      ...optional("keep_running", asBoolean(parsed, "keep-running")),
      ...optional("goal", asString(parsed, "goal")),
      ...optional("toolchain", toolchainKind(parsed)),
      ...optional("verify_tls", asBoolean(parsed, "tls")),
    };
  },
  verdict: (output) => {
    const status = typeof output["status"] === "string" ? output["status"] : undefined;
    if (status === "verified") return undefined;
    return status === "unknown" ? EXIT_WRONG : EXIT_NO;
  },
};

interface RequestDraft {
  name: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
  httpVersion?: string;
  assertions: AssertionInput[];
}

/**
 * Group `--request`, `--header`, `--data`, `--http-version`, and `--assert` by
 * order of appearance.
 *
 * Order is the association. The alternative — requiring `--request` to carry a
 * name that the others repeat — is more explicit and much worse to type for the
 * common case of one request with two assertions.
 */
const collectRequests = (parsed: ParsedArgv): RequestDraft[] => {
  const requests: RequestDraft[] = [];

  for (const occurrence of parsed.occurrences) {
    if (occurrence.name === "request") {
      const [method, route] = occurrence.values;
      if (method === undefined || route === undefined) {
        flagError("--request takes a method and a path: --request GET /items/1");
      }
      requests.push({
        name: `${method.toUpperCase()} ${route}`,
        method: method.toUpperCase(),
        path: route,
        headers: {},
        assertions: [],
      });
      continue;
    }

    if (!["header", "data", "http-version", "assert"].includes(occurrence.name)) continue;

    const current = requests.at(-1);
    if (current === undefined) {
      flagError(`--${occurrence.name} must follow the --request it applies to.`);
    }
    if (occurrence.name === "data") {
      const body = occurrence.values[0];
      if (body !== undefined) current.body = body;
    } else if (occurrence.name === "http-version") {
      const version = occurrence.values[0]?.trim();
      // Refused here rather than by the contract, because the contract's message
      // would name `requests.2.http_version` — a path the caller never typed,
      // for a flag they did.
      if (version === undefined || !HTTP_VERSIONS.includes(version)) {
        flagError(
          `--http-version ${version ?? ""} is not a version uvp can attempt. Use auto, 1.1, 2, or 3.`,
        );
      }
      current.httpVersion = version;
    } else if (occurrence.name === "header") {
      Object.assign(current.headers, parseHeaders(occurrence.values));
    } else {
      for (const assertion of parseAssertionList(occurrence.values)) {
        if (assertion.negate === true) {
          flagError(
            "uvp verify does not support negated assertions: uvp_verify evaluates every assertion " +
              "affirmatively and refuses `negate`. Record the exchange and use `uvp assert` " +
              "against it instead.",
          );
        }
        current.assertions.push(assertion);
      }
    }
  }

  return requests;
};

/** The versions `uvp_http_request` takes, so `--http-version` refuses the same set. */
const HTTP_VERSIONS: readonly string[] = ["auto", "1.1", "2", "3"];

const buildSection = (parsed: ParsedArgv): Record<string, unknown> => {
  const type = buildType(parsed);
  const gen = generator(parsed);
  if (type === undefined && gen === undefined) return {};
  return {
    ...optional("build_type", type),
    ...optional("generator", gen),
  };
};

/** Include a field only when the caller supplied it, so contract defaults apply. */
const optional = (key: string, value: unknown): Record<string, unknown> =>
  value === undefined ? {} : { [key]: value };

const parseEnv = (entries: readonly string[]): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0) flagError(`"${entry}" is not K=V.`);
    env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return env;
};
