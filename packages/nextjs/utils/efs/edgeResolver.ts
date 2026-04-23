/**
 * EdgeResolver ABI fragments and utilities (ADR-0041).
 *
 * EdgeResolver is the unified SchemaResolver for the EFS PIN and TAG schemas:
 *
 *   PIN ("bytes32 definition")               — cardinality 1. At most one active PIN per
 *                                              (attester, definition, targetSchema). Used for file
 *                                              placement, PROPERTY value binding (contentType, name),
 *                                              and any predicate where one slot holds one thing.
 *                                              A new PIN at the same slot supersedes the prior in O(1).
 *   TAG ("bytes32 definition, int256 weight") — cardinality N. Multiple TAGs coexist per slot. Used
 *                                              for descriptive labels (#favorite, #nsfw), folder
 *                                              visibility under dataSchemaUID, schema-alias discovery.
 *                                              Weight defaults to 1; sign/magnitude is consumer-defined
 *                                              metadata (sort key, score). There is NO supersede-via-
 *                                              negative-weight — removal is ALWAYS via eas.revoke().
 *
 * These are used instead of scaffold-eth hooks because EdgeResolver is a newly deployed
 * contract whose address isn't known until after `yarn deploy`. Components use
 * publicClient.readContract with these fragments + the runtime address.
 */

