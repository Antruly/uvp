#!/usr/bin/env node
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";

/**
 * Drive the packaged MCP server over real stdio.
 *
 * This is the check that catches the packaging mistakes: a file missing from
 * `files[]`, a path that only resolves in a checkout, a dependency that is
 * `devDependencies` because it worked locally. Every other test in the suite runs
 * against the repository, where all of those are true.
 *
 * CI installs the tarball first and passes the installed executable in
 * `UVP_PACKAGED_BIN`; the default is the checkout's own entrypoint, so the script
 * is runnable by hand for debugging.
 *
 * A server that prints a log line on stdout corrupts the protocol, so the
 * responses are parsed rather than grepped. A stray banner is a failure, not
 * noise to be skipped past.
 */

const { values } = parseArgs({
  options: {
    "timeout-ms": { type: "string", default: "20000" },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  console.log(`Usage: node scripts/test-packaged-mcp.mjs [--timeout-ms=20000]

Runs \`<bin> mcp\` and performs an MCP initialize + tools/list handshake.
Bin comes from UVP_PACKAGED_BIN, defaulting to scripts/uvp.mjs.`);
  process.exit(0);
}

const timeoutMs = Number(values["timeout-ms"]);
const bin = process.env.UVP_PACKAGED_BIN ?? new URL("./uvp.mjs", import.meta.url).pathname;

const requests = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "uvp-packaged-check", version: "0.0.0" },
    },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
];

const child = spawn(bin, ["mcp"], { stdio: ["pipe", "pipe", "pipe"] });

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);

const finished = new Promise((resolve) => {
  child.on("close", (code) => resolve(code));
});

const timer = setTimeout(() => {
  child.kill("SIGKILL");
  fail(`The MCP server did not exit within ${timeoutMs}ms.`);
}, timeoutMs);

function fail(message) {
  clearTimeout(timer);
  console.error(`packaged MCP check failed: ${message}`);
  if (stdout !== "") console.error(`stdout:\n${stdout}`);
  if (stderr !== "") console.error(`stderr:\n${stderr}`);
  process.exit(1);
}

// The server stays alive until its input closes, which is what a long-lived
// client wants and what makes this check terminate deterministically.
child.stdin.end();
const exitCode = await finished;
clearTimeout(timer);

if (exitCode !== 0) fail(`the server exited with code ${exitCode}`);

const lines = stdout.split("\n").filter((line) => line.trim() !== "");
const messages = [];
for (const line of lines) {
  try {
    messages.push(JSON.parse(line));
  } catch {
    fail(`stdout line is not JSON, so it is not protocol traffic: ${JSON.stringify(line)}`);
  }
}

const byId = new Map(messages.map((message) => [message.id, message]));

const initialized = byId.get(1);
if (initialized?.error !== undefined)
  fail(`initialize returned an error: ${JSON.stringify(initialized.error)}`);
if (initialized?.result?.serverInfo?.name === undefined) {
  fail("initialize did not return serverInfo.name");
}

const listed = byId.get(2);
if (listed?.error !== undefined)
  fail(`tools/list returned an error: ${JSON.stringify(listed.error)}`);

const tools = listed?.result?.tools;
if (!Array.isArray(tools) || tools.length === 0) fail("tools/list returned no tools");

const { TOOL_CONTRACTS } = await import("./lib/paths.mjs")
  .then(({ importCompiled }) => importCompiled("contracts/toolContracts.js"))
  .catch(() => ({ TOOL_CONTRACTS: null }));

if (TOOL_CONTRACTS !== null) {
  const advertised = new Set(tools.map((tool) => tool.name));
  const missing = TOOL_CONTRACTS.map((contract) => contract.name).filter(
    (name) => !advertised.has(name),
  );
  if (missing.length > 0) {
    fail(`the packaged server does not advertise: ${missing.join(", ")}`);
  }
  console.log(
    `packaged MCP check passed: ${initialized.result.serverInfo.name} ` +
      `advertised ${tools.length} of ${TOOL_CONTRACTS.length} tools.`,
  );
} else {
  console.log(`packaged MCP check passed: server advertised ${tools.length} tool(s).`);
}

for (const tool of tools) {
  if (typeof tool.inputSchema !== "object" || tool.inputSchema === null) {
    fail(`tool ${tool.name} has no inputSchema`);
  }
}
