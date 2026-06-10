import { expect } from "chai";
import { ethers } from "hardhat";
import { EdgeResolver, EFSIndexer, EAS, SchemaRegistry } from "../typechain-types";
import { Signer, ZeroAddress } from "ethers";

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const NO_EXPIRATION = 0n;

/**
 * EdgeResolver — TAG schema (cardinality N).
 *
 * TAG is the list edge: many active TAGs per (attester, definition, targetSchema)
 * slot, one entry per distinct (attester, target, definition) edgeHash. Each entry
 * carries an int256 weight (generic per-entry metadata for sort, score, ranking).
 *
 * Re-attesting the same edgeHash updates UID + weight in place; a new edgeHash
 * appends a new entry. Removal is via eas.revoke() (no `applies=false`).
 *
 * Key invariants exercised here (per ADR-0041):
 *   - TAGs at distinct edgeHashes accumulate (regression gate for folder visibility,
 *     schema-alias discovery — the use cases where Shape B is correct).
 *   - Weight magnitude is preserved through getActiveTagEntries (returned in the
 *     same bulk SLOAD, no N+1 lookup).
 *   - Re-attesting at the same edgeHash updates weight in place (no accumulation).
 *   - Revoking the active TAG entry swap-and-pops it out of the slot.
 *   - Cross-attester isolation.
 *   - Smart-contract read shape: `getActiveTagEntries` is a list — for iteration.
 */
