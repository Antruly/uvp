import { asBoolean, asList, asNumber, asString, parseCsv, requirePositional } from "../args.js";
import type { CommandSpec } from "../commandSpec.js";

/**
 * `uvp init`.
 *
 * Named `init` rather than the contract's `uvp_workspace_create` because that is
 * the word everyone types, and the CLI's job is to accept the words people use.
 * The mapping is declared here, once, and the test that every contract has
 * exactly one command is what keeps the friendlier name from becoming a second,
 * quietly different tool.
 *
 * It writes files and starts nothing. A scaffold that also built would take a
 * minute to tell you it could not, and would have written the files anyway.
 */
export const initCommand: CommandSpec = {
  path: ["init"],
  tool: "uvp_workspace_create",
  summary: "Scaffold a buildable libuvcpp C++ project.",
  usage:
    "uvp init PATH --name NAME [--template TEMPLATE] [--port PORT] [--features LIST] [--force] [--json]",
  positionals: [{ name: "PATH", description: "Directory to create the workspace in." }],
  flags: [
    { name: "name", type: "string", value: "NAME", description: "Project and CMake target name." },
    {
      name: "template",
      type: "string",
      value: "TEMPLATE",
      description:
        "hello-http, rest-api, websocket-echo, soap-service, static-files, or http3-service.",
    },
    {
      name: "port",
      type: "number",
      value: "PORT",
      description: "Default listen port for the service.",
    },
    {
      name: "features",
      type: "list",
      value: "LIST",
      description: "Comma-separated: tls, http2, http3, grpc, websocket, soap, db.",
    },
    {
      name: "force",
      type: "boolean",
      description: "Write into a directory that already contains files.",
    },
  ],
  notes: [
    "rest-api and websocket-echo need a libuvcpp built with UVCPP_BUILD_WEBAPP=ON. Run",
    "`uvp doctor` first: init does not check, and the generated code turns a missing module into",
    "one readable compile error rather than a cascade of failures inside libuvcpp's headers.",
    "http3-service needs --features tls,http3, and holds them: HTTP/3 runs on QUIC, which has no",
    "cleartext mode, so a request for it without a certificate is refused rather than downgraded.",
    "db is the one feature that changes what a template keeps: rest-api is written with libuvcpp's",
    "connection pool in place of its in-memory map, reading UVP_DATABASE_URL and defaulting to a",
    "SQLite file in the working directory. The other templates have no store to back, so there it",
    "is a build requirement and nothing more.",
  ],
  input: (parsed) => {
    const path = requirePositional(parsed, 0, "a workspace path", "uvp init ./svc --name svc");
    const name = asString(parsed, "name");
    const template = asString(parsed, "template");
    const port = asNumber(parsed, "port");
    const features = parseCsv(asList(parsed, "features"));
    const force = asBoolean(parsed, "force");
    return {
      path,
      // `--name` is not optional in practice, but the contract has no default for
      // it and refusing here would duplicate the contract's own "required" rule.
      // The name defaults to the directory's basename, which is what a caller who
      // typed only a path meant.
      ...(name === undefined ? { name: basename(path) } : { name }),
      ...(template === undefined ? {} : { template }),
      ...(port === undefined ? {} : { port }),
      ...(features.length === 0 ? {} : { features }),
      ...(force === undefined ? {} : { force }),
    };
  },
};

const basename = (path: string): string => {
  const trimmed = path.replace(/\/+$/u, "");
  const at = trimmed.lastIndexOf("/");
  const name = at === -1 ? trimmed : trimmed.slice(at + 1);
  return name === "" || name === "." ? "uvp-service" : name;
};
