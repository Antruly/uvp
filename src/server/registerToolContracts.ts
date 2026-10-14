import type { McpServer } from "@modelcontextprotocol/server";

import { TOOL_CONTRACTS } from "../contracts/toolContracts.js";
import type { ToolCallContext, ToolHandler } from "../composition/toolHandlers.js";
import { registrationOptionsFor } from "./toolRegistrationOptions.js";
import { callToolResult, toolFailureResult } from "./toolResults.js";

/**
 * Register every contract as an MCP tool.
 *
 * The loop runs over `TOOL_CONTRACTS` rather than over a local list, so a tool
 * that exists in the catalog cannot be missing from the server. The reverse is
 * the case a hand-written registration table gets wrong: it grows a tool the
 * contracts do not describe, and the catalog and the served surface disagree
 * about what this server can do.
 *
 * A handler that is not implemented is a startup error, not a tool that fails at
 * call time. An agent that discovers a tool through `tools/list` has been told it
 * exists; discovering at call time that it does not is worse than the server
 * refusing to start, because the failure lands in the middle of someone's
 * workflow with no way to have known.
 *
 * Returns nothing. It used to return the names it registered, which reads as an
 * invitation to assert registration against that list — and a list built by this
 * function agrees with itself whatever the transport then does with it. What the
 * server actually serves is only knowable from the served surface, so a test of
 * that property asks the server.
 */
export const registerToolContracts = (
  server: McpServer,
  handlers: Readonly<Record<string, ToolHandler>>,
): void => {
  for (const contract of TOOL_CONTRACTS) {
    const implement: ToolHandler | undefined = handlers[contract.name];
    if (implement === undefined) {
      throw new Error(
        `No handler is registered for ${contract.name}. Every contract in TOOL_CONTRACTS needs an implementation before the MCP server starts.`,
      );
    }

    server.registerTool(
      contract.name,
      registrationOptionsFor(contract),
      async (input: unknown, context): Promise<ReturnType<typeof callToolResult>> => {
        const callContext: ToolCallContext = { signal: context.mcpReq.signal };
        try {
          return callToolResult(await implement(input, callContext));
        } catch (cause) {
          return toolFailureResult(cause);
        }
      },
    );
  }
};