describe("EdgeResolver — TAG", function () {
  let edgeResolver: EdgeResolver;
  let indexer: EFSIndexer;
  let eas: EAS;
  let registry: SchemaRegistry;
  let owner: Signer;
  let user1: Signer;
  let user2: Signer;

  let pinSchemaUID: string;
  let tagSchemaUID: string;
  let dummySchemaUID: string;

  const enc = new ethers.AbiCoder();
  const encodeTag = (definition: string, weight: bigint) => enc.encode(["bytes32", "int256"], [definition, weight]);

  // ─── Setup ─────────────────────────────────────────────────────────────────

  beforeEach(async function () {
    [owner, user1, user2] = await ethers.getSigners();

    const RegistryFactory = await ethers.getContractFactory("SchemaRegistry");
    registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();

    const EASFactory = await ethers.getContractFactory("EAS");
    eas = await EASFactory.deploy(await registry.getAddress());
    await eas.waitForDeployment();

    const ownerAddr = await owner.getAddress();
    const resolverNonce = await ethers.provider.getTransactionCount(ownerAddr);
    const futureEdgeResolverAddress = ethers.getCreateAddress({ from: ownerAddr, nonce: resolverNonce });
    const futureIndexerAddress = ethers.getCreateAddress({ from: ownerAddr, nonce: resolverNonce + 4 });
    const precomputedPinSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      ["bytes32 definition", futureEdgeResolverAddress, true],
    );
    const precomputedTagSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      ["bytes32 definition, int256 weight", futureEdgeResolverAddress, true],
    );

    const EdgeResolverFactory = await ethers.getContractFactory("EdgeResolver");
    edgeResolver = await EdgeResolverFactory.deploy(
      await eas.getAddress(),
      precomputedPinSchemaUID,
      precomputedTagSchemaUID,
      futureIndexerAddress,
      await registry.getAddress(),
    );
    await edgeResolver.waitForDeployment();

    const pinSchemaTx = await registry.register("bytes32 definition", await edgeResolver.getAddress(), true);
    pinSchemaUID = (await pinSchemaTx.wait())!.logs[0].topics[1];

    const tagSchemaTx = await registry.register(
      "bytes32 definition, int256 weight",
      await edgeResolver.getAddress(),
      true,
    );
    tagSchemaUID = (await tagSchemaTx.wait())!.logs[0].topics[1];

    const dummySchemaTx = await registry.register("string label", ZeroAddress, false);
    dummySchemaUID = (await dummySchemaTx.wait())!.logs[0].topics[1];

    const IndexerFactory = await ethers.getContractFactory("EFSIndexer");
    indexer = await IndexerFactory.deploy(await eas.getAddress(), ZERO_BYTES32, ZERO_BYTES32, ZERO_BYTES32);
    await indexer.waitForDeployment();
    expect(await indexer.getAddress()).to.equal(futureIndexerAddress);

    await indexer.wireContracts(
      await edgeResolver.getAddress(),
      pinSchemaUID,
      tagSchemaUID,
      ZeroAddress,
      ZERO_BYTES32,
      ZeroAddress,
      ZERO_BYTES32,
      await registry.getAddress(),
    );
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  const getUID = (receipt: any): string => {
    const iface = eas.interface;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed?.name === "Attested") return parsed.args.uid;
      } catch {
        /* ignore */
      }
    }
    throw new Error("No Attested event found in receipt");
  };

  const createTarget = async (label = "target"): Promise<string> => {
    const tx = await eas.attest({
      schema: dummySchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: ZERO_BYTES32,
        data: enc.encode(["string"], [label]),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  const createDefinition = async (label = "def"): Promise<string> => createTarget(label);

  const tagByRef = async (signer: Signer, targetUID: string, definition: string, weight: bigint): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: tagSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: targetUID,
        data: encodeTag(definition, weight),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  const tagByAddress = async (
    signer: Signer,
    recipient: string,
    definition: string,
    weight: bigint,
  ): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: tagSchemaUID,
      data: {
        recipient,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: ZERO_BYTES32,
        data: encodeTag(definition, weight),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  const revokeTag = async (signer: Signer, uid: string) => {
    const tx = await eas.connect(signer).revoke({ schema: tagSchemaUID, data: { uid, value: 0n } });
    await tx.wait();
  };

  // ─── Basic attesting ───────────────────────────────────────────────────────

  describe("Basic attesting", function () {
    it("Should accept a TAG with a positive weight targeting a real refUID", async function () {
      const definition = await createDefinition("favs");
      const target = await createTarget("file-1");
      const u1Addr = await user1.getAddress();

      const tagUID = await tagByRef(user1, target, definition, 1n);
      expect(tagUID).to.not.equal(ZERO_BYTES32);

      const entries = await edgeResolver.getActiveTagEntries(definition, u1Addr, dummySchemaUID, 0n, 10n);
      expect(entries.length).to.equal(1);
      expect(entries[0].tagUID).to.equal(tagUID);
      expect(entries[0].weight).to.equal(1n);
    });

    it("Should accept a TAG with weight = 0 (neutral metadata)", async function () {
      const definition = await createDefinition("zero-weight");
      const target = await createTarget("zw-target");
      const u1Addr = await user1.getAddress();

      const tagUID = await tagByRef(user1, target, definition, 0n);
      const entries = await edgeResolver.getActiveTagEntries(definition, u1Addr, dummySchemaUID, 0n, 10n);
      expect(entries.length).to.equal(1);
      expect(entries[0].tagUID).to.equal(tagUID);
      expect(entries[0].weight).to.equal(0n);
    });

    it("Should accept a TAG with a negative weight (generic metadata, not supersede)", async function () {
      // ADR-0041: there is no supersede-via-negative-weight. A negative weight is just
      // generic per-entry metadata; the entry is still active.
      const definition = await createDefinition("neg-weight");
      const target = await createTarget("neg-target");
      const u1Addr = await user1.getAddress();

      const tagUID = await tagByRef(user1, target, definition, -42n);
      const entries = await edgeResolver.getActiveTagEntries(definition, u1Addr, dummySchemaUID, 0n, 10n);
      expect(entries.length).to.equal(1);
      expect(entries[0].tagUID).to.equal(tagUID);
      expect(entries[0].weight).to.equal(-42n);
      // The aggregate counter still sees this as active (existence ≠ ranking).
      expect(await edgeResolver.hasActiveEdge(target, definition)).to.be.true;
    });

    // ── ADR-0042: active vs effective ───────────────────────────────────────────
    // "active TAG"   = unrevoked edge (kernel semantic — contracts, ADR-0041 §4).
    // "effective TAG" = active TAG with weight >= 0 (client-layer convention for
    //                  the explorer descriptive-label filter — ADR-0042).
    // These tests verify the contract side: negative-weight and zero-weight TAGs
    // are still active (kernel). The client-side filter (weight >= 0) is layered
    // on top in FileBrowser.resolveTagSet.
    it("ADR-0042: negative-weight TAG is still contract-active (not suppressed at kernel)", async function () {
      const definition = await createDefinition("active-vs-effective");
      const tNeg = await createTarget("eff-neg");
      const tZero = await createTarget("eff-zero");
      const tPos = await createTarget("eff-pos");
      const u1Addr = await user1.getAddress();

      await tagByRef(user1, tNeg, definition, -5n);
      await tagByRef(user1, tZero, definition, 0n);
      await tagByRef(user1, tPos, definition, 3n);

      // All three are active at the kernel level.
      expect(await edgeResolver.hasActiveEdge(tNeg, definition)).to.be.true;
      expect(await edgeResolver.hasActiveEdge(tZero, definition)).to.be.true;
      expect(await edgeResolver.hasActiveEdge(tPos, definition)).to.be.true;

      const entries = await edgeResolver.getActiveTagEntries(definition, u1Addr, dummySchemaUID, 0n, 10n);
      expect(entries.length).to.equal(3);

      // Client-layer effective filter simulation (ADR-0042): weight >= 0n only.
      // tZero and tPos pass; tNeg is suppressed.
      const effectiveWeights = entries.filter(e => e.weight >= 0n).map(e => e.weight);
      expect(effectiveWeights.length).to.equal(2);
      const negWeights = entries.filter(e => e.weight < 0n);
      expect(negWeights.length).to.equal(1);
      expect(negWeights[0].weight).to.equal(-5n);
    });

    // ── ADR-0042 bucket-key regression ──────────────────────────────────────────
    // This test guards the FileBrowser.resolveTagSet fix: _activeByAAS is keyed by
    // TARGET schema (the schema of the tagged thing), not by TAG_SCHEMA_UID.
    // Querying the wrong bucket (tagSchemaUID) returns empty; the correct bucket
    // (dummySchemaUID here, corresponding to DATA_SCHEMA_UID or ANCHOR_SCHEMA_UID
    // in production) returns the entries.
    it("ADR-0042 bucket fix: getActiveTagEntries uses TARGET schema, not TAG_SCHEMA_UID", async function () {
      const def = await createDefinition("bucket-fix");
      const fileTarget = await createTarget("file-1"); // simulates a DATA attestation
      const folderTarget = await createTarget("folder-1"); // simulates an ANCHOR attestation
      const u1Addr = await user1.getAddress();

      // Tag both targets (both live under dummySchemaUID = simulated DATA/ANCHOR schema).
      await tagByRef(user1, fileTarget, def, 1n); // effective (weight >= 0)
      await tagByRef(user1, folderTarget, def, 1n); // effective (weight >= 0)

      // Correct bucket: dummySchemaUID (target's schema) → returns both entries.
      const correctEntries = await edgeResolver.getActiveTagEntries(def, u1Addr, dummySchemaUID, 0n, 10n);
      expect(correctEntries.length).to.equal(2);

      // Wrong bucket: tagSchemaUID → always empty (tags are never stored there).
      const wrongEntries = await edgeResolver.getActiveTagEntries(def, u1Addr, tagSchemaUID, 0n, 10n);
      expect(wrongEntries.length).to.equal(0);

      // Correct target resolution.
      const resolvedTargets = await edgeResolver.getActiveTargetsByAttesterAndSchema(
        def,
        u1Addr,
        dummySchemaUID,
        0n,
        10n,
      );
      expect(resolvedTargets.length).to.equal(2);
      expect(resolvedTargets.map((t: string) => t.toLowerCase())).to.include(fileTarget.toLowerCase());
      expect(resolvedTargets.map((t: string) => t.toLowerCase())).to.include(folderTarget.toLowerCase());
    });

    it("ADR-0042 effective filter: negative-weight DATA-target TAG excluded; zero/positive included", async function () {
      const def = await createDefinition("eff-filter-data");
      const fileIncluded = await createTarget("file-included");
      const fileZeroW = await createTarget("file-zero-weight");
      const fileExcluded = await createTarget("file-excluded");
      const u1Addr = await user1.getAddress();

      await tagByRef(user1, fileIncluded, def, 3n); // effective (weight = 3 >= 0)
      await tagByRef(user1, fileZeroW, def, 0n); // effective (weight = 0 >= 0)
      await tagByRef(user1, fileExcluded, def, -1n); // suppressed (weight < 0) — still active!

      // All three active at kernel level.
      expect(await edgeResolver.hasActiveEdge(fileIncluded, def)).to.be.true;
      expect(await edgeResolver.hasActiveEdge(fileZeroW, def)).to.be.true;
      expect(await edgeResolver.hasActiveEdge(fileExcluded, def)).to.be.true;

      // Client-side effective filter simulation (query correct bucket, filter weight >= 0n).
      const entries = await edgeResolver.getActiveTagEntries(def, u1Addr, dummySchemaUID, 0n, 10n);
      const targets = await edgeResolver.getActiveTargetsByAttesterAndSchema(def, u1Addr, dummySchemaUID, 0n, 10n);
      expect(entries.length).to.equal(3);

      const effectiveTargets: string[] = [];
      for (let i = 0; i < entries.length; i++) {
        if (entries[i].weight >= 0n) effectiveTargets.push(targets[i].toLowerCase());
      }
      expect(effectiveTargets).to.include(fileIncluded.toLowerCase());
      expect(effectiveTargets).to.include(fileZeroW.toLowerCase());
      expect(effectiveTargets).to.not.include(fileExcluded.toLowerCase());
    });

    it("Should revert InvalidDefinition when definition is bytes32(0)", async function () {
      const target = await createTarget("zero-def-target");
      await expect(
        eas.attest({
          schema: tagSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: target,
            data: encodeTag(ethers.ZeroHash, 1n),
            value: 0n,
          },
        }),
      ).to.be.revertedWithCustomError(edgeResolver, "InvalidDefinition");
    });

    it("Should revert MustTargetSomething when both refUID and recipient are zero", async function () {
      const definition = await createDefinition("must-target");
      await expect(
        eas.attest({
          schema: tagSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: ZERO_BYTES32,
            data: encodeTag(definition, 1n),
            value: 0n,
          },
        }),
      ).to.be.revertedWithCustomError(edgeResolver, "MustTargetSomething");
    });

    it("Should resolve target via recipient address when refUID is zero", async function () {
      const definition = await createDefinition("addr-target");
      const recipientAddr = await user2.getAddress();
      const u1Addr = await user1.getAddress();

      const tagUID = await tagByAddress(user1, recipientAddr, definition, 9n);
      // ADR-0041 §2: recipient targeting is first-class. The kernel uses
      // `targetSchema = bytes32(0)` as the canonical sentinel for address targets
      // (addresses don't have an attestation UID, so there is no real schema to
      // record). All cardinality-specific reads — `_activeBySlot`/`_activeByAAS` —
      // accept this sentinel and route address-target entries to it.
      const targetID = ethers.zeroPadValue(recipientAddr, 32);
      expect(await edgeResolver.hasActiveEdge(targetID, definition)).to.be.true;
      // Schema-aware existence read sees the edge.
      expect(await edgeResolver.isActiveEdge(u1Addr, targetID, definition, tagSchemaUID)).to.be.true;
      // Cardinality-N read at the address-target slot returns the entry with its weight.
      const entries = await edgeResolver.getActiveTagEntries(definition, u1Addr, ZERO_BYTES32, 0n, 10n);
      expect(entries.length).to.equal(1);
      expect(entries[0].tagUID).to.equal(tagUID);
      expect(entries[0].weight).to.equal(9n);
      expect(await edgeResolver.getActiveTagsCount(definition, u1Addr, ZERO_BYTES32)).to.equal(1n);
      // tagUID returned by attestation is non-zero.
      expect(tagUID).to.not.equal(ZERO_BYTES32);
    });
  });

  // ─── TAG accumulation (the headline feature) ──────────────────────────────

  describe("TAG accumulation (cardinality N)", function () {
    it("Should accumulate TAGs at distinct edgeHashes from one attester", async function () {
      // Folder visibility / schema-alias discovery: many entries at the same
      // (attester, def, targetSchema) slot, one per distinct target.
      const definition = await createDefinition("folder-vis");
      const t1 = await createTarget("folder-A");
      const t2 = await createTarget("folder-B");
      const t3 = await createTarget("folder-C");
      const u1Addr = await user1.getAddress();

      const uid1 = await tagByRef(user1, t1, definition, 1n);
      const uid2 = await tagByRef(user1, t2, definition, 1n);
      const uid3 = await tagByRef(user1, t3, definition, 1n);

      const entries = await edgeResolver.getActiveTagEntries(definition, u1Addr, dummySchemaUID, 0n, 10n);
      expect(entries.length).to.equal(3);
      const uids = entries.map(e => e.tagUID);
      expect(uids).to.include(uid1).and.to.include(uid2).and.to.include(uid3);

      expect(await edgeResolver.getActiveTagsCount(definition, u1Addr, dummySchemaUID)).to.equal(3n);
    });

    it("Should update weight in place when re-attesting at the same edgeHash", async function () {
      // Same (attester, target, def) → same edgeHash → in-place update, no accumulation.
      const definition = await createDefinition("rebind-weight");
      const target = await createTarget("rebind-tgt");
      const u1Addr = await user1.getAddress();

      const uid1 = await tagByRef(user1, target, definition, 1n);
      let entries = await edgeResolver.getActiveTagEntries(definition, u1Addr, dummySchemaUID, 0n, 10n);
      expect(entries.length).to.equal(1);
      expect(entries[0].weight).to.equal(1n);

      const uid2 = await tagByRef(user1, target, definition, 5n);
      expect(uid1).to.not.equal(uid2);

      entries = await edgeResolver.getActiveTagEntries(definition, u1Addr, dummySchemaUID, 0n, 10n);
      expect(entries.length).to.equal(1);
      expect(entries[0].tagUID).to.equal(uid2);
      expect(entries[0].weight).to.equal(5n);
    });
  });

  // ─── Weight semantics ──────────────────────────────────────────────────────

  describe("Weight semantics", function () {
    it("Should preserve weight magnitude across getActiveTagEntries (single bulk SLOAD)", async function () {
      // ADR-0041 promise: weight returned inline so on-chain consumers can sort
      // without an N+1 SLOAD pattern. This test asserts the (uid, weight) tuples
      // come back paired correctly.
      const definition = await createDefinition("weighted");
      const t5 = await createTarget("w-5");
      const t1 = await createTarget("w-1");
      const t9 = await createTarget("w-9");
      const u1Addr = await user1.getAddress();

      const uid5 = await tagByRef(user1, t5, definition, 5n);
      const uid1 = await tagByRef(user1, t1, definition, 1n);
      const uid9 = await tagByRef(user1, t9, definition, 9n);

      const entries = await edgeResolver.getActiveTagEntries(definition, u1Addr, dummySchemaUID, 0n, 10n);
      expect(entries.length).to.equal(3);

      const byUid: Record<string, bigint> = {};
      for (const e of entries) byUid[e.tagUID] = e.weight;
      expect(byUid[uid5]).to.equal(5n);
      expect(byUid[uid1]).to.equal(1n);
      expect(byUid[uid9]).to.equal(9n);

      // Confirm a sort overlay using getActiveTagEntries can sort correctly.
      const sorted = [...entries].sort((a, b) => Number(a.weight - b.weight));
      expect(sorted.map(e => e.weight)).to.deep.equal([1n, 5n, 9n]);
      expect(sorted.map(e => e.tagUID)).to.deep.equal([uid1, uid5, uid9]);
    });

    it("Should support arbitrary int256 range for weight (positive and negative)", async function () {
      // No clamping — negative weights are valid metadata; signed range is preserved.
      const definition = await createDefinition("int256-range");
      const tHigh = await createTarget("high");
      const tLow = await createTarget("low");
      const tZero = await createTarget("zero");
      const u1Addr = await user1.getAddress();

      const big = (1n << 200n) - 1n;
      await tagByRef(user1, tHigh, definition, big);
      await tagByRef(user1, tLow, definition, -big);
      await tagByRef(user1, tZero, definition, 0n);

      const entries = await edgeResolver.getActiveTagEntries(definition, u1Addr, dummySchemaUID, 0n, 10n);
      expect(entries.length).to.equal(3);
      const weights = entries.map(e => e.weight).sort((a, b) => Number(a - b));
      expect(weights).to.deep.equal([-big, 0n, big]);
    });
  });

  // ─── Bulk-read shape (no N+1 SLOAD) ────────────────────────────────────────

  describe("Bulk-read shape", function () {
    it("Should return TagEntry tuples directly (no per-entry side-map fetch needed)", async function () {
      // We can't introspect SLOAD count from chai, but we CAN assert that the API
      // returns weight INLINE with the tagUID — which is the structural property
      // ADR-0041 promises (no N+1 SLOAD because there is no side weight map).
      const definition = await createDefinition("bulk-shape");
      const u1Addr = await user1.getAddress();
      for (let i = 0; i < 12; i++) {
        const t = await createTarget(`bulk-${i}`);
        await tagByRef(user1, t, definition, BigInt(i * 3));
      }

      const entries = await edgeResolver.getActiveTagEntries(definition, u1Addr, dummySchemaUID, 0n, 100n);
      expect(entries.length).to.equal(12);
      // Each entry has both fields populated in one read — no follow-up call required.
      for (const e of entries) {
        expect(e.tagUID).to.not.equal(ZERO_BYTES32);
        // weight may legitimately be 0 (first entry); type check via .toString().
        expect(typeof e.weight).to.equal("bigint");
      }
    });

    it("Should paginate getActiveTagEntries with start + length", async function () {
      const definition = await createDefinition("paginate");
      const u1Addr = await user1.getAddress();
      for (let i = 0; i < 7; i++) {
        const t = await createTarget(`pg-${i}`);
        await tagByRef(user1, t, definition, BigInt(i));
      }

      const page1 = await edgeResolver.getActiveTagEntries(definition, u1Addr, dummySchemaUID, 0n, 3n);
      expect(page1.length).to.equal(3);

      const page2 = await edgeResolver.getActiveTagEntries(definition, u1Addr, dummySchemaUID, 3n, 3n);
      expect(page2.length).to.equal(3);

      const page3 = await edgeResolver.getActiveTagEntries(definition, u1Addr, dummySchemaUID, 6n, 3n);
      expect(page3.length).to.equal(1);

      const empty = await edgeResolver.getActiveTagEntries(definition, u1Addr, dummySchemaUID, 10n, 3n);
      expect(empty.length).to.equal(0);
    });

    it("Should expose getActiveTags as a backward-compatible bytes32[] view", async function () {
      const definition = await createDefinition("bc-array");
      const u1Addr = await user1.getAddress();
      const uids: string[] = [];
      for (let i = 0; i < 4; i++) {
        const t = await createTarget(`bc-${i}`);
        uids.push(await tagByRef(user1, t, definition, BigInt(i + 1)));
      }

      const arr = await edgeResolver.getActiveTags(definition, u1Addr, dummySchemaUID, 0n, 10n);
      expect(arr.length).to.equal(4);
      for (const u of uids) expect(arr).to.include(u);
    });
  });

  // ─── Revocation (swap-and-pop) ─────────────────────────────────────────────

  describe("Revocation: swap-and-pop", function () {
    it("Should remove a TAG from the active list when revoked", async function () {
      const definition = await createDefinition("rev-tag");
      const target = await createTarget("rev-target");
      const u1Addr = await user1.getAddress();

      const uid = await tagByRef(user1, target, definition, 3n);
      let entries = await edgeResolver.getActiveTagEntries(definition, u1Addr, dummySchemaUID, 0n, 10n);
      expect(entries.length).to.equal(1);

      await revokeTag(user1, uid);
      entries = await edgeResolver.getActiveTagEntries(definition, u1Addr, dummySchemaUID, 0n, 10n);
      expect(entries.length).to.equal(0);
      expect(await edgeResolver.hasActiveEdge(target, definition)).to.be.false;
    });

    it("Should maintain correct indices after multiple non-sequential revocations (swap-and-pop)", async function () {
      const def = await createDefinition("sap-def");
      const t1 = await createTarget("sap-1");
      const t2 = await createTarget("sap-2");
      const t3 = await createTarget("sap-3");
      const t4 = await createTarget("sap-4");
      const t5 = await createTarget("sap-5");
      const u1Addr = await user1.getAddress();

      const uid1 = await tagByRef(user1, t1, def, 1n);
      await tagByRef(user1, t2, def, 2n);
      const uid3 = await tagByRef(user1, t3, def, 3n);
      await tagByRef(user1, t4, def, 4n);
      const uid5 = await tagByRef(user1, t5, def, 5n);

      expect(await edgeResolver.getActiveTagsCount(def, u1Addr, dummySchemaUID)).to.equal(5n);

      // Revoke uid1 (position 0) — uid5 should swap into position 0.
      await revokeTag(user1, uid1);
      let entries = await edgeResolver.getActiveTagEntries(def, u1Addr, dummySchemaUID, 0n, 10n);
      expect(entries.length).to.equal(4);
      const uidsRemaining = entries.map(e => e.tagUID);
      expect(uidsRemaining).to.not.include(uid1);

      // Revoke uid3 (somewhere in the middle) — last item swaps in.
      await revokeTag(user1, uid3);
      entries = await edgeResolver.getActiveTagEntries(def, u1Addr, dummySchemaUID, 0n, 10n);
      expect(entries.length).to.equal(3);
      expect(entries.map(e => e.tagUID)).to.not.include(uid3);

      // Revoke uid5 (was swapped to position 0) — confirms swapped-entry indices stayed correct.
      await revokeTag(user1, uid5);
      entries = await edgeResolver.getActiveTagEntries(def, u1Addr, dummySchemaUID, 0n, 10n);
      expect(entries.length).to.equal(2);
      expect(entries.map(e => e.tagUID)).to.not.include(uid5);
    });

    it("Should drain to zero when all TAGs are revoked one by one", async function () {
      const def = await createDefinition("drain-def");
      const u1Addr = await user1.getAddress();
      const uids: string[] = [];
      for (let i = 0; i < 6; i++) {
        const t = await createTarget(`drain-${i}`);
        uids.push(await tagByRef(user1, t, def, BigInt(i + 1)));
      }
      expect(await edgeResolver.getActiveTagsCount(def, u1Addr, dummySchemaUID)).to.equal(6n);

      // Revoke in a non-sequential order to exercise the swap-and-pop bookkeeping.
      const order = [2, 0, 5, 3, 1, 4];
      for (let step = 0; step < order.length; step++) {
        await revokeTag(user1, uids[order[step]]);
        const remaining = 6 - (step + 1);
        expect(await edgeResolver.getActiveTagsCount(def, u1Addr, dummySchemaUID)).to.equal(BigInt(remaining));
      }

      const final = await edgeResolver.getActiveTagEntries(def, u1Addr, dummySchemaUID, 0n, 10n);
      expect(final.length).to.equal(0);
    });
  });

  // ─── Cross-attester isolation ──────────────────────────────────────────────

  describe("Cross-attester isolation", function () {
    it("Should hold independent TAG lists per attester at the same (def, schema) slot", async function () {
      const def = await createDefinition("byattester");
      const tAlice = await createTarget("alice-tagged");
      const tBob = await createTarget("bob-tagged");
      const u1Addr = await user1.getAddress();
      const u2Addr = await user2.getAddress();

      const uidA = await tagByRef(user1, tAlice, def, 1n);
      const uidB = await tagByRef(user2, tBob, def, 2n);

      const aliceList = await edgeResolver.getActiveTagEntries(def, u1Addr, dummySchemaUID, 0n, 10n);
      const bobList = await edgeResolver.getActiveTagEntries(def, u2Addr, dummySchemaUID, 0n, 10n);

      expect(aliceList.length).to.equal(1);
      expect(aliceList[0].tagUID).to.equal(uidA);
      expect(bobList.length).to.equal(1);
      expect(bobList[0].tagUID).to.equal(uidB);
    });

    it("Should not affect Bob's TAG list when Alice revokes hers", async function () {
      const def = await createDefinition("alice-revokes");
      const tShared = await createTarget("shared-tagged");
      const u1Addr = await user1.getAddress();
      const u2Addr = await user2.getAddress();

      const uidA = await tagByRef(user1, tShared, def, 1n);
      const uidB = await tagByRef(user2, tShared, def, 2n);

      await revokeTag(user1, uidA);

      const aliceList = await edgeResolver.getActiveTagEntries(def, u1Addr, dummySchemaUID, 0n, 10n);
      const bobList = await edgeResolver.getActiveTagEntries(def, u2Addr, dummySchemaUID, 0n, 10n);

      expect(aliceList.length).to.equal(0);
      expect(bobList.length).to.equal(1);
      expect(bobList[0].tagUID).to.equal(uidB);
    });
  });

  // ─── Smart-contract read shape ─────────────────────────────────────────────

  describe("Smart-contract read shape", function () {
    it("Should return getActiveTagEntries as an array — usable for iteration", async function () {
      // ADR-0041 ergonomics promise: TAG consumers do `for (TagEntry e : entries) …`.
      const definition = await createDefinition("iter-shape");
      const u1Addr = await user1.getAddress();
      for (let i = 0; i < 3; i++) {
        const t = await createTarget(`iter-${i}`);
        await tagByRef(user1, t, definition, BigInt(i));
      }

      const entries = await edgeResolver.getActiveTagEntries(definition, u1Addr, dummySchemaUID, 0n, 10n);
      // The runtime type is an array — confirms the API selector (schema UID) routed
      // to the list-shaped reader.
      expect(Array.isArray(entries)).to.be.true;
      expect(entries.length).to.equal(3);
    });
  });

  // ─── Discovery indices (shared with PIN, append-only) ─────────────────────

  describe("Discovery indices", function () {
    it("Should record a definition in getEdgeDefinitions when first attested", async function () {
      const target = await createTarget("disc-target");
      const def = await createDefinition("disc-def");

      await tagByRef(user1, target, def, 1n);

      expect(await edgeResolver.getEdgeDefinitionCount(target)).to.equal(1n);
      const defs = await edgeResolver.getEdgeDefinitions(target, 0n, 10n);
      expect(defs).to.deep.equal([def]);
    });

    it("Should NOT duplicate a definition when two attesters tag the same target", async function () {
      const target = await createTarget("dup-target");
      const def = await createDefinition("dup-def");

      await tagByRef(user1, target, def, 1n);
      await tagByRef(user2, target, def, 2n);

      expect(await edgeResolver.getEdgeDefinitionCount(target)).to.equal(1n);
    });

    it("Should keep discovery entries even after the source TAG is revoked (append-only)", async function () {
      const target = await createTarget("keep-target");
      const def = await createDefinition("keep-def");

      const uid = await tagByRef(user1, target, def, 1n);
      await revokeTag(user1, uid);

      // Discovery is append-only: target stays in the index even though no active edge remains.
      expect(await edgeResolver.getEdgeDefinitionCount(target)).to.equal(1n);
      expect(await edgeResolver.getTargetsByDefinitionCount(def)).to.equal(1n);
    });
  });
});
