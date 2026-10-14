import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { ServeStdioOptions, StdioServerHandle } from "@modelcontextprotocol/server/stdio";

import { MCP_SERVER_NAME, MCP_SERVER_TITLE } from "../generatedPackageMetadata.js";
import { uvpVersion } from "../version.js";
import { createToolHandlers } from "../composition/toolHandlers.js";
import { createUvpServices } from "../composition/uvpServices.js";
import type { UvpServiceOptions, UvpServices } from "../composition/uvpServices.js";
import { registerToolContracts } from "./registerToolContracts.js";

/**
 * The MCP surface.
 *
 * The server advertises the registry name from `package.json`, not the npm name:
 * they are deliberately different strings, and a client that resolves this
 * server by its npm name will not find it in the registry.
 *
 * The instructions are short on purpose. A model reads them once per session, and
 * everything they could say at length is already in each tool's own description
 * and in the `unknowns` array of every result. What belongs here is the one thing
 * a tool description cannot say: the order the tools are meant to be used in,
 * because that is a property of the set rather than of any member.
 */
const SERVER_INSTRUCTIONS = [
  "uvp builds, runs, and verifies libuvcpp C++ web services.",
  "Start with uvp_doctor: it reports the compiler, CMake, and libuvcpp build that are actually present, and which transport features that build provides.",
  "Then uvp_workspace_create, uvp_build, uvp_run, and the web tools (uvp_http_request, uvp_websocket_probe, uvp_soap_call, uvp_load_test).",
  "uvp_verify runs that whole sequence in one supervised pass and returns a bundle.",
  "",
  "Read two fields on every result before acting on it. `unknowns` lists the questions the call could not answer — a non-empty array is not a failure, and it is the field most likely to change what you do next. `limitations` records truncation, sampling, and timeouts, so a result can be a report about a prefix rather than about a response.",
].join("\n");

export interface UvpMcpServerOptions extends UvpServiceOptions {
  /** Services to reuse instead of building a fresh graph. */
  readonly services?: UvpServices | undefined;
}

/**
 * Build the server around a service graph.
 *
 * The graph is a parameter so a test can hand in a clock, a fake provider, or a
 * pre-populated session store. `serveStdio` calls its factory once per
 * connection, so the graph is created here and shared: a capture session started
 * over one connection must still be readable if the client reconnects.
 */
export const createUvpMcpServer = (options: UvpMcpServerOptions = {}): McpServer => {
  const services = options.services ?? createUvpServices(options);
  const server = new McpServer(
    { name: MCP_SERVER_NAME, title: MCP_SERVER_TITLE, version: uvpVersion() },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerToolContracts(server, createToolHandlers(services));
  return server;
};

/**
 * Serve MCP over stdio until the client closes the connection.
 *
 * Nothing is written to stdout by anything in this path. uvp's own diagnostics go
 * to stderr, and the only writer to stdout is the transport — a stray line on
 * stdout is a corrupt JSON-RPC frame, which a client reports as a protocol error
 * with no hint as to where the extra byte came from.
 */
export const serveUvpStdio = (
  options: UvpMcpServerOptions & ServeStdioOptions = {},
): StdioServerHandle => {
  const { services, now, providers, ...transportOptions } = options;
  const graph = services ?? createUvpServices({ now, providers });

  // Built through `createUvpMcpServer` rather than by repeating its two lines.
  // The duplication was exact when written and would not have stayed that way:
  // a new option or a changed instruction string added here would leave the
  // server the tests exercise different from the server this ships, and nothing
  // would have reported the divergence.
  return serveStdio(() => createUvpMcpServer({ services: graph }), transportOptions);
};
