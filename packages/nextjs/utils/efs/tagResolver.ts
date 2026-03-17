/**
 * TagResolver ABI fragments and utilities.
 *
 * These are used instead of scaffold-eth hooks because TagResolver is a newly deployed
 * contract whose address isn't known until after `yarn deploy`. Components use
 * publicClient.readContract with these fragments + the runtime address.
 */

export const TAG_RESOLVER_ABI = [
  {
    inputs: [
      { internalType: "address", name: "attester", type: "address" },
      { internalType: "bytes32", name: "targetID", type: "bytes32" },
      { internalType: "bytes32", name: "definition", type: "bytes32" },
    ],
    name: "getActiveTagUID",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "bytes32", name: "targetID", type: "bytes32" }],
    name: "getTagDefinitionCount",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "targetID", type: "bytes32" },
      { internalType: "uint256", name: "start", type: "uint256" },
      { internalType: "uint256", name: "length", type: "uint256" },
    ],
    name: "getTagDefinitions",
    outputs: [{ internalType: "bytes32[]", name: "", type: "bytes32[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "bytes32", name: "definition", type: "bytes32" }],
    name: "getTaggedTargetCount",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "definition", type: "bytes32" },
      { internalType: "uint256", name: "start", type: "uint256" },
      { internalType: "uint256", name: "length", type: "uint256" },
    ],
    name: "getTaggedTargets",
    outputs: [{ internalType: "bytes32[]", name: "", type: "bytes32[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "targetID", type: "bytes32" },
      { internalType: "bytes32", name: "definition", type: "bytes32" },
    ],
    name: "isActivelyTagged",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

/**
 * Get the TagResolver address from deployedContracts at runtime.
 * Returns undefined if the contract hasn't been deployed yet.
 */
export async function getTagResolverAddress(chainId: number): Promise<`0x${string}` | undefined> {
  try {
    const deployedContracts = await import("~~/contracts/deployedContracts");
    const chainContracts = (deployedContracts.default as any)[chainId];
    return chainContracts?.TagResolver?.address as `0x${string}` | undefined;
  } catch {
    return undefined;
  }
}
