import type { CallToolResult } from "@modelcontextprotocol/server";

import { toUvpError } from "../domain/errors.js";

/**
 * Turning a handler's return value into an MCP tool result.
 *
 * The result carries the object twice, and that is not redundancy: `content` is
 * what a client that ignores structured output renders, and `structuredContent`
 * is what a client that honours `outputSchema` validates. Dropping `content`
 * would make uvp's tools blank to any client that has not implemented structured
 * tool output, which is still most of them.
 *
 * The text form is the complete object, not a summary. A summary here would be a
 * second, quieter answer next to the real one, and an agent that read only
 * `content` would never learn which fields it was missing — precisely the failure
 * the evidence model exists to prevent.
 */
export const callToolResult = (output: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
  structuredContent: output,
});

/**
 * Turning a throw into an MCP tool result.
 *
 * `isError` results skip output-schema validation, which is what makes this path
 * usable at all: a failure has no envelope, because it never got far enough to
 * produce one. The error contract is rendered as the text payload so the code,
 * the message, and the remedy all reach the model without it having to parse
 * anything.
 */
export const toolFailureResult = (cause: unknown): CallToolResult => {
  const error = toUvpError(cause);
  const lines = [`${error.code}: ${error.message}`, `remedy: ${error.remediation.action}`];
  if (error.remediation.docs !== undefined) lines.push(`docs: ${error.remediation.docs}`);
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    isError: true,
  };
};
