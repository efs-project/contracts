"use client";

import { useEffect, useMemo, useState } from "react";
import { decodeAbiParameters, getAddress, isAddress, zeroAddress, zeroHash } from "viem";
import { mainnet } from "viem/chains";
import { useEnsName, usePublicClient } from "wagmi";
import { useDeployedContractInfo, useTargetNetwork } from "~~/hooks/scaffold-eth";

/**
 * Resolve a human-readable display name for any EFS container (address, anchor,
 * DATA, schema, attestation) per ADR-0034 and ADR-0035.
 *
 * Resolution walks the unified PROPERTY model:
 *
 *   container → Anchor<PROPERTY>(name="name") → TAG (per-attester singleton) → PROPERTY(value)
 *
 * Hierarchy:
 *   1. ENS reverse-lookup (addresses only, mainnet).
 *   2. `name` PROPERTY bound via TAG, scoped to the `editions` list in order. First hit wins.
 *   3. Short-hex fallback (`0xabcd…ef01`).
 *
 * `target` may be an EVM address or a raw 32-byte hex UID. Addresses are
 * internally converted to `bytes32(uint160(addr))` (ADR-0033 encoding).
 */

const EAS_GET_ATTESTATION_ABI = [
  {
    inputs: [{ name: "uid", type: "bytes32" }],
    name: "getAttestation",
    outputs: [
      {
        components: [
          { name: "uid", type: "bytes32" },
          { name: "schema", type: "bytes32" },
          { name: "refUID", type: "bytes32" },
          { name: "time", type: "uint64" },
          { name: "expirationTime", type: "uint64" },
          { name: "revocationTime", type: "uint64" },
          { name: "revocable", type: "bool" },
          { name: "recipient", type: "address" },
          { name: "attester", type: "address" },
          { name: "data", type: "bytes" },
        ],
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

const TAG_RESOLVER_ABI = [
  {
    inputs: [
      { name: "definition", type: "bytes32" },
      { name: "attester", type: "address" },
      { name: "schema", type: "bytes32" },
      { name: "start", type: "uint256" },
      { name: "length", type: "uint256" },
    ],
    name: "getActiveTargetsByAttesterAndSchema",
    outputs: [{ name: "", type: "bytes32[]" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

type UseDisplayNameArgs = {
  target: `0x${string}` | undefined;
  editions?: readonly string[];
  /** Skip ENS reverse-lookup (e.g. for schema / attestation UIDs where it's meaningless). */
  skipEns?: boolean;
  /** Short-hex fallback max length — defaults to 10 ("0xabcd…ef01"). */
  shortLength?: number;
};

type UseDisplayNameResult = {
  /** Resolved display name, or the short-hex fallback if none found. Always renderable. */
  displayName: string;
  /** Source of the resolution — useful for tooltips / debug badges. */
  source: "ens" | "property" | "short-hex" | "loading";
  /** True until both ENS and PROPERTY lookups have settled. */
  isLoading: boolean;
  /** The attester whose `name` binding resolved (when source === "property"). */
  resolvedEdition?: `0x${string}`;
};

function shortHex(hex: string, maxLen = 10): string {
  if (!hex.startsWith("0x") || hex.length <= maxLen + 4) return hex;
  const head = hex.slice(0, 2 + Math.ceil((maxLen - 1) / 2));
  const tail = hex.slice(-(maxLen - head.length + 2));
  return `${head}…${tail}`;
}

function addressToBytes32(addr: `0x${string}`): `0x${string}` {
  const clean = addr.toLowerCase().replace(/^0x/, "");
  return ("0x" + "0".repeat(24) + clean) as `0x${string}`;
}

type Classified = { kind: "address"; address: `0x${string}`; uid: `0x${string}` } | { kind: "uid"; uid: `0x${string}` };

function classifyTarget(target: `0x${string}` | undefined): Classified | null {
  if (!target) return null;
  const clean = target.toLowerCase();
  if (isAddress(clean) && clean.length === 42) {
    const checksummed = getAddress(clean);
    return { kind: "address", address: checksummed, uid: addressToBytes32(checksummed) };
  }
  if (clean.length === 66 && /^0x[0-9a-f]{64}$/i.test(clean)) {
    return { kind: "uid", uid: clean as `0x${string}` };
  }
  return null;
}

function decodeValue(data: `0x${string}`): string {
  try {
    const [value] = decodeAbiParameters([{ type: "string" }], data) as [string];
    return value;
  } catch {
    return "";
  }
}

export const useDisplayName = ({
  target,
  editions,
  skipEns,
  shortLength = 10,
}: UseDisplayNameArgs): UseDisplayNameResult => {
  const classified = classifyTarget(target);
  const { targetNetwork } = useTargetNetwork();
  const publicClient = usePublicClient({ chainId: targetNetwork.id });

  const { data: indexerInfo } = useDeployedContractInfo({ contractName: "Indexer" });
  const { data: tagResolverInfo } = useDeployedContractInfo({ contractName: "TagResolver" });
  const indexerAddress = indexerInfo?.address as `0x${string}` | undefined;
  const indexerAbi = indexerInfo?.abi;
  const tagResolverAddress = tagResolverInfo?.address as `0x${string}` | undefined;

  const { data: ensName, isLoading: ensLoading } = useEnsName({
    address: classified?.kind === "address" ? classified.address : undefined,
    chainId: mainnet.id,
    query: {
      enabled: !skipEns && classified?.kind === "address",
    },
  });

  const editionsKey = useMemo(
    () =>
      (editions ?? [])
        .filter(e => e && e !== zeroAddress)
        .map(e => e.toLowerCase())
        .join(","),
    [editions],
  );

  const [propertyLookup, setPropertyLookup] = useState<{
    name: string | null;
    attester: `0x${string}` | null;
    loading: boolean;
  }>({ name: null, attester: null, loading: true });

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!classified || !indexerAddress || !indexerAbi || !tagResolverAddress || !publicClient) {
        if (!cancelled) setPropertyLookup({ name: null, attester: null, loading: false });
        return;
      }
      const editionsList = (editions ?? []).filter(e => e && e !== zeroAddress);
      if (editionsList.length === 0) {
        if (!cancelled) setPropertyLookup({ name: null, attester: null, loading: false });
        return;
      }

      if (!cancelled) setPropertyLookup(prev => ({ ...prev, loading: true }));

      try {
        const propertySchemaUID = (await publicClient.readContract({
          address: indexerAddress,
          abi: indexerAbi as any,
          functionName: "PROPERTY_SCHEMA_UID",
          args: [],
        })) as `0x${string}`;

        if (!propertySchemaUID || propertySchemaUID === zeroHash) {
          if (!cancelled) setPropertyLookup({ name: null, attester: null, loading: false });
          return;
        }

        // 1. Resolve the "name" key anchor under the container.
        const keyAnchorUID = (await publicClient.readContract({
          address: indexerAddress,
          abi: indexerAbi as any,
          functionName: "resolveAnchor",
          args: [classified.uid, "name", propertySchemaUID],
        })) as `0x${string}`;

        if (!keyAnchorUID || keyAnchorUID === zeroHash) {
          if (!cancelled) setPropertyLookup({ name: null, attester: null, loading: false });
          return;
        }

        const easAddress = (await publicClient.readContract({
          address: indexerAddress,
          abi: indexerAbi as any,
          functionName: "getEAS",
          args: [],
        })) as `0x${string}`;

        // 2. For each attester in edition order, fetch the active PROPERTY under the key anchor.
        for (const edition of editionsList) {
          const targets = (await publicClient.readContract({
            address: tagResolverAddress,
            abi: TAG_RESOLVER_ABI,
            functionName: "getActiveTargetsByAttesterAndSchema",
            args: [keyAnchorUID, getAddress(edition), propertySchemaUID, 0n, 1n],
          })) as `0x${string}`[];
          if (targets.length === 0) continue;

          const propertyUID = targets[0];
          try {
            const att = (await publicClient.readContract({
              address: easAddress,
              abi: EAS_GET_ATTESTATION_ABI,
              functionName: "getAttestation",
              args: [propertyUID],
            })) as { uid: `0x${string}`; revocationTime: bigint; data: `0x${string}` };
            if (!att || att.uid === zeroHash) continue;
            if (att.revocationTime !== 0n) continue;
            const value = decodeValue(att.data);
            if (value && value.length > 0) {
              if (!cancelled) {
                setPropertyLookup({ name: value, attester: getAddress(edition), loading: false });
              }
              return;
            }
          } catch {
            // malformed PROPERTY — try next edition
          }
        }

        if (!cancelled) setPropertyLookup({ name: null, attester: null, loading: false });
      } catch {
        if (!cancelled) setPropertyLookup({ name: null, attester: null, loading: false });
      }
    }

    run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classified?.uid, editionsKey, indexerAddress, tagResolverAddress, publicClient]);

  if (!classified) {
    return { displayName: target ?? "", source: "short-hex", isLoading: false };
  }

  if (ensName && !skipEns) {
    return { displayName: ensName, source: "ens", isLoading: false };
  }

  if (propertyLookup.name) {
    return {
      displayName: propertyLookup.name,
      source: "property",
      isLoading: false,
      resolvedEdition: propertyLookup.attester ?? undefined,
    };
  }

  const stillLoading = propertyLookup.loading || (classified.kind === "address" && ensLoading && !skipEns);
  const fallback =
    classified.kind === "address" ? shortHex(classified.address, shortLength) : shortHex(classified.uid, shortLength);
  return { displayName: fallback, source: stillLoading ? "loading" : "short-hex", isLoading: stillLoading };
};
