import { keccak256, sha256 } from "ethers";
import { readFileSync } from "fs";
import path from "path";

export interface DatasetManifestDefaults {
  contentType?: string;
  license?: string;
}

export interface DatasetManifestEntry {
  path: string;
  name?: string;
  tags?: string[];
  license?: string;
  author?: string;
  source?: string;
  mirrors?: string[];
  contentType?: string;
}

export interface DatasetManifest {
  dataset: string;
  anchorPath: string;
  description?: string;
  defaults?: DatasetManifestDefaults;
  files: DatasetManifestEntry[];
}

export interface SeedDatasetArgs {
  manifest: string;
  execute: boolean;
  plan: boolean;
  pin: boolean;
  force: boolean;
  ipfsApiUrl: string;
  only: string[];
}

export interface ActiveDatasetPlacement {
  dataUID: string;
  contentHash: string | null;
}

export type SeedFileDecision =
  | { action: "skip"; reason: "matching-content-hash" }
  /** Same bytes, but the active claim is the pre-specs/10 bare keccak form: re-bind a
   * canonical contentHash on the EXISTING DATA instead of re-seeding the file. */
  | { action: "heal"; reason: "legacy-content-hash" }
  | { action: "write"; reason: "missing-placement" | "missing-content-hash" | "content-hash-changed" | "forced" };

/**
 * The canonical `contentHash` of file bytes: `f1220` + the sha2-256 digest in lowercase
 * hex — a multibase-base16 multihash (specs/10 §2.3, ADR-0064). `f` = base16, `12` =
 * sha2-256, `20` = 32-byte digest. This seeder minted `keccak256(bytes)` — a bare `0x…`
 * digest that does not say which algorithm made it — until specs/10 §8; readers (the SDK)
 * report that form as `malformed-claim`, and PROPERTY values are non-revocable.
 */
export function canonicalContentHash(bytes: Uint8Array): string {
  return `f1220${sha256(bytes).slice(2)}`;
}

/**
 * The claim this seeder USED to mint for the same bytes — `keccak256(bytes)`. Only for
 * RECOGNISING a legacy claim of unchanged content; never written.
 */
export function legacyKeccakContentHash(bytes: Uint8Array): string {
  return keccak256(bytes);
}

const DEFAULT_IPFS_API_URL = "http://127.0.0.1:5001/api/v0";

export function parseSeedDatasetArgs(argv: string[]): SeedDatasetArgs {
  const args: SeedDatasetArgs = {
    manifest: process.env.DATASET_MANIFEST ?? "",
    execute: false,
    plan: false,
    pin: false,
    force: false,
    ipfsApiUrl: process.env.IPFS_API_URL ?? DEFAULT_IPFS_API_URL,
    only: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--manifest":
        args.manifest = requireValue(argv, ++i, arg);
        break;
      case "--execute":
        args.execute = true;
        break;
      case "--plan":
        args.plan = true;
        break;
      case "--pin":
        args.pin = true;
        break;
      case "--force":
        args.force = true;
        break;
      case "--ipfs-api-url":
        args.ipfsApiUrl = requireValue(argv, ++i, arg);
        break;
      case "--only":
        args.only.push(requireValue(argv, ++i, arg));
        break;
      case "--help":
      case "-h":
        throw new Error(usage());
      default:
        throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }

  if (args.execute && args.plan) {
    throw new Error("--execute and --plan are mutually exclusive.");
  }
  return args;
}

