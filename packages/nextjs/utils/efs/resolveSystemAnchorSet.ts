import type { Abi, PublicClient } from "viem";

const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";

export interface SystemSetArgs {
  publicClient: PublicClient;
  indexerAddress: `0x${string}`;
  indexerAbi: Abi;
  edgeResolverAddress: `0x${string}`;
  edgeResolverAbi: Abi;
  rootUID: `0x${string}`;
  anchorSchemaUID: `0x${string}`;
  lensAddresses: string[];
}

/**
 * Resolve the set of child ANCHOR UIDs tagged `system` by any active lens.
 * Convention: the system TAG targets the file's ANCHOR (targetSchema =
 * anchorSchema), so results match a directory item's `uid` directly. Degrades to
 * an empty set when /tags/system does not exist. Lowercased UIDs in the set.
 *
 * Deliberately does NOT reuse FileBrowser's resolveTagSet/matchesUID: that path
 * unions a DATA-target bucket and is weight-filtered (effective TAG, ADR-0042).
 * Here we want the kernel "active" semantic against the anchor-target bucket only.
 */
export async function resolveSystemAnchorSet(args: SystemSetArgs): Promise<Set<string>> {
  const {
    publicClient,
    indexerAddress,
    indexerAbi,
    edgeResolverAddress,
    edgeResolverAbi,
    rootUID,
    anchorSchemaUID,
    lensAddresses,
  } = args;

  const result = new Set<string>();
  if (lensAddresses.length === 0) return result;

  // resolvePath(rootUID, "tags") -> resolvePath(tagsRoot, "system"); empty set if missing.
  let systemDef: `0x${string}`;
  try {
    const tagsRoot = (await publicClient.readContract({
      address: indexerAddress,
      abi: indexerAbi,
      functionName: "resolvePath",
      args: [rootUID, "tags"],
    })) as `0x${string}`;
    if (!tagsRoot || tagsRoot === ZERO) return result;

    systemDef = (await publicClient.readContract({
      address: indexerAddress,
      abi: indexerAbi,
      functionName: "resolvePath",
      args: [tagsRoot, "system"],
    })) as `0x${string}`;
    if (!systemDef || systemDef === ZERO) return result;
  } catch {
    // "tags" / "system" not yet created — no system anchors.
    return result;
  }

  // For each lens attester: list the anchor-schema targets carrying the system
  // TAG (kernel-active, not weight-filtered). Union non-zero targets, lowercased.
  // Single page of 200 is sufficient for this thin read seam; the SDK will own
  // full pagination later.
  for (const lens of lensAddresses) {
    try {
      const targets = (await publicClient.readContract({
        address: edgeResolverAddress,
        abi: edgeResolverAbi,
        functionName: "getActiveTargetsByAttesterAndSchema",
        args: [systemDef, lens as `0x${string}`, anchorSchemaUID, 0n, 200n],
      })) as readonly `0x${string}`[];

      for (const target of targets) {
        if (target && target !== ZERO) result.add(target.toLowerCase());
      }
    } catch {
      // Skip a lens whose read failed; partial results are acceptable here.
    }
  }

  return result;
}
