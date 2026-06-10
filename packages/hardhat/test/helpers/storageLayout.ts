import * as fs from "fs";
import * as path from "path";

// Storage-layout gate for the 50-year storage-corruption guard (test/StorageLayout.gate.test.ts).
//
// The EFS resolvers are upgradeable behind proxies (ADR-0048). Their consensus-critical, append-only
// index mappings (ADR-0009) MUST keep their exact sequential storage slots across every future
// implementation upgrade — a moved or retyped slot silently corrupts the kernel. This helper reads
// the LIVE storage layout the Solidity compiler emitted into Hardhat's build-info (the OZ upgrades
// plugin forces `storageLayout` into outputSelection) and reduces it to a stable, diffable
// fingerprint so a committed snapshot can gate future layout drift.
//
// Why a committed snapshot, not `upgrades.validateUpgrade`? The OZ hardhat-upgrades plugin (3.9.1)
// fights this repo's pattern: every resolver has a non-empty constructor (`SchemaResolver(eas)`
// immutable `_eas`) + `_disableInitializers()`, and the plugin tries to instantiate the
// implementation factory during validation, throwing an ethers-v6 MISSING_ARGUMENT before it ever
// compares layouts. The snapshot approach has no plugin dependency, reads the same compiler output
// `validateUpgrade` would, and is the spec-sanctioned fallback. See test/StorageLayout.gate.test.ts.

export interface SlotEntry {
  slot: string;
  offset: number;
  label: string;
  type: string; // human-readable type label (e.g. "mapping(bytes32 => bytes32[])")
}

// A fingerprint is the ordered list of sequential storage slots, each as `slot.offset label : type`.
// ERC-7201 namespaced structs (efs.*.config, the V2 mock namespaces) live at hashed slots far from
// slot 0 and do NOT appear in this sequential layout — they are layout-safe by construction, so the
// fingerprint only captures the slots an upgrade could actually corrupt.
export type LayoutFingerprint = SlotEntry[];

const BUILD_INFO_DIR = path.join(__dirname, "..", "..", "artifacts", "build-info");

interface RawStorageItem {
  slot: string;
  offset: number;
  label: string;
  type: string;
}

interface RawLayout {
  storage: RawStorageItem[];
  types: Record<string, { label: string }> | null;
}

/**
 * Read the live storage layout for a contract by name from the most recent build-info that
 * contains it. Throws if no build-info carries a storageLayout for the contract (which would
 * itself be a meaningful failure — the gate can't run blind).
 */
export function readLiveLayout(contractName: string): LayoutFingerprint {
  if (!fs.existsSync(BUILD_INFO_DIR)) {
    throw new Error(`No build-info dir at ${BUILD_INFO_DIR} — run \`hardhat compile\` first.`);
  }
  const files = fs
    .readdirSync(BUILD_INFO_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => path.join(BUILD_INFO_DIR, f))
    // newest first, so a fresh recompile wins over a stale build-info
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  for (const file of files) {
    const bi = JSON.parse(fs.readFileSync(file, "utf8"));
    const contracts = bi.output?.contracts ?? {};
    for (const src of Object.keys(contracts)) {
      const c = contracts[src][contractName];
      if (c?.storageLayout?.storage) {
        return normalizeLayout(c.storageLayout as RawLayout);
      }
    }
  }
  throw new Error(`No storageLayout found for "${contractName}" in any build-info.`);
}

function normalizeLayout(layout: RawLayout): LayoutFingerprint {
  const types = layout.types ?? {};
  return layout.storage.map(s => ({
    slot: s.slot,
    offset: s.offset,
    label: s.label,
    // Resolve the type id to its stable human-readable label so the fingerprint survives the
    // compiler's opaque type-id renumbering between builds.
    type: types[s.type]?.label ?? s.type,
  }));
}

/**
 * Compare a live fingerprint against a committed snapshot. Returns a list of human-readable
 * incompatibilities. Empty array = compatible. A future upgrade is compatible iff every slot in
 * the snapshot is preserved (same slot, offset, label, type) AND no existing slot is removed —
 * APPENDING new sequential slots at the end is allowed (additive storage is layout-safe).
 */
export function diffLayout(snapshot: LayoutFingerprint, live: LayoutFingerprint): string[] {
  const problems: string[] = [];

  // Every snapshot slot must be preserved byte-for-byte at the same position.
  for (let i = 0; i < snapshot.length; i++) {
    const want = snapshot[i];
    const got = live[i];
    if (!got) {
      problems.push(`slot[${i}] "${want.label}" (${want.type}) was REMOVED — existing storage truncated.`);
      continue;
    }
    if (got.slot !== want.slot || got.offset !== want.offset) {
      problems.push(`slot[${i}] "${want.label}" MOVED: ${want.slot}.${want.offset} -> ${got.slot}.${got.offset}.`);
    }
    if (got.label !== want.label) {
      problems.push(`slot[${i}] RENAMED: "${want.label}" -> "${got.label}" (slot ${want.slot}).`);
    }
    if (got.type !== want.type) {
      problems.push(`slot[${i}] "${want.label}" RETYPED: ${want.type} -> ${got.type} (slot ${want.slot}).`);
    }
  }
  // live shorter handled above; live longer (appended slots) is allowed.
  return problems;
}

const SNAPSHOT_DIR = path.join(__dirname, "..", "__snapshots__", "storage-layout");

export function snapshotPath(contractName: string): string {
  return path.join(SNAPSHOT_DIR, `${contractName}.json`);
}

export function readSnapshot(contractName: string): LayoutFingerprint {
  return JSON.parse(fs.readFileSync(snapshotPath(contractName), "utf8"));
}

export function writeSnapshot(contractName: string, fingerprint: LayoutFingerprint): void {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  fs.writeFileSync(snapshotPath(contractName), JSON.stringify(fingerprint, null, 2) + "\n");
}