export const EDGE_RESOLVER_ABI = [
  // ============================================================================================
  // SCHEMA UIDS
  // ============================================================================================
  {
    inputs: [],
    name: "PIN_SCHEMA_UID",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "TAG_SCHEMA_UID",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },

  // ============================================================================================
  // PIN READS (cardinality 1, O(1))
  // ============================================================================================
  {
    inputs: [
      { internalType: "bytes32", name: "definition", type: "bytes32" },
      { internalType: "address", name: "attester", type: "address" },
      { internalType: "bytes32", name: "targetSchema", type: "bytes32" },
    ],
    name: "getActivePin",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "definition", type: "bytes32" },
      { internalType: "address", name: "attester", type: "address" },
      { internalType: "bytes32", name: "targetSchema", type: "bytes32" },
    ],
    name: "getActivePinTarget",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "definition", type: "bytes32" },
      { internalType: "address", name: "attester", type: "address" },
      { internalType: "bytes32", name: "targetSchema", type: "bytes32" },
    ],
    name: "getActivePinSlot",
    outputs: [
      {
        components: [
          { internalType: "bytes32", name: "pinUID", type: "bytes32" },
          { internalType: "bytes32", name: "targetID", type: "bytes32" },
        ],
        internalType: "struct EdgeResolver.SlotEntry",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },

  // ============================================================================================
  // TAG READS (cardinality N, list)
  // ============================================================================================
  {
    inputs: [
      { internalType: "bytes32", name: "definition", type: "bytes32" },
      { internalType: "address", name: "attester", type: "address" },
      { internalType: "bytes32", name: "schema", type: "bytes32" },
      { internalType: "uint256", name: "start", type: "uint256" },
      { internalType: "uint256", name: "length", type: "uint256" },
    ],
    name: "getActiveTagEntries",
    outputs: [
      {
        components: [
          { internalType: "bytes32", name: "tagUID", type: "bytes32" },
          { internalType: "int256", name: "weight", type: "int256" },
        ],
        internalType: "struct EdgeResolver.TagEntry[]",
        name: "",
        type: "tuple[]",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "definition", type: "bytes32" },
      { internalType: "address", name: "attester", type: "address" },
      { internalType: "bytes32", name: "schema", type: "bytes32" },
      { internalType: "uint256", name: "start", type: "uint256" },
      { internalType: "uint256", name: "length", type: "uint256" },
    ],
    name: "getActiveTags",
    outputs: [{ internalType: "bytes32[]", name: "", type: "bytes32[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "definition", type: "bytes32" },
      { internalType: "address", name: "attester", type: "address" },
      { internalType: "bytes32", name: "schema", type: "bytes32" },
      { internalType: "uint256", name: "start", type: "uint256" },
      { internalType: "uint256", name: "length", type: "uint256" },
    ],
    name: "getActiveTargetsByAttesterAndSchema",
    outputs: [{ internalType: "bytes32[]", name: "", type: "bytes32[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "definition", type: "bytes32" },
      { internalType: "address", name: "attester", type: "address" },
      { internalType: "bytes32", name: "schema", type: "bytes32" },
    ],
    name: "getActiveTagsCount",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "definition", type: "bytes32" },
      { internalType: "address", name: "attester", type: "address" },
      { internalType: "bytes32", name: "schema", type: "bytes32" },
    ],
    name: "getActiveTargetsByAttesterAndSchemaCount",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },

  // ============================================================================================
  // SCHEMA-AWARE SINGLE-EDGE LOOKUP
  // ============================================================================================
  {
    inputs: [
      { internalType: "address", name: "attester", type: "address" },
      { internalType: "bytes32", name: "targetID", type: "bytes32" },
      { internalType: "bytes32", name: "definition", type: "bytes32" },
      { internalType: "bytes32", name: "schema", type: "bytes32" },
    ],
    name: "getActiveEdgeUID",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "attester", type: "address" },
      { internalType: "bytes32", name: "targetID", type: "bytes32" },
      { internalType: "bytes32", name: "definition", type: "bytes32" },
      { internalType: "bytes32", name: "schema", type: "bytes32" },
    ],
    name: "isActiveEdge",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },

  // ============================================================================================
  // SCHEMA-BLIND AGGREGATE CHECKS (PIN + TAG)
  // ============================================================================================
  {
    inputs: [
      { internalType: "address", name: "attester", type: "address" },
      { internalType: "bytes32", name: "targetID", type: "bytes32" },
      { internalType: "bytes32", name: "definition", type: "bytes32" },
    ],
    name: "isActiveEdgeAnySchema",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "targetID", type: "bytes32" },
      { internalType: "bytes32", name: "definition", type: "bytes32" },
    ],
    name: "hasActiveEdge",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "targetID", type: "bytes32" },
      { internalType: "bytes32", name: "definition", type: "bytes32" },
      { internalType: "address[]", name: "attesters", type: "address[]" },
    ],
    name: "hasActiveEdgeFromAny",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },

  // ============================================================================================
  // DISCOVERY (append-only; both schemas contribute)
  // ============================================================================================
  {
    inputs: [
      { internalType: "bytes32", name: "targetID", type: "bytes32" },
      { internalType: "uint256", name: "start", type: "uint256" },
      { internalType: "uint256", name: "length", type: "uint256" },
    ],
    name: "getEdgeDefinitions",
    outputs: [{ internalType: "bytes32[]", name: "", type: "bytes32[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "bytes32", name: "targetID", type: "bytes32" }],
    name: "getEdgeDefinitionCount",
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
    name: "getTargetsByDefinition",
    outputs: [{ internalType: "bytes32[]", name: "", type: "bytes32[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "bytes32", name: "definition", type: "bytes32" }],
    name: "getTargetsByDefinitionCount",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "parentUID", type: "bytes32" },
      { internalType: "bytes32", name: "definition", type: "bytes32" },
      { internalType: "uint256", name: "start", type: "uint256" },
      { internalType: "uint256", name: "length", type: "uint256" },
    ],
    name: "getChildrenWithEdge",
    outputs: [{ internalType: "bytes32[]", name: "", type: "bytes32[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "parentUID", type: "bytes32" },
      { internalType: "bytes32", name: "definition", type: "bytes32" },
    ],
    name: "getChildrenWithEdgeCount",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

/**
 * Get the EdgeResolver address from deployedContracts at runtime.
 * Returns undefined if the contract hasn't been deployed yet.
 */
export async function getEdgeResolverAddress(chainId: number): Promise<`0x${string}` | undefined> {
  try {
    const deployedContracts = await import("~~/contracts/deployedContracts");
    const chainContracts = (deployedContracts.default as any)[chainId];
    return chainContracts?.EdgeResolver?.address as `0x${string}` | undefined;
  } catch {
    return undefined;
  }
}
