import { doctorContract } from "./toolchainToolContracts.js";
import {
  buildContract,
  runContract,
  runStopContract,
  verifyContract,
  workspaceCreateContract,
} from "./projectToolContracts.js";
import {
  assertExchangeContract,
  captureReadContract,
  captureReplayContract,
  captureStartContract,
  httpRequestContract,
  loadTestContract,
  soapCallContract,
  websocketProbeContract,
} from "./webToolContracts.js";
import type { ToolContract } from "./toolContractTypes.js";

/**
 * The ordered catalog.
 *
 * One list, read by the MCP registrar, the CLI registrar, the catalog
 * generator, and the shipped skill. Adding a tool means adding it here and
 * nowhere else; a tool that is missing from this list does not exist as far as
 * any consumer is concerned.
 *
 * Order is deliberate: readiness first, then the build/run loop, then the
 * network primitives, then composition. A caller skimming the catalog sees the
 * workflow in the order they would actually perform it.
 */
export const TOOL_CONTRACTS = [
  doctorContract,

  workspaceCreateContract,
  buildContract,
  runContract,
  runStopContract,

  httpRequestContract,
  websocketProbeContract,
  soapCallContract,
  loadTestContract,

  captureStartContract,
  captureReadContract,
  captureReplayContract,
  assertExchangeContract,

  verifyContract,
] as const satisfies readonly ToolContract[];

const BY_NAME = new Map<string, ToolContract>(
  TOOL_CONTRACTS.map((contract) => [contract.name, contract]),
);

export const toolNames = (): readonly string[] => TOOL_CONTRACTS.map((c) => c.name);

export const toolContract = (name: string): ToolContract | undefined => BY_NAME.get(name);

/** Throws rather than returning undefined: a missing contract is a bug, not input. */
export const requireToolContract = (name: string): ToolContract => {
  const contract = BY_NAME.get(name);
  if (contract === undefined) throw new Error(`Unknown tool contract: ${name}`);
  return contract;
};

export const contractsByKind = (): ReadonlyMap<string, readonly ToolContract[]> => {
  const grouped = new Map<string, ToolContract[]>();
  for (const contract of TOOL_CONTRACTS) {
    const bucket = grouped.get(contract.kind);
    if (bucket === undefined) grouped.set(contract.kind, [contract]);
    else bucket.push(contract);
  }
  return grouped;
};

/**
 * A stable summary of the catalog's identity.
 *
 * Consumers embed this so a client can tell whether the server it is talking to
 * advertises the catalog it expects. Changing a tool's name, description, or
 * schemas changes the digest; that is the point.
 */
export const catalogDigestInput = (): unknown =>
  TOOL_CONTRACTS.map((contract) => ({
    name: contract.name,
    title: contract.title,
    description: contract.description,
    kind: contract.kind,
    effects: contract.effects,
  }));
