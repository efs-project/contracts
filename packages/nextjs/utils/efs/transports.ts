import { keccak256 } from "viem";

export type TransportType = "onchain" | "ipfs" | "arweave" | "magnet" | "https" | "unknown";

/**
 * Ordered by preference for display/resolution.
 * web3:// (on-chain, permanent) > ar:// (permanent, content-addressed) >
 * ipfs:// (content-addressed, requires pinning) > magnet: (peer-dependent) >
 * https:// (mutable, centralized — least reliable)
 */
export const TRANSPORT_PREFERENCE: TransportType[] = ["onchain", "arweave", "ipfs", "magnet", "https"];

/** Detect transport type from a URI string. */
export function detectTransport(uri: string): TransportType {
  if (uri.startsWith("web3://")) return "onchain";
  if (uri.startsWith("ipfs://")) return "ipfs";
  if (uri.startsWith("ar://")) return "arweave";
  if (uri.startsWith("magnet:")) return "magnet";
  if (uri.startsWith("https://") || uri.startsWith("http://")) return "https";
  return "unknown";
}

/** Resolve a transport URI to a fetchable gateway URL (or null if not fetchable). */
export function resolveGatewayUrl(uri: string): string | null {
  const transport = detectTransport(uri);
  switch (transport) {
    case "ipfs": {
      const cid = uri.replace("ipfs://", "");
      return `https://dweb.link/ipfs/${cid}`;
    }
    case "arweave": {
      const id = uri.replace("ar://", "");
      return `https://arweave.net/${id}`;
    }
    case "https":
      return uri;
    case "magnet":
      return null; // Not fetchable via HTTP
    case "onchain":
      return null; // Resolved via web3:// protocol, not HTTP gateway
    default:
      return null;
  }
}

/** Compute keccak256 content hash from file bytes. */
export function computeContentHash(data: Uint8Array): `0x${string}` {
  return keccak256(data);
}

/** Verify content hash matches expected. */
export function verifyContentHash(data: Uint8Array, expected: `0x${string}`): boolean {
  return computeContentHash(data) === expected;
}

/** Short label for transport type (for UI badges). */
export const TRANSPORT_LABELS: Record<TransportType, string> = {
  onchain: "On-chain",
  ipfs: "IPFS",
  arweave: "Arweave",
  magnet: "Magnet",
  https: "HTTPS",
  unknown: "Unknown",
};
