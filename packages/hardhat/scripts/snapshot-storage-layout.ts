import { run } from "hardhat";
import {
  readLiveLayout,
  writeSnapshot,
  snapshotPath,
  readLiveNamespaceLayout,
  writeNamespaceSnapshot,
  namespaceSnapshotPath,
} from "../test/helpers/storageLayout";

// Regenerate the committed storage-layout snapshots that gate the 50-year storage-corruption guard
// (test/StorageLayout.gate.test.ts). Run this ONLY after an INTENTIONAL, append-only storage change
// to a guarded resolver (a new sequential slot added at the end, OR a new field appended at the END
// of an ERC-7201 config struct). NEVER run it to paper over a moved/retyped/removed slot or config
// field — that is exactly the corruption the gate exists to catch.
//
//   yarn hardhat run scripts/snapshot-storage-layout.ts
//
// Two snapshot families per contract:
//   - <Contract>.json           — sequential slots (slot 0 onward), the storageLayout fingerprint.
//   - <Contract>.namespace.json — ordered fields of the ERC-7201 config struct(s), the AST
//                                 fingerprint. Catches reorders/retypes inside efs.*.config that
//                                 the sequential fingerprint can't see.
//
// Commit the resulting test/__snapshots__/storage-layout/*.json in the same PR as the storage
// change, with an explanation of why the append is layout-safe.

const GUARDED = ["EFSIndexer", "EdgeResolver", "ListEntryResolver", "MirrorResolver", "SystemAccount"];

// Contracts with an ERC-7201 namespaced config struct guarded by the namespace gate. Superset of
// GUARDED: AliasResolver carries all its per-deployment state in efs.alias.config (no sequential
// slots), so it has a namespace snapshot but no sequential one.
const NAMESPACE_GUARDED = [...GUARDED, "AliasResolver"];

async function main() {
  await run("compile");
  for (const name of GUARDED) {
    const layout = readLiveLayout(name);
    writeSnapshot(name, layout);
    console.log(`wrote ${snapshotPath(name)} (${layout.length} sequential slots)`);
  }
  for (const name of NAMESPACE_GUARDED) {
    const layout = readLiveNamespaceLayout(name);
    const fieldCount = layout.reduce((n, s) => n + s.fields.length, 0);
    writeNamespaceSnapshot(name, layout);
    console.log(`wrote ${namespaceSnapshotPath(name)} (${layout.length} config struct(s), ${fieldCount} fields)`);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
