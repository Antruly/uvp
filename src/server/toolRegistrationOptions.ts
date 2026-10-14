import type { ToolAnnotations, ToolContract } from "../contracts/toolContractTypes.js";

/**
 * What a contract contributes to `registerTool`.
 *
 * Every field here is read off the contract rather than written again. That is
 * the whole point of the contract layer: the tool list an MCP client sees and the
 * catalog published at `/uvp/tool-catalog.json` are two renderings of one value,
 * so a tool whose description was edited in the server would be a description
 * that appears nowhere else.
 *
 * The input schema is passed through unchanged — the SDK converts it to JSON
 * Schema for `tools/list` itself — but the handler parses with it again. Both
 * happen on purpose: the SDK's conversion is for advertising, and the handler's
 * `parse` is the one that produces the typed value the implementation consumes.
 */
export interface ToolRegistrationOptions {
  readonly title: string;
  readonly description: string;
  readonly inputSchema: ToolContract["inputSchema"];
  readonly outputSchema: ToolContract["outputSchema"];
  readonly annotations: ToolAnnotations;
}

export const registrationOptionsFor = (contract: ToolContract): ToolRegistrationOptions => ({
  title: contract.title,
  description: contract.description,
  inputSchema: contract.inputSchema,
  outputSchema: contract.outputSchema,
  annotations: { ...contract.annotations },
});
