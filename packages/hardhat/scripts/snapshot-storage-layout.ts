import { run } from "hardhat";
import { readLiveLayout, writeSnapshot, snapshotPath } from "../test/helpers/storageLayout";

// Regenerate the committed storage-layout snapshots that gate the 50-year storage-corruption guard
// (test/StorageLayout.gate.test.ts). Run this ONLY after an INTENTIONAL, append-only storage change
// to a guarded resolver (a new sequential slot added at the end). NEVER run it to paper over a
// moved/retyped/removed slot — that is exactly the corruption the gate exists to catch.
//
//   yarn hardhat run scripts/snapshot-storage-layout.ts
//
// Commit the resulting test/__snapshots__/storage-layout/*.json in the same PR as the storage
// change, with an explanation of why the append is layout-safe.

const GUARDED = ["EFSIndexer", "EdgeResolver", "ListEntryResolver"];

async function main() {
  await run("compile");
  for (const name of GUARDED) {
    const layout = readLiveLayout(name);
    writeSnapshot(name, layout);
    console.log(`wrote ${snapshotPath(name)} (${layout.length} sequential slots)`);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
