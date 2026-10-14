import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  MCP_SERVER_NAME,
  MCP_SERVER_TITLE,
  PACKAGE_NAME,
  PACKAGE_VERSION,
} from "../../generatedPackageMetadata.js";
import { serveUvpStdio } from "../../server/uvpMcpServer.js";
import { asBoolean, asString, flagError } from "../args.js";
import type { LocalCommand, LocalRunContext } from "../commandSpec.js";
import { EXIT_OK } from "../exitCodes.js";

/**
 * `uvp mcp` and `uvp setup`.
 *
 * The two commands that are not tool calls. Both exist because the MCP server has
 * to be *startable* by a client and *addressable* by a person configuring one,
 * and neither of those is an operation over a workspace.
 */

export const mcpCommand: LocalCommand = {
  path: ["mcp"],
  summary: "Serve the uvp tools over MCP on standard input and output.",
  usage: "uvp mcp [--no-legacy]",
  flags: [
    {
      name: "legacy",
      type: "boolean",
      description:
        "Serve 2025-era handshakes from the same factory. On by default; --no-legacy refuses them.",
    },
  ],
  notes: [
    "Nothing but the protocol is written to stdout. Diagnostics go to stderr, because a stray line",
    "on stdout is a malformed JSON-RPC frame, and the client reports it with no hint as to its source.",
    "",
    "The command returns when the client closes standard input. A clean close exits 0; a transport",
    "that could not start exits 2.",
  ],
  run: async (context) => {
    const legacy = asBoolean(context.parsed, "legacy");
    const handle = serveUvpStdio({
      services: context.services,
      // The flag is a switch, but the transport takes a mode: `--no-legacy` is
      // `reject`, and its absence is the transport's own default rather than a
      // spelling this layer asserts.
      ...(legacy === false ? { legacy: "reject" } : {}),
    });
    await stdinEnded();
    await handle.close();
    return EXIT_OK;
  },
};

/**
 * Resolves when the client closes its end of the pipe.
 *
 * Without this the command would return as soon as the server was listening, and
 * the CLI would set its exit code and let the process wind down before the first
 * request arrived. The transport does read stdin, which keeps the loop alive on
 * its own — but "the process happens not to exit yet" is not something to depend
 * on, and the exit code has to be set after the conversation, not before it.
 */
const stdinEnded = (): Promise<void> =>
  new Promise((settle) => {
    if (process.stdin.readableEnded) {
      settle();
      return;
    }
    process.stdin.once("end", () => settle());
    process.stdin.once("close", () => settle());
  });

export const setupCommand: LocalCommand = {
  path: ["setup"],
  summary: "Print the MCP client configuration for uvp, or write it into a file.",
  usage: "uvp setup [--write] [--path FILE] [--client NAME]",
  flags: [
    {
      name: "write",
      type: "boolean",
      description: "Write the configuration into a file instead of printing it.",
    },
    {
      name: "path",
      type: "string",
      value: "FILE",
      description: "Where to write. Defaults to .mcp.json in the current directory.",
    },
    {
      name: "client",
      type: "string",
      value: "NAME",
      description: "claude-code, claude-desktop, or cursor. Default claude-code.",
    },
  ],
  notes: [
    "Writing merges. An existing configuration keeps every other server it lists, and is only",
    "replaced if uvp could read and parse it first — a file uvp cannot parse is left exactly as it",
    "is and the command exits 2, because it is likelier to be someone's work in progress than a",
    "mistake to be cleaned up.",
  ],
  run: async (context) => setup(context),
};

const CLIENTS = ["claude-code", "claude-desktop", "cursor"] as const;
type ClientName = (typeof CLIENTS)[number];

/**
 * How a client should start this server.
 *
 * `npx -y <name>@<version> mcp` rather than a path into the current installation.
 * The config is read by a different process, on a different day, from a different
 * working directory, so a relative path or a locally built `bin` would depend on
 * which checkout happened to run `uvp setup` — and would break the moment that
 * directory moved. The version is pinned because the server's tool set is part of
 * the interface; an unpinned `npx` would silently upgrade it under a config the
 * user wrote months ago.
 */
const configFor = (client: ClientName): Record<string, unknown> => {
  const entry = {
    command: "npx",
    args: ["-y", `${PACKAGE_NAME}@${PACKAGE_VERSION}`, "mcp"],
  };
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: client === "cursor" ? entry : { ...entry, type: "stdio" },
    },
  };
};

const setup = async (context: LocalRunContext): Promise<number> => {
  const client = parseClient(asString(context.parsed, "client"));
  const config = configFor(client);

  if (asBoolean(context.parsed, "write") !== true) {
    context.out(JSON.stringify(config, null, 2));
    return EXIT_OK;
  }

  const target = resolveTarget(context);
  const existing = await readExisting(target);
  await writeFile(target, `${JSON.stringify(merge(existing, config), null, 2)}\n`, "utf8");
  context.out(`wrote ${target} (${MCP_SERVER_TITLE} ${PACKAGE_VERSION}, client ${client})`);
  return EXIT_OK;
};

const parseClient = (raw: string | undefined): ClientName => {
  if (raw === undefined) return "claude-code";
  const found = CLIENTS.find((candidate) => candidate === raw);
  if (found === undefined) {
    flagError(`Unknown client "${raw}".`, { known: [...CLIENTS] });
  }
  return found;
};

const resolveTarget = (context: LocalRunContext): string => {
  const explicit = asString(context.parsed, "path");
  return explicit === undefined ? join(process.cwd(), ".mcp.json") : resolve(explicit);
};

/**
 * Read the file uvp is about to replace.
 *
 * A missing file is `undefined` — there is nothing to merge. A file that exists
 * and parses is merged. A file that exists and does not parse stops the command:
 * overwriting it would discard whatever its author was in the middle of, and uvp
 * has no way to tell that from a corrupt file.
 */
const readExisting = async (target: string): Promise<Record<string, unknown> | undefined> => {
  let raw: string;
  try {
    raw = await readFile(target, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    flagError(`Could not read ${target}: ${messageOf(error)}`);
  }
  if (raw.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    flagError(`${target} is not valid JSON, so uvp has left it unchanged.`, {
      reason: messageOf(error),
      remedy: `Move it aside, or pass --path to write somewhere else.`,
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    flagError(`${target} is not a JSON object, so uvp has left it unchanged.`);
  }
  return parsed as Record<string, unknown>;
};

/** Keep every server the file already listed, and replace only uvp's own entry. */
const merge = (
  existing: Record<string, unknown> | undefined,
  config: Record<string, unknown>,
): Record<string, unknown> => {
  if (existing === undefined) return config;
  const theirs = existing["mcpServers"];
  if (theirs === undefined) return { ...existing, ...config };
  if (theirs === null || typeof theirs !== "object" || Array.isArray(theirs)) {
    flagError("The existing mcpServers entry is not an object, so uvp will not merge into it.");
  }
  return {
    ...existing,
    mcpServers: { ...(theirs as Record<string, unknown>), ...(config["mcpServers"] as object) },
  };
};

const isMissingFile = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
