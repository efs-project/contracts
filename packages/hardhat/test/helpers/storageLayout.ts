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

// ==============================================================================================
// NAMESPACE LAYOUT — ERC-7201 config-struct fingerprint (the gap the sequential gate misses).
// ==============================================================================================
//
// The sequential gate above (readLiveLayout/diffLayout) only sees the `storageLayout.storage`
// slots starting at slot 0. The EFS contracts keep ALL their per-deployment authority state
// (schema UIDs, partner refs, owner-set flags, the module list) in ERC-7201 NAMESPACED structs
// (`efs.*.config`) reached via an assembly `$.slot := CONSTANT`. Those struct fields live at a
// hashed slot far from slot 0 and therefore do NOT appear in `storageLayout.storage` at all —
// they are invisible to the sequential gate. A future V2 could reorder, retype, or remove a field
// inside `IndexerConfig`/`EdgeConfig`/etc. and the sequential fingerprint would still pass while
// proxies read schema UIDs / owners / seal flags from the WRONG offsets.
//
// This fingerprint closes that gap. It reads the Solidity AST (not `storageLayout`) from the same
// build-info, finds the config StructDefinition(s) by their `@custom:storage-location erc7201:`
// doc-string, and captures the ORDERED `{ name, type }` of their members. ERC-7201 structs pack
// the same way sequential storage does, so the additive-append rule (diffNamespaceLayout below)
// is the same upgrade-safety invariant applied to the namespaced layer.

export interface NamespaceField {
  name: string;
  type: string; // the AST typeString, e.g. "mapping(address => bool)", "bool", "address[]"
}

// One entry per config struct found on the contract (a contract may declare more than one
// namespaced config). `struct` is the Solidity struct name; `fields` is its ordered member list.
export interface NamespaceStructFingerprint {
  struct: string;
  fields: NamespaceField[];
}

export type NamespaceLayoutFingerprint = NamespaceStructFingerprint[];

// The doc-string marker the OZ ERC-7201 convention stamps on a namespaced config struct. The
// doc-string is the most reliable "this is a guarded config struct" signal (more robust than a
// name heuristic), so we resolve the guarded structs off it.
const ERC7201_DOC_MARKER = "@custom:storage-location erc7201:";

interface AstNode {
  nodeType?: string;
  name?: string;
  nodes?: AstNode[];
  members?: AstNode[];
  documentation?: { text?: string } | string | null;
  typeDescriptions?: { typeString?: string };
}

function docText(documentation: AstNode["documentation"]): string {
  if (!documentation) return "";
  return typeof documentation === "string" ? documentation : (documentation.text ?? "");
}

/**
 * Read the ordered ERC-7201 config-struct fingerprint for a contract by name from the most recent
 * build-info that carries its AST. Scopes resolution to the contract's own `ContractDefinition`
 * node (so e.g. a same-named struct in another contract can't leak in), then selects the struct(s)
 * carrying the `@custom:storage-location erc7201:` doc and reads their members in source order.
 *
 * Throws if no build-info carries an AST for the contract, or the contract declares no namespaced
 * config struct (both are meaningful failures — a guarded contract is expected to have one, and
 * the gate must not silently pass on a contract whose config struct vanished).
 */
export function readLiveNamespaceLayout(contractName: string): NamespaceLayoutFingerprint {
  if (!fs.existsSync(BUILD_INFO_DIR)) {
    throw new Error(`No build-info dir at ${BUILD_INFO_DIR} — run \`hardhat compile\` first.`);
  }
  const files = fs
    .readdirSync(BUILD_INFO_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => path.join(BUILD_INFO_DIR, f))
    // newest first, so a fresh recompile wins over a stale build-info (mirrors readLiveLayout)
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  for (const file of files) {
    const bi = JSON.parse(fs.readFileSync(file, "utf8"));
    const sources: Record<string, { ast?: AstNode }> = bi.output?.sources ?? {};
    for (const src of Object.keys(sources)) {
      const ast = sources[src]?.ast;
      if (!ast || !Array.isArray(ast.nodes)) continue;
      for (const node of ast.nodes) {
        if (node.nodeType !== "ContractDefinition" || node.name !== contractName) continue;
        const structs: NamespaceLayoutFingerprint = [];
        for (const child of node.nodes ?? []) {
          if (child.nodeType !== "StructDefinition") continue;
          if (!docText(child.documentation).includes(ERC7201_DOC_MARKER)) continue;
          structs.push({
            struct: child.name ?? "",
            fields: (child.members ?? []).map(m => ({
              name: m.name ?? "",
              type: m.typeDescriptions?.typeString ?? "",
            })),
          });
        }
        if (structs.length > 0) return structs;
        throw new Error(`"${contractName}" has no ERC-7201 (\`${ERC7201_DOC_MARKER}…\`) config struct in its AST.`);
      }
    }
  }
  throw new Error(`No AST found for "${contractName}" in any build-info — run \`hardhat compile\`.`);
}

/**
 * Compare a live namespace fingerprint against a committed snapshot. Returns a list of
 * human-readable incompatibilities; empty array = compatible. SAME additive rule as diffLayout:
 * every snapshotted struct must still exist, and every snapshotted field must be preserved
 * byte-for-byte at the same index (name + type) — no field removed, retyped, or reordered.
 * APPENDING new fields at the END of a struct is allowed (additive namespaced storage is
 * upgrade-safe, exactly like appending a sequential slot). Appending a wholly new config struct
 * is likewise allowed.
 */
export function diffNamespaceLayout(snapshot: NamespaceLayoutFingerprint, live: NamespaceLayoutFingerprint): string[] {
  const problems: string[] = [];
  const liveByName = new Map(live.map(s => [s.struct, s]));

  for (const want of snapshot) {
    const got = liveByName.get(want.struct);
    if (!got) {
      problems.push(`config struct "${want.struct}" was REMOVED — namespaced storage truncated.`);
      continue;
    }
    for (let i = 0; i < want.fields.length; i++) {
      const wantField = want.fields[i];
      const gotField = got.fields[i];
      if (!gotField) {
        problems.push(
          `${want.struct}.field[${i}] "${wantField.name}" (${wantField.type}) was REMOVED — existing namespaced storage truncated.`,
        );
        continue;
      }
      if (gotField.name !== wantField.name) {
        problems.push(`${want.struct}.field[${i}] RENAMED/REORDERED: "${wantField.name}" -> "${gotField.name}".`);
      }
      if (gotField.type !== wantField.type) {
        problems.push(`${want.struct}.field[${i}] "${wantField.name}" RETYPED: ${wantField.type} -> ${gotField.type}.`);
      }
    }
    // got longer (appended fields) is allowed.
  }
  // live with extra structs (appended config structs) is allowed.
  return problems;
}

export function namespaceSnapshotPath(contractName: string): string {
  return path.join(SNAPSHOT_DIR, `${contractName}.namespace.json`);
}

export function readNamespaceSnapshot(contractName: string): NamespaceLayoutFingerprint {
  return JSON.parse(fs.readFileSync(namespaceSnapshotPath(contractName), "utf8"));
}

export function writeNamespaceSnapshot(contractName: string, fingerprint: NamespaceLayoutFingerprint): void {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  fs.writeFileSync(namespaceSnapshotPath(contractName), JSON.stringify(fingerprint, null, 2) + "\n");
}
