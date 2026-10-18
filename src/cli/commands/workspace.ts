import { basename } from "node:path";

import {
  asBoolean,
  asList,
  asNumber,
  asString,
  flagError,
  parseCsv,
  requirePositional,
} from "../args.js";
import type { CommandSpec } from "../commandSpec.js";
import { workspaceNameProblem } from "../../domain/workspaceName.js";

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
        "hello-http, rest-api, websocket-echo, websocket-test, soap-service, static-files, or " +
        "http3-service.",
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
    "rest-api, websocket-echo, and websocket-test need a libuvcpp built with UVCPP_BUILD_WEBAPP=ON. Run",
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
    // `--name` is not optional in practice, but the contract has no default for
    // it. The name defaults to the directory's basename, which is what a caller
    // who typed only a path meant — read with `node:path` so that a Windows
    // path is a path on Windows rather than one string with backslashes in it.
    //
    // A derived name that cannot be a CMake target is refused here rather than
    // sent to the contract: the caller did not choose it, and the remedy that
    // works is on this command line (`--name`), not in a schema error.
    const derivedName = name === undefined ? defaultWorkspaceName(path) : undefined;
    if (derivedName !== undefined) {
      const problem = workspaceNameProblem(derivedName);
      if (problem !== undefined) {
        flagError(
          `Cannot derive a workspace name from "${path}": it yields "${derivedName}". ${problem}`,
          { usage: "uvp init PATH --name NAME", name: derivedName },
        );
      }
    }
    return {
      path,
      ...(derivedName === undefined ? { name } : { name: derivedName }),
      ...(template === undefined ? {} : { template }),
      ...(port === undefined ? {} : { port }),
      ...(features.length === 0 ? {} : { features }),
      ...(force === undefined ? {} : { force }),
    };
  },
};

/**
 * The name a caller who typed only a path meant.
 *
 * `.`, `..`, and the root directory have no basename that can serve as a name,
 * so they take the same fallback the command always used. Everything else is
 * the platform's own basename; whether it is a usable name is the validator's
 * question, not this function's.
 */
const defaultWorkspaceName = (path: string): string => {
  const name = basename(path);
  return name === "" || name === "." || name === ".." ? "uvp-service" : name;
};
