import type { PublicClient } from "viem";
import { getAddress, isAddress, isHex, zeroAddress, zeroHash } from "viem";

export type ContainerKind = "anchor" | "address" | "schema" | "attestation";

export type ClassifiedContainer = {
  kind: ContainerKind;
  /**
   * Canonical on-chain key for the container:
   * - anchor: attestation UID (bytes32)
   * - address: bytes32(uint160(addr)) — upper 12 bytes zero
   * - schema: schema UID (bytes32)
   * - attestation: attestation UID (bytes32)
   */
  uid: `0x${string}`;
  /**
   * Human-friendly label (ENS name when available, short UID, or raw segment).
   */
  displayName: string;
  /**
   * For address containers, the resolved checksummed address.
   */
  address?: `0x${string}`;
  /**
   * Raw URL segment as typed by the user, before resolution.
   */
  rawSegment: string;
};

const SCHEMA_REGISTRY_ABI = [
  {
    inputs: [{ name: "uid", type: "bytes32" }],
    name: "getSchema",
    outputs: [
      {
        components: [
          { name: "uid", type: "bytes32" },
          { name: "resolver", type: "address" },
          { name: "revocable", type: "bool" },
          { name: "schema", type: "string" },
        ],
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

const EAS_ATTESTATION_ABI = [
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
  {
    inputs: [],
    name: "getSchemaRegistry",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

function addressToBytes32(addr: `0x${string}`): `0x${string}` {
  const clean = addr.toLowerCase().replace(/^0x/, "");
  return ("0x" + "0".repeat(24) + clean) as `0x${string}`;
}

function shortHex(hex: string): string {
  if (hex.length <= 10) return hex;
  return `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

function normalizeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return raw.trim();
  }
}

export type ClassifyDeps = {
  publicClient: PublicClient | undefined;
  easAddress: `0x${string}` | undefined;
  /** Optional: if known, avoids an extra RPC round-trip for `getSchemaRegistry`. */
  schemaRegistryAddress?: `0x${string}`;
};

/**
 * Classify the top-level URL segment into one of four container flavors.
 *
 * Precedence: address (ENS / 40-hex) → schema UID (64-hex, registered) →
 * attestation UID (64-hex, exists) → anchor (name). See ADR-0033.
 */
export async function classifyTopLevelSegment(raw: string, deps: ClassifyDeps): Promise<ClassifiedContainer> {
  const segment = normalizeSegment(raw);
  const rawSegment = raw;

  if (!segment) {
    return { kind: "anchor", uid: zeroHash as `0x${string}`, displayName: rawSegment, rawSegment };
  }

  // 1. ENS names (*.eth) — resolve to an address.
  if (segment.toLowerCase().endsWith(".eth") && deps.publicClient) {
    try {
      const resolved = await deps.publicClient.getEnsAddress({ name: segment });
      if (resolved && resolved !== zeroAddress) {
        const checksummed = getAddress(resolved);
        return {
          kind: "address",
          uid: addressToBytes32(checksummed),
          displayName: segment,
          address: checksummed,
          rawSegment,
        };
      }
    } catch {
      // fall through to other classifiers
    }
  }

  // 2. Raw 40-char hex — Ethereum address.
  const hexBody = segment.startsWith("0x") || segment.startsWith("0X") ? segment.slice(2) : segment;
  const looksHex = /^[0-9a-fA-F]+$/.test(hexBody);

  if (looksHex && hexBody.length === 40) {
    const candidate = `0x${hexBody}` as `0x${string}`;
    if (isAddress(candidate)) {
      const checksummed = getAddress(candidate);
      return {
        kind: "address",
        uid: addressToBytes32(checksummed),
        displayName: shortHex(checksummed),
        address: checksummed,
        rawSegment,
      };
    }
  }

  // 3. Raw 64-char hex — schema UID or attestation UID.
  if (looksHex && hexBody.length === 64) {
    const uid = `0x${hexBody.toLowerCase()}` as `0x${string}`;
    if (isHex(uid) && deps.publicClient && deps.easAddress) {
      // Try SchemaRegistry first.
      let registryAddr = deps.schemaRegistryAddress;
      if (!registryAddr) {
        try {
          const fetched = (await deps.publicClient.readContract({
            address: deps.easAddress,
            abi: EAS_ATTESTATION_ABI,
            functionName: "getSchemaRegistry",
          })) as `0x${string}`;
          if (fetched && fetched !== zeroAddress) registryAddr = fetched;
        } catch {
          // ignore — fall through to attestation lookup
        }
      }

      if (registryAddr) {
        try {
          const schema = (await deps.publicClient.readContract({
            address: registryAddr,
            abi: SCHEMA_REGISTRY_ABI,
            functionName: "getSchema",
            args: [uid],
          })) as { uid: `0x${string}` };
          if (schema && schema.uid && schema.uid !== zeroHash) {
            return { kind: "schema", uid, displayName: shortHex(uid), rawSegment };
          }
        } catch {
          // fall through to attestation lookup
        }
      }

      // Try EAS attestation lookup.
      try {
        const att = (await deps.publicClient.readContract({
          address: deps.easAddress,
          abi: EAS_ATTESTATION_ABI,
          functionName: "getAttestation",
          args: [uid],
        })) as { uid: `0x${string}` };
        if (att && att.uid && att.uid !== zeroHash) {
          return { kind: "attestation", uid, displayName: shortHex(uid), rawSegment };
        }
      } catch {
        // fall through to anchor fallback
      }
    }
  }

  // 4. Fall through — treat as anchor name. The page walker resolves the actual UID.
  return { kind: "anchor", uid: zeroHash as `0x${string}`, displayName: segment, rawSegment };
}

/**
 * Compute the effective editions list for a container.
 *
 * Anchor / schema / attestation: `[connectedAddress]` when connected, else `[]`.
 * Address container: `[connectedAddress, viewedAddress]` (connected overrides,
 * viewed user's edition as fallback). Dedupes; drops zero addresses.
 *
 * Explicit `?editions=<…>` always overrides via `explicitEditions`.
 */
export function defaultEditionsForContainer(args: {
  container: ClassifiedContainer | null;
  connectedAddress: string | undefined;
  explicitEditions: string[] | null;
}): string[] {
  if (args.explicitEditions && args.explicitEditions.length > 0) return args.explicitEditions;

  const out: string[] = [];
  const push = (addr: string | undefined) => {
    if (!addr) return;
    if (addr === zeroAddress) return;
    if (out.some(a => a.toLowerCase() === addr.toLowerCase())) return;
    out.push(addr);
  };

  push(args.connectedAddress);
  if (args.container?.kind === "address" && args.container.address) {
    push(args.container.address);
  }
  return out;
}
