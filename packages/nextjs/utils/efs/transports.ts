import { keccak256, sha256 } from "viem";

export type TransportType =
  | "onchain"
  | "data"
  | "ipfs"
  | "arweave"
  | "magnet"
  | "https"
  | "ftp"
  | "s3"
  | "gs"
  | "dat"
  | "rsync"
  | "bittorrent"
  | "unknown";

/**
 * Debug-UI display and label-resolution order. This is NOT the canonical web3://
 * router priority ladder: ADR-0063 deliberately keeps data: out of router tiering,
 * and the additional off-chain schemes share the router's lowest priority tier.
 */
export const TRANSPORT_DISPLAY_ORDER: TransportType[] = [
  "onchain",
  "data",
  "arweave",
  "ipfs",
  "magnet",
  "https",
  "ftp",
  "s3",
  "gs",
  "dat",
  "rsync",
  "bittorrent",
];

/**
 * Gateway bases for content-addressed transports. Both defaults are public third-party
 * gateways — fine for local dev, wrong for a self-hosted devnet (forces browsers to
 * leave the devnet's origin and trust an external service).
 *
 * Override with `NEXT_PUBLIC_IPFS_GATEWAY` / `NEXT_PUBLIC_ARWEAVE_GATEWAY` at build
 * time. The VPS reverse-proxies its own IPFS + Arweave daemons under the same origin
 * it serves this app, so the devnet sets these to `/ipfs/` / `/arweave/` and stays
 * same-origin.
 *
 * Trailing `/` matters — we concatenate `${gateway}${cid}` without inserting one.
 * The `.replace` below normalizes env values that omit the trailing slash
 * (e.g. `https://host/ipfs` → `https://host/ipfs/`) so the CID is never
 * fused directly onto the path segment.
 */
const IPFS_GATEWAY = (process.env.NEXT_PUBLIC_IPFS_GATEWAY || "https://dweb.link/ipfs/").replace(/\/?$/, "/");
const ARWEAVE_GATEWAY = (process.env.NEXT_PUBLIC_ARWEAVE_GATEWAY || "https://arweave.net/").replace(/\/?$/, "/");

/** Detect transport type from a URI string. */
export function detectTransport(uri: string): TransportType {
  if (uri.startsWith("web3://")) return "onchain";
  if (uri.startsWith("data:")) return "data";
  if (uri.startsWith("ipfs://")) return "ipfs";
  if (uri.startsWith("ar://")) return "arweave";
  if (uri.startsWith("magnet:")) return "magnet";
  if (uri.startsWith("https://")) return "https";
  // The resolver no longer has a URI-scheme allowlist (ADR-0056). This
  // classifier is a debug-UI affordance: unknown schemes may exist on-chain,
  // but the paste/upload controls only offer schemes they can label clearly.
  // Plain http:// is left unknown by client policy; use https:// for fetchable
  // external mirrors.
  if (uri.startsWith("ftp://")) return "ftp";
  if (uri.startsWith("s3://")) return "s3";
  if (uri.startsWith("gs://")) return "gs";
  if (uri.startsWith("dat://")) return "dat";
  if (uri.startsWith("rsync://")) return "rsync";
  if (uri.startsWith("bittorrent://")) return "bittorrent";
  return "unknown";
}

/** Resolve a transport URI to a fetchable gateway URL (or null if not fetchable). */
export function resolveGatewayUrl(uri: string): string | null {
  const transport = detectTransport(uri);
  switch (transport) {
    case "data":
      // RFC 2397 data: URI — the bytes are inline. Browsers fetch() these natively,
      // so the URI IS the fetchable URL.
      return uri;
    case "ipfs": {
      const cid = uri.replace("ipfs://", "");
      return `${IPFS_GATEWAY}${cid}`;
    }
    case "arweave": {
      const id = uri.replace("ar://", "");
      return `${ARWEAVE_GATEWAY}${id}`;
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

/**
 * The canonical `contentHash` of file bytes: `f1220` + the sha2-256 digest in
 * lowercase hex — a multibase-base16 multihash (specs/10, ADR-0064).
 *
 * `f` = base16, `12` = sha2-256, `20` = 32-byte digest. The label matters: a bare
 * `0x…` digest does not say which algorithm made it, so readers (the SDK) report it
 * as `malformed-claim` and the fail-closed reads throw. sha2-256 is canonical
 * because it shares the IPFS CID digest. PROPERTY values are non-revocable, so a
 * wrong form is permanent — this was `keccak256(bytes)` until specs/10 §8.
 */
export function computeContentHash(data: Uint8Array): string {
  return `f1220${sha256(data).slice(2)}`;
}

/** The two registered canonical base16 forms (specs/10 §2.1): `f1220…` sha2-256
 * (canonical for writers) and the `f1b20…` keccak-256 alternate. */
export const CANONICAL_CONTENT_HASH = /^f1(2|b)20[0-9a-f]{64}$/;

/**
 * Whether `expected` is a canonical claim that matches `data`. Accepts the two
 * registered base16 forms — `f1220…` (sha2-256) and the `f1b20…` keccak-256
 * alternate (specs/10 §2.1). A bare `0x…` digest is algorithm-ambiguous (specs/10
 * §1) and is never accepted.
 */
export function verifyContentHash(data: Uint8Array, expected: string): boolean {
  const claim = expected.toLowerCase();
  if (claim.startsWith("f1220")) return claim === computeContentHash(data);
  if (claim.startsWith("f1b20")) return claim === `f1b20${keccak256(data).slice(2)}`;
  return false;
}

/** Short label for transport type (for UI badges). */
export const TRANSPORT_LABELS: Record<TransportType, string> = {
  onchain: "On-chain",
  data: "Inline",
  ipfs: "IPFS",
  arweave: "Arweave",
  magnet: "Magnet",
  https: "HTTPS",
  ftp: "FTP",
  s3: "S3",
  gs: "GCS",
  dat: "Dat",
  rsync: "rsync",
  bittorrent: "BitTorrent",
  unknown: "Unknown",
};