export function usage(): string {
  return [
    "Usage:",
    "  yarn hardhat:seed:dataset [--manifest ../datasets/web-games/manifest.json] [--execute --pin]",
    "",
    "Options:",
    "  --manifest <path>       Dataset manifest JSON path. Default: all sibling dataset manifests.",
    "  --execute               Actually pin/write. Without this, the script is a dry-run.",
    "  --plan                  Read chain state and print skip/write actions without pinning/writing.",
    "  --pin                   Pin local files to IPFS and use ipfs:// mirrors.",
    "  --ipfs-api-url <url>    Kubo API base. Default: IPFS_API_URL or http://127.0.0.1:5001/api/v0.",
    "  --only <path>           Seed only one manifest path. Repeatable.",
    "  --force                 Re-seed even if the active contentHash already matches.",
  ].join("\n");
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

export function assertSafeManifestPath(filePath: string): void {
  if (!filePath) throw new Error("Manifest file path must not be empty.");
  if (path.isAbsolute(filePath)) throw new Error(`Manifest file path must be relative: ${filePath}`);

  const normalized = filePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  for (const part of parts) {
    assertCanonicalAnchorSegment(part, `Manifest file path segment in ${filePath}`);
  }
}

export function assertSafeAnchorPath(anchorPath: string): void {
  if (!anchorPath.startsWith("/")) throw new Error(`Manifest anchorPath must start with '/': ${anchorPath}`);
  if (anchorPath === "/") throw new Error("Manifest anchorPath must not be root.");
  if (anchorPath.includes("//")) throw new Error(`Manifest anchorPath must not contain empty segments: ${anchorPath}`);

  for (const segment of anchorPath.split("/").filter(Boolean)) {
    assertCanonicalAnchorSegment(segment, `Manifest anchorPath segment in ${anchorPath}`);
  }
}

export function contentTypeForEntry(entry: DatasetManifestEntry, defaults: DatasetManifestDefaults): string {
  return entry.contentType ?? defaults.contentType ?? "application/octet-stream";
}

export function decideSeedFileAction(args: {
  activePlacement: ActiveDatasetPlacement | null;
  force: boolean;
  localContentHash: string;
  /** `legacyKeccakContentHash(bytes)` of the local file — lets a legacy claim of the SAME
   * bytes be healed in place rather than mistaken for changed content. */
  localLegacyContentHash?: string;
}): SeedFileDecision {
  if (args.force) return { action: "write", reason: "forced" };
  if (!args.activePlacement) return { action: "write", reason: "missing-placement" };
  if (!args.activePlacement.contentHash) return { action: "write", reason: "missing-content-hash" };
  const active = normalizeHash(args.activePlacement.contentHash);
  if (active === normalizeHash(args.localContentHash)) {
    return { action: "skip", reason: "matching-content-hash" };
  }
  // A plain string compare breaks across the format change: every file seeded before it
  // carries `0x`+keccak, which never equals the local `f1220…`, so a re-run would re-pin
  // and re-seed the whole dataset. When the legacy claim is keccak of the SAME local
  // bytes, the content is unchanged — only the claim's form is wrong — so heal it.
  if (args.localLegacyContentHash !== undefined && active === normalizeHash(args.localLegacyContentHash)) {
    return { action: "heal", reason: "legacy-content-hash" };
  }
  return { action: "write", reason: "content-hash-changed" };
}

export function loadDatasetManifest(manifestPath: string): DatasetManifest {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as DatasetManifest;
  if (!manifest.dataset || typeof manifest.dataset !== "string") throw new Error("Manifest missing string 'dataset'.");
  if (!manifest.anchorPath || typeof manifest.anchorPath !== "string") {
    throw new Error("Manifest missing string 'anchorPath'.");
  }
  assertSafeAnchorPath(manifest.anchorPath);
  if (!Array.isArray(manifest.files)) throw new Error("Manifest missing array 'files'.");

  for (const entry of manifest.files) {
    assertSafeManifestPath(entry.path);
  }
  return manifest;
}

export function parseKuboAddResponse(body: string): string {
  const lines = body
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  let hash = "";
  for (const line of lines) {
    const parsed = JSON.parse(line) as { Hash?: string };
    if (parsed.Hash) hash = parsed.Hash;
  }
  if (!hash) throw new Error(`IPFS add response did not include a Hash: ${body.slice(0, 200)}`);
  return hash;
}

export function buildIpfsAddUrl(apiBase: string): URL {
  const trimmed = apiBase.replace(/\/+$/, "");
  const url = new URL(trimmed.endsWith("/add") ? trimmed : `${trimmed}/add`);
  url.searchParams.set("pin", "true");
  url.searchParams.set("cid-version", "1");
  url.searchParams.set("raw-leaves", "true");
  return url;
}

function assertCanonicalAnchorSegment(segment: string, label: string): void {
  if (!segment) throw new Error(`${label} must not be empty.`);
  if (segment === "." || segment === "..") throw new Error(`${label} must not be '.' or '..'.`);

  const bytes = Buffer.from(segment, "utf8");
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    if (byte === 0x25) {
      if (i + 2 >= bytes.length || !isUpperHex(bytes[i + 1]) || !isUpperHex(bytes[i + 2])) {
        throw new Error(`${label} has malformed percent escape: ${segment}`);
      }
      const decoded = (hexNibble(bytes[i + 1]) << 4) | hexNibble(bytes[i + 2]);
      if (!isReservedByte(decoded) && decoded !== 0x25) {
        throw new Error(`${label} has non-canonical percent escape: ${segment}`);
      }
      i += 2;
    } else if (isReservedByte(byte)) {
      throw new Error(`${label} has an unescaped reserved byte: ${segment}`);
    }
  }
}

function normalizeHash(hash: string): string {
  return hash.trim().toLowerCase();
}

function isUpperHex(byte: number): boolean {
  return (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46);
}

function hexNibble(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  return byte - 0x41 + 10;
}

function isReservedByte(byte: number): boolean {
  if (byte < 0x20 || byte === 0x7f) return true;
  return (
    byte === 0x20 ||
    byte === 0x22 ||
    byte === 0x23 ||
    byte === 0x26 ||
    byte === 0x2f ||
    byte === 0x3a ||
    byte === 0x3d ||
    byte === 0x3f ||
    byte === 0x40 ||
    byte === 0x5b ||
    byte === 0x5c ||
    byte === 0x5d ||
    byte === 0x5e ||
    byte === 0x60 ||
    byte === 0x7b ||
    byte === 0x7c ||
    byte === 0x7d
  );
}
