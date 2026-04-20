"use client";

import { useMemo } from "react";
import { useDisplayName } from "./useDisplayName";
import { getAddress, isAddress, zeroAddress } from "viem";
import { useScaffoldReadContract } from "~~/hooks/scaffold-eth";
import type { ClassifiedContainer } from "~~/utils/efs/containers";

/**
 * Resolve a display name for an explorer container with the full editions
 * cascade: connected wallet → viewed address → EFS deployer (ADR-0016 final
 * fallback). Wraps `useDisplayName` so individual call sites don't have to
 * rewire the deployer fetch each time.
 *
 * For schema / attestation containers the caller passes `aliasUID` — the walk
 * seed resolved by the page (alias anchor under root when one exists, else
 * raw UID). Deploy seeds attach `name` PROPERTY bindings on the alias anchor
 * (per ADR-0033), so resolving names off the raw UID would miss. Anchor and
 * address containers ignore the override.
 *
 * Returns `null` when the container has no meaningful display-name target
 * (e.g. a root anchor walk where `currentPath[0].name` is already the label).
 */
export function useContainerName(
  container: ClassifiedContainer | null,
  connectedAddress: string | undefined,
  aliasUID?: string | null,
): { name: string | null; source: "ens" | "property" | "short-hex" | "loading" } {
  const { data: deployerAddress } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "DEPLOYER",
  });

  const target: `0x${string}` | undefined = (() => {
    if (!container) return undefined;
    if (container.kind === "address" && container.address) return container.address;
    if (container.kind === "schema" || container.kind === "attestation") {
      return (aliasUID as `0x${string}` | undefined) || container.uid;
    }
    return undefined;
  })();

  const editions = useMemo(() => {
    const out: string[] = [];
    const push = (addr: string | undefined | null) => {
      if (!addr) return;
      if (addr === zeroAddress) return;
      if (!isAddress(addr)) return;
      const cs = getAddress(addr);
      if (out.some(a => a.toLowerCase() === cs.toLowerCase())) return;
      out.push(cs);
    };
    push(connectedAddress);
    if (container?.kind === "address") push(container.address);
    push(deployerAddress as string | undefined);
    return out;
  }, [connectedAddress, container?.kind, container?.address, deployerAddress]);

  const { displayName, source } = useDisplayName({
    target,
    editions,
    // For schema / attestation containers ENS reverse-lookup is meaningless.
    skipEns: container?.kind !== "address",
  });

  if (!target) return { name: null, source: "short-hex" };
  return { name: displayName || null, source };
}
