import { expect } from "chai";
import { run } from "hardhat";
import { readLiveLayout, readSnapshot, diffLayout, snapshotPath, LayoutFingerprint } from "./helpers/storageLayout";
import * as fs from "fs";

/**
 * STORAGE-LAYOUT GATE (static half of the 50-year storage-corruption guard) — ADR-0048, ADR-0009.
 *
 * The runtime guard (test/UpgradeWithState.test.ts) proves a *specific* layout-safe V2 upgrade
 * preserves state. This static gate proves the COMPLEMENT: a future implementation that moves,
 * retypes, or removes any existing sequential storage slot FAILS in CI before it can ship.
 *
 * Approach: committed storage-layout snapshot (not `upgrades.validateUpgrade`).
 *
 * Why not the OZ plugin? `@openzeppelin/hardhat-upgrades` (3.9.1) fights this repo's pattern: every
 * resolver has a non-empty constructor (`SchemaResolver(eas)` immutable `_eas`) +
 * `_disableInitializers()`, and the plugin tries to instantiate the implementation factory during
 * `validateUpgrade`/`validateImplementation`, throwing an ethers-v6 `MISSING_ARGUMENT` (constructor
 * needs the EAS arg) before it ever reaches the layout comparison — even with
 * `unsafeAllow: ['constructor','state-variable-immutable']`. The committed-snapshot approach reads
 * the SAME compiler `storageLayout` output the plugin would, has zero plugin dependency, and is the
 * spec-sanctioned fallback. The OZ plugin remains wired in hardhat.config for other uses; we just
 * don't route the layout gate through it.
 *
 * To regenerate the snapshots after an INTENTIONAL append-only change (e.g. adding a new sequential
 * slot at the end), run `yarn hardhat run scripts/snapshot-storage-layout.ts`.
 */

const GUARDED = ["EFSIndexer", "EdgeResolver", "ListEntryResolver"] as const;

describe("StorageLayout gate — append-only kernel slots are frozen (ADR-0009, ADR-0048)", function () {
  before(async function () {
    // Ensure artifacts/build-info is fresh so the live layout reflects current source.
    await run("compile");
  });

  for (const name of GUARDED) {
    it(`${name}: live sequential storage layout matches the committed snapshot`, function () {
      expect(
        fs.existsSync(snapshotPath(name)),
        `missing snapshot for ${name} — run scripts/snapshot-storage-layout.ts`,
      ).to.equal(true);
      const snapshot = readSnapshot(name);
      const live = readLiveLayout(name);
      const problems = diffLayout(snapshot, live);
      expect(problems, `storage layout drift in ${name}:\n  ${problems.join("\n  ")}`).to.deep.equal([]);
    });
  }

  it("the V2 mock impls are APPEND-compatible with their V1 snapshots (no slot moved/retyped)", function () {
    const pairs: [string, string][] = [
      ["EFSIndexer", "MockEFSIndexerV2"],
      ["EdgeResolver", "MockEdgeResolverV2"],
      ["ListEntryResolver", "MockListEntryResolverV2"],
    ];
    for (const [v1, v2] of pairs) {
      const problems = diffLayout(readSnapshot(v1), readLiveLayout(v2));
      expect(problems, `${v2} is layout-incompatible with ${v1}:\n  ${problems.join("\n  ")}`).to.deep.equal([]);
    }
  });

  describe("the gate REJECTS incompatible layout changes (negative proof)", function () {
    // The comparator must catch every flavor of corruption. We perturb a *copy* of the real live
    // layout to simulate a bad future edit and assert each perturbation is flagged. This exercises
    // the exact comparator that gates CI, on the real kernel layout — without committing a broken
    // contract to the repo.

    function corrupt(name: string, mutate: (l: LayoutFingerprint) => LayoutFingerprint): string[] {
      const snapshot = readSnapshot(name);
      const mutated = mutate(structuredClone(snapshot));
      return diffLayout(snapshot, mutated);
    }

    it("rejects a RETYPED sequential mapping (e.g. _isRevoked bool -> uint256)", function () {
      const problems = corrupt("EFSIndexer", l => {
        const i = l.findIndex(s => s.label === "_isRevoked");
        l[i] = { ...l[i], type: "mapping(bytes32 => uint256)" };
        return l;
      });
      expect(problems.some(p => /RETYPED/.test(p))).to.equal(true);
    });

    it("rejects REORDERED sequential slots (two adjacent kernel mappings swapped)", function () {
      const problems = corrupt("EdgeResolver", l => {
        // Swap the labels/types at slots 0 and 1 (e.g. _activeEdge <-> _activeCount).
        const a = l[0];
        const b = l[1];
        l[0] = { ...a, label: b.label, type: b.type };
        l[1] = { ...b, label: a.label, type: a.type };
        return l;
      });
      // A reorder shows up as RENAMED/RETYPED at the affected positions.
      expect(problems.length).to.be.greaterThan(0);
    });

    it("rejects a REMOVED sequential slot (existing storage truncated)", function () {
      const problems = corrupt("ListEntryResolver", l => l.slice(0, -1));
      expect(problems.some(p => /REMOVED/.test(p))).to.equal(true);
    });

    it("ALLOWS appending a new sequential slot at the end (additive storage is safe)", function () {
      const problems = corrupt("ListEntryResolver", l => {
        l.push({ slot: String(l.length), offset: 0, label: "_v2NewMapping", type: "mapping(bytes32 => uint256)" });
        return l;
      });
      expect(problems).to.deep.equal([]);
    });
  });
});
