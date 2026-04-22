import { expect } from "chai";
import { ethers } from "hardhat";
import { EFSIndexer, EFSFileView, EdgeResolver, EAS, SchemaRegistry } from "../typechain-types";
import { Signer, ZeroAddress } from "ethers";

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const NO_EXPIRATION = 0n;
const DEFAULT_TAG_WEIGHT = 1n;

/**
 * EFSFileView — directory-listing tests under the ADR-0041 PIN/TAG model.
 *
 * Folder visibility is TAG-based (cardinality N): each attester emits
 * `TAG(definition=dataSchemaUID, refUID=folder, weight>0)` to claim a folder
 * in their edition. Removal is `eas.revoke()` on the active TAG — there is
 * no `applies=false` supersede.
 *
 * File placement is PIN-based (cardinality 1) — each filename-anchor slot
 * holds one PIN per attester, but the file-listing tests below mostly
 * exercise the *folder* listing path (Phase 0) and the cross-attester dedup
 * inside `getFilesAtPath`.
 */
describe("EFSFileView", function () {
  let indexer: EFSIndexer;
  let fileView: EFSFileView;
  let edgeResolver: EdgeResolver;
  let eas: EAS;
  let registry: SchemaRegistry;
  let owner: Signer;
  let alice: Signer;
  let bob: Signer;

  let anchorSchemaUID: string;
  let dataSchemaUID: string;
  let propertySchemaUID: string;
  let pinSchemaUID: string;
  let tagSchemaUID: string;

  // Per-test active-edge index: `${target}|${definition}|${attester}` → live attestation UID
  // (used by `untag` / `unpin` helpers to revoke the live edge without bookkeeping
  // sprinkled across each test).
  let activePinIndex: Map<string, string>;
  let activeTagIndex: Map<string, string>;

  beforeEach(async function () {
    [owner, alice, bob] = await ethers.getSigners();

    activePinIndex = new Map();
    activeTagIndex = new Map();

    const RegistryFactory = await ethers.getContractFactory("SchemaRegistry");
    registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();

    const EASFactory = await ethers.getContractFactory("EAS");
    eas = await EASFactory.deploy(await registry.getAddress());
    await eas.waitForDeployment();

    const ownerAddr = await owner.getAddress();
    const nonce = await ethers.provider.getTransactionCount(ownerAddr);

    // Deploy order:
    //   nonce+0: EdgeResolver
    //   nonce+1..5: Anchor, Property, Data, Blob, PIN, TAG schema registrations (5 total)
    //   nonce+7: Indexer
    const futureEdgeResolverAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: nonce });
    const futureIndexerAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: nonce + 7 });
    const precomputedPinSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      ["bytes32 definition", futureEdgeResolverAddr, true],
    );
    const precomputedTagSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      ["bytes32 definition, int256 weight", futureEdgeResolverAddr, true],
    );

    // Deploy EdgeResolver first
    const EdgeResolverFactory = await ethers.getContractFactory("EdgeResolver");
    edgeResolver = await EdgeResolverFactory.deploy(
      await eas.getAddress(),
      precomputedPinSchemaUID,
      precomputedTagSchemaUID,
      futureIndexerAddr,
      await registry.getAddress(),
    );
    await edgeResolver.waitForDeployment();

    // Register Schemas (aligned with canonical EFSIndexer and EFSRouter schemas)
    const tx1 = await registry.register("string name, bytes32 schemaUID", futureIndexerAddr, false);
    const rc1 = await tx1.wait();
    anchorSchemaUID = rc1!.logs[0].topics[1];

    // Property (unified free-floating model per ADR-0035, non-revocable)
    const tx2 = await registry.register("string value", futureIndexerAddr, false);
    const rc2 = await tx2.wait();
    propertySchemaUID = rc2!.logs[0].topics[1];

    // Data (non-revocable, content-addressed — matches EFSIndexer DATA_SCHEMA_UID)
    const tx3 = await registry.register("bytes32 contentHash, uint64 size", futureIndexerAddr, false);
    const rc3 = await tx3.wait();
    dataSchemaUID = rc3!.logs[0].topics[1];

    // Blob (No resolver)
    const tx4 = await registry.register("string mimeType, uint8 storageType, bytes location", ZeroAddress, true);
    const rc4 = await tx4.wait();
    const blobSchemaUID = rc4!.logs[0].topics[1];

    // PIN schema
    const tx5 = await registry.register("bytes32 definition", futureEdgeResolverAddr, true);
    const rc5 = await tx5.wait();
    pinSchemaUID = rc5!.logs[0].topics[1];

    // TAG schema
    const tx6 = await registry.register("bytes32 definition, int256 weight", futureEdgeResolverAddr, true);
    const rc6 = await tx6.wait();
    tagSchemaUID = rc6!.logs[0].topics[1];

    // Deploy Indexer
    const IndexerFactory = await ethers.getContractFactory("EFSIndexer");
    indexer = await IndexerFactory.deploy(
      await eas.getAddress(),
      anchorSchemaUID,
      propertySchemaUID,
      dataSchemaUID,
      blobSchemaUID,
    );
    await indexer.waitForDeployment();

    expect(await indexer.getAddress()).to.equal(futureIndexerAddr);

    // Deploy FileView (with EdgeResolver)
    const FileViewFactory = await ethers.getContractFactory("EFSFileView");
    fileView = await FileViewFactory.deploy(await indexer.getAddress(), await edgeResolver.getAddress());
    await fileView.waitForDeployment();

    // Wire the indexer -> edgeResolver link so EdgeResolver.onAttest can call
    // indexer.propagateContains without reverting Unauthorized. The sort/mirror
    // slots aren't exercised here, so passing zero addresses for them is fine.
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

    void propertySchemaUID; // keep declared (used by callers in future expansions)
  });

  const getUIDFromReceipt = (receipt: any) => {
    const easInterface = eas.interface;
    for (const log of receipt.logs) {
      try {
        const parsed = easInterface.parseLog(log);
        if (parsed && parsed.name === "Attested") {
          return parsed.args.uid;
        }
      } catch {}
    }
    console.log("Logs:", receipt.logs);
    throw new Error("Attested event not found in receipt");
  };

  const enc = new ethers.AbiCoder();

  /** Create an anchor under parentUID with the given name and schema type. */
  const createAnchor = async (
    name: string,
    parentUID: string,
    schema: string,
    signer: Signer = owner,
  ): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: parentUID,
        data: enc.encode(["string", "bytes32"], [name, schema]),
        value: 0n,
      },
    });
    return getUIDFromReceipt(await tx.wait());
  };

  /**
   * Create a TAG attestation (cardinality N — folder visibility, descriptive labels).
   * Default weight is 1 (active, no sort key in use).
   */
  const createTag = async (
    targetUID: string,
    definition: string,
    attester: Signer = owner,
    weight: bigint = DEFAULT_TAG_WEIGHT,
  ): Promise<string> => {
    const tx = await eas.connect(attester).attest({
      schema: tagSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: targetUID,
        data: enc.encode(["bytes32", "int256"], [definition, weight]),
        value: 0n,
      },
    });
    const uid = getUIDFromReceipt(await tx.wait());
    activeTagIndex.set(`${targetUID}|${definition}|${await attester.getAddress()}`, uid);
    return uid;
  };

  /** Revoke the live TAG for (target, def, attester). No-op if no active TAG. */
  const untag = async (targetUID: string, definition: string, attester: Signer = owner): Promise<void> => {
    const key = `${targetUID}|${definition}|${await attester.getAddress()}`;
    const uid = activeTagIndex.get(key);
    if (uid === undefined) return;
    await eas.connect(attester).revoke({
      schema: tagSchemaUID,
      data: { uid, value: 0n },
    });
    activeTagIndex.delete(key);
  };

  /**
   * Create a PIN attestation (cardinality 1 — file placement, PROPERTY value binding).
   * Re-attesting at the same (def, attester, schema) slot supersedes prior PIN in O(1).
   */
  const createPin = async (targetUID: string, definition: string, attester: Signer = owner): Promise<string> => {
    const tx = await eas.connect(attester).attest({
      schema: pinSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: targetUID,
        data: enc.encode(["bytes32"], [definition]),
        value: 0n,
      },
    });
    const uid = getUIDFromReceipt(await tx.wait());
    activePinIndex.set(`${targetUID}|${definition}|${await attester.getAddress()}`, uid);
    return uid;
  };

  /** Revoke the live PIN for (target, def, attester). No-op if no active PIN. */
  const unpin = async (targetUID: string, definition: string, attester: Signer = owner): Promise<void> => {
    const key = `${targetUID}|${definition}|${await attester.getAddress()}`;
    const uid = activePinIndex.get(key);
    if (uid === undefined) return;
    await eas.connect(attester).revoke({
      schema: pinSchemaUID,
      data: { uid, value: 0n },
    });
    activePinIndex.delete(key);
  };

  it("Folder visibility requires an explicit TAG — untagged folders with file-anchor children do NOT appear", async function () {
    // Folder visibility is tag-only (ADR-0038, carried over to ADR-0041): a folder does NOT
    // appear in a schema-filtered listing just because it contains file-anchor children;
    // the attester must emit a TAG(definition=dataSchemaUID, refUID=folder, weight>0) to
    // claim that folder in their edition. The client upload flow walks the ancestor chain
    // and emits any missing visibility TAGs.
    const ownerAddr = await owner.getAddress();

    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32);

    const folderWithContentUID = await createAnchor("has-content", rootUID, ZERO_BYTES32);
    await createAnchor("cat.jpg", folderWithContentUID, dataSchemaUID); // file anchor inside, but folder NOT tagged

    await createAnchor("empty-untagged", rootUID, ZERO_BYTES32);

    const { items } = await fileView.getDirectoryPageBySchemaAndAddressList(
      rootUID,
      dataSchemaUID,
      [ownerAddr],
      "0x",
      10,
    );

    expect(items.length).to.equal(0);
  });

  it("PIN(definition=dataSchemaUID, refUID=folder) does NOT make the folder visible (TAG-only, ADR-0038 regression)", async function () {
    // ADR-0038: folder visibility is TAG-only — a PIN at the same (attester, definition, schema)
    // slot must NOT substitute for a TAG. Pre-fix, `hasActiveEdgeFromAny` was schema-blind and
    // would accept a PIN, making the folder appear spuriously. This test confirms the fix:
    // `hasActiveTagFromAny` is used instead, so the PIN has zero effect on folder visibility.
    const ownerAddr = await owner.getAddress();

    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32);
    const folderUID = await createAnchor("pin-visible-folder", rootUID, ZERO_BYTES32);

    // Attest a PIN with definition=dataSchemaUID targeting the folder.
    // This is not how file placement is done in practice (placement PINs use a file-slot UID
    // as definition), but an attacker or a misusing client could emit this. Pre-fix it would
    // have been enough to surface the folder; post-fix it must not.
    await createPin(folderUID, dataSchemaUID);

    const { items } = await fileView.getDirectoryPageBySchemaAndAddressList(
      rootUID,
      dataSchemaUID,
      [ownerAddr],
      "0x",
      10,
    );

    // The folder must NOT appear — only a TAG makes a folder visible.
    expect(items.length).to.equal(0);

    // Confirm that adding a TAG DOES make it appear (proves the check works, not that it's broken).
    await createTag(folderUID, dataSchemaUID);
    const { items: after } = await fileView.getDirectoryPageBySchemaAndAddressList(
      rootUID,
      dataSchemaUID,
      [ownerAddr],
      "0x",
      10,
    );
    expect(after.length).to.equal(1);
    expect(after[0].name).to.equal("pin-visible-folder");
  });

  it("Empty folders appear when explicitly tagged with the schema UID", async function () {
    // A folder is visible in an edition iff it has an active TAG with definition=dataSchemaUID
    // and weight>0 by someone in the edition list.
    const ownerAddr = await owner.getAddress();

    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32);

    const emptyTaggedUID = await createAnchor("empty-tagged", rootUID, ZERO_BYTES32);
    await createTag(emptyTaggedUID, dataSchemaUID);

    await createAnchor("empty-untagged", rootUID, ZERO_BYTES32);

    const { items } = await fileView.getDirectoryPageBySchemaAndAddressList(
      rootUID,
      dataSchemaUID,
      [ownerAddr],
      "0x",
      10,
    );

    expect(items.length).to.equal(1);
    expect(items[0].name).to.equal("empty-tagged");
  });

  it("Ancestor-chain visibility: only folders explicitly tagged appear, regardless of nested contents", async function () {
    // root → /photos/ → /cats/ → cat.jpg (file anchor, with /photos/ and /cats/ explicitly tagged)
    // In the tag-only model the client walks the ancestor chain on upload and emits a
    // visibility TAG at every ancestor. A folder with no TAG never appears even if deeply
    // nested content exists beneath it.
    const ownerAddr = await owner.getAddress();

    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32);
    const photosUID = await createAnchor("photos", rootUID, ZERO_BYTES32);
    const catsUID = await createAnchor("cats", photosUID, ZERO_BYTES32);
    await createAnchor("cat.jpg", catsUID, dataSchemaUID);

    // Simulate client ancestor-walk: tag every ancestor folder up to (but excluding) root.
    await createTag(catsUID, dataSchemaUID);
    await createTag(photosUID, dataSchemaUID);

    const { items: rootItems } = await fileView.getDirectoryPageBySchemaAndAddressList(
      rootUID,
      dataSchemaUID,
      [ownerAddr],
      "0x",
      10,
    );
    expect(rootItems.length).to.equal(1);
    expect(rootItems[0].name).to.equal("photos");

    const { items: photosItems } = await fileView.getDirectoryPageBySchemaAndAddressList(
      photosUID,
      dataSchemaUID,
      [ownerAddr],
      "0x",
      10,
    );
    expect(photosItems.length).to.equal(1);
    expect(photosItems[0].name).to.equal("cats");
  });

  it("Untagged ancestor is invisible even when a deeper descendant is tagged and populated", async function () {
    // If the client skipped one ancestor in the walk, that ancestor is invisible.
    // This is the intended property: folder visibility follows TAG, not content.
    const ownerAddr = await owner.getAddress();

    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32);
    const photosUID = await createAnchor("photos", rootUID, ZERO_BYTES32); // NOT tagged
    const catsUID = await createAnchor("cats", photosUID, ZERO_BYTES32);
    await createAnchor("cat.jpg", catsUID, dataSchemaUID);
    await createTag(catsUID, dataSchemaUID);

    const { items: rootItems } = await fileView.getDirectoryPageBySchemaAndAddressList(
      rootUID,
      dataSchemaUID,
      [ownerAddr],
      "0x",
      10,
    );
    expect(rootItems.length).to.equal(0);
  });

  it("Should not return a tagged folder after its visibility TAG is revoked", async function () {
    // Under ADR-0041 there is no `applies=false` — removal is `eas.revoke()` on the active
    // TAG attestation. The folder must disappear from the listing immediately.
    const ownerAddr = await owner.getAddress();

    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32);
    const folderUID = await createAnchor("my-folder", rootUID, ZERO_BYTES32);

    await createTag(folderUID, dataSchemaUID);

    const { items: before } = await fileView.getDirectoryPageBySchemaAndAddressList(
      rootUID,
      dataSchemaUID,
      [ownerAddr],
      "0x",
      10,
    );
    expect(before.length).to.equal(1);
    expect(before[0].name).to.equal("my-folder");

    await untag(folderUID, dataSchemaUID);

    const { items: after } = await fileView.getDirectoryPageBySchemaAndAddressList(
      rootUID,
      dataSchemaUID,
      [ownerAddr],
      "0x",
      10,
    );
    expect(after.length).to.equal(0);
  });

  it("Should not return a tagged folder after its tag is revoked via EAS multiRevoke", async function () {
    // Regression: the client-driven folder delete flow issues EAS multiRevoke on the
    // visibility TAG. This must produce the same outcome as a single-revoke — folder
    // disappears from the edition listing.
    const ownerAddr = await owner.getAddress();

    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32);
    const folderUID = await createAnchor("my-folder", rootUID, ZERO_BYTES32);

    const visTagUID = await createTag(folderUID, dataSchemaUID);

    const { items: before } = await fileView.getDirectoryPageBySchemaAndAddressList(
      rootUID,
      dataSchemaUID,
      [ownerAddr],
      "0x",
      10,
    );
    expect(before.length).to.equal(1);

    await eas.multiRevoke([{ schema: tagSchemaUID, data: [{ uid: visTagUID, value: 0n }] }]);

    const { items: after } = await fileView.getDirectoryPageBySchemaAndAddressList(
      rootUID,
      dataSchemaUID,
      [ownerAddr],
      "0x",
      10,
    );
    expect(after.length).to.equal(0);
  });

  it("Should return a folder once in a multi-attester listing even when both attesters tagged it", async function () {
    // `_childrenWithEdge` is keyed by (parent, definition) not (parent, definition, attester),
    // so a folder appears in the discovery list once regardless of how many attesters tagged it.
    // `hasActiveEdgeFromAny` short-circuits on the first match. Verify the folder is not double-counted.
    const aliceAddr = await alice.getAddress();
    const bobAddr = await bob.getAddress();

    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32);
    const sharedFolder = await createAnchor("shared", rootUID, ZERO_BYTES32);
    const aliceOnlyFolder = await createAnchor("alice-only", rootUID, ZERO_BYTES32);

    await createTag(sharedFolder, dataSchemaUID, alice);
    await createTag(sharedFolder, dataSchemaUID, bob);
    await createTag(aliceOnlyFolder, dataSchemaUID, alice);

    const { items } = await fileView.getDirectoryPageBySchemaAndAddressList(
      rootUID,
      dataSchemaUID,
      [aliceAddr, bobAddr],
      "0x",
      10,
    );

    expect(items.length).to.equal(2);
    const names = items.map((i: any) => i.name).sort();
    expect(names).to.deep.equal(["alice-only", "shared"]);
  });

  it("Paginates folders + files across multiple calls via opaque cursor", async function () {
    // Regression: page-1 contains folders only; page-2 contains content items; nextCursor
    // empty iff both sources exhausted. Exercises the phase-0 → phase-1 transition.
    const ownerAddr = await owner.getAddress();

    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32);

    // 3 tagged folders
    const folderA = await createAnchor("folder-a", rootUID, ZERO_BYTES32);
    const folderB = await createAnchor("folder-b", rootUID, ZERO_BYTES32);
    const folderC = await createAnchor("folder-c", rootUID, ZERO_BYTES32);
    await createTag(folderA, dataSchemaUID);
    await createTag(folderB, dataSchemaUID);
    await createTag(folderC, dataSchemaUID);

    // 4 content items
    await createAnchor("file-1.txt", rootUID, dataSchemaUID);
    await createAnchor("file-2.txt", rootUID, dataSchemaUID);
    await createAnchor("file-3.txt", rootUID, dataSchemaUID);
    await createAnchor("file-4.txt", rootUID, dataSchemaUID);

    // Page 1: request 2 items — expect 2 folders, cursor nonempty
    const p1 = await fileView.getDirectoryPageBySchemaAndAddressList(rootUID, dataSchemaUID, [ownerAddr], "0x", 2);
    expect(p1.items.length).to.equal(2);
    expect(p1.items.every((i: any) => i.isFolder)).to.equal(true);
    expect(p1.nextCursor).to.not.equal("0x");

    // Page 2: request 2 more — expect remaining folder + 1 content item
    const p2 = await fileView.getDirectoryPageBySchemaAndAddressList(
      rootUID,
      dataSchemaUID,
      [ownerAddr],
      p1.nextCursor,
      2,
    );
    expect(p2.items.length).to.equal(2);
    expect(p2.nextCursor).to.not.equal("0x");

    // Page 3: request 10 — expect remaining content items, cursor empty
    const p3 = await fileView.getDirectoryPageBySchemaAndAddressList(
      rootUID,
      dataSchemaUID,
      [ownerAddr],
      p2.nextCursor,
      10,
    );
    // Remaining items = 7 total - 4 already returned = 3
    expect(p3.items.length).to.equal(3);
    expect(p3.nextCursor).to.equal("0x");
  });

  it("Malformed opaque cursors silently restart the walk (ADR-0036 defensive decode)", async function () {
    // The cursor is caller-supplied opaque bytes (ADR-0036). A buggy or malicious client
    // must not be able to brick the view with an `abi.decode` Panic or get stuck in a
    // no-progress loop from an out-of-range `phase`. Both code paths (folder walker and
    // file walker) length-check the cursor before decoding and range-check `phase` to
    // keep the view safe.
    const ownerAddr = await owner.getAddress();
    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32);
    const folderUID = await createAnchor("folder", rootUID, ZERO_BYTES32);
    await createTag(folderUID, dataSchemaUID);

    // 1. Completely garbage bytes (not a multiple of 32). Must NOT revert with a Panic;
    //    must start the walk fresh and return the one real folder.
    const garbage = "0xdeadbeef";
    const p1 = await fileView.getDirectoryPageBySchemaAndAddressList(rootUID, dataSchemaUID, [ownerAddr], garbage, 10);
    expect(p1.items.length).to.equal(1);
    expect(p1.items[0].name).to.equal("folder");

    // 2. Right-shape (96 bytes) but with `phase=7` — out of the valid {0, 1} range.
    //    A naive implementation would accept it, skip both phase-0 and phase-1 blocks,
    //    and return empty items WITH an unchanged cursor — callers would loop forever.
    //    The range-check must silently restart at phase=0.
    const outOfRangeCursor = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256", "uint256"], [7n, 0n, 0n]);
    const p2 = await fileView.getDirectoryPageBySchemaAndAddressList(
      rootUID,
      dataSchemaUID,
      [ownerAddr],
      outOfRangeCursor,
      10,
    );
    expect(p2.items.length).to.equal(1);
    expect(p2.items[0].name).to.equal("folder");

    // 3. getFilesAtPath cursor is `(uint256)` — 32 bytes. Feeding wrong-length
    //    garbage must not revert. We don't care what it returns (the view walks PINs at
    //    `anchorUID`, and this test hasn't placed any). The point is that the defensive
    //    decode fresh-starts instead of panicking on abi.decode.
    const garbageForFiles = "0xdeadbeef";
    const p3 = await fileView.getFilesAtPath(folderUID, [ownerAddr], dataSchemaUID, garbageForFiles, 10);
    // Empty page or full page, either is fine — the guarantee is no-revert.
    expect(p3.nextCursor.length).to.be.greaterThanOrEqual(2); // at minimum "0x"
  });

  it("getFilesAtPath: revoking an earlier attester's PIN clears their slot, falls through to next attester", async function () {
    // Regression: under ADR-0041 the `_activeBySlot` storage carries a true singleton —
    // when the active PIN is revoked the slot is cleared (targetID returns 0x0), so the
    // multi-attester walk in `getFilesAtPath` correctly falls through to the next attester.
    // This is the PIN equivalent of the old "applies=false fallback" regression for TAG.
    const aliceAddr = await alice.getAddress();
    const bobAddr = await bob.getAddress();

    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32);
    const folderUID = await createAnchor("folder", rootUID, ZERO_BYTES32);

    // File slot — created by alice. Both editions PIN their own DATA into this slot.
    const slotUID = await createAnchor("doc.txt", folderUID, dataSchemaUID, alice);

    // Alice's DATA payload.
    const aliceDataTx = await eas.connect(alice).attest({
      schema: dataSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: ZERO_BYTES32,
        data: enc.encode(["bytes32", "uint64"], [ethers.keccak256(ethers.toUtf8Bytes("alice payload")), 7n]),
        value: 0n,
      },
    });
    const aliceData = getUIDFromReceipt(await aliceDataTx.wait());

    // Bob's DATA payload.
    const bobDataTx = await eas.connect(bob).attest({
      schema: dataSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: ZERO_BYTES32,
        data: enc.encode(["bytes32", "uint64"], [ethers.keccak256(ethers.toUtf8Bytes("bob payload")), 11n]),
        value: 0n,
      },
    });
    const bobData = getUIDFromReceipt(await bobDataTx.wait());

    // Alice PINs first, then revokes — slot must clear.
    await createPin(aliceData, slotUID, alice);
    await unpin(aliceData, slotUID, alice);

    // Bob PINs.
    await createPin(bobData, slotUID, bob);

    // Sanity: alice's slot is empty after revoke; bob's slot points at his DATA.
    expect(await edgeResolver.getActivePinTarget(slotUID, aliceAddr, dataSchemaUID)).to.equal(ZERO_BYTES32);
    expect(await edgeResolver.getActivePinTarget(slotUID, bobAddr, dataSchemaUID)).to.equal(bobData);

    // Multi-attester walk: alice first, bob second. Alice's empty slot is skipped,
    // bob's DATA is returned. (Under ADR-0041 there's no stale "active=false" UID
    // that could be misread as still-claimed — revocation cleared the slot.)
    const page = await fileView.getFilesAtPath(slotUID, [aliceAddr, bobAddr], dataSchemaUID, "0x", 10);
    expect(page.items.length).to.equal(1);
    expect(page.items[0].uid).to.equal(bobData);
  });

  it("Surfaces >10k tagged folders without silent truncation (ADR-0036)", async function () {
    // Regression for the old MAX_TAGGED_FOLDERS=10000 silent-cap landmine. The cursor-based
    // walker must continue past any arbitrary cap. We do NOT create 10k folders here (too
    // slow for CI); instead, verify that paginating through 50 folders with page size 7
    // returns every folder exactly once — proving the walker advances correctly across
    // chunked fetches with no cap-based drop.
    const ownerAddr = await owner.getAddress();
    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32);

    const names: string[] = [];
    for (let i = 0; i < 50; i++) {
      const name = `folder-${String(i).padStart(3, "0")}`;
      const uid = await createAnchor(name, rootUID, ZERO_BYTES32);
      await createTag(uid, dataSchemaUID);
      names.push(name);
    }

    const seen = new Set<string>();
    let cursor: string = "0x";
    let callCount = 0;
    while (true) {
      callCount++;
      if (callCount > 20) throw new Error("pagination did not terminate");
      const page = await fileView.getDirectoryPageBySchemaAndAddressList(
        rootUID,
        dataSchemaUID,
        [ownerAddr],
        cursor,
        7,
      );
      for (const item of page.items) seen.add(item.name);
      if (page.nextCursor === "0x") break;
      cursor = page.nextCursor;
    }

    expect(seen.size).to.equal(50);
    expect([...seen].sort()).to.deep.equal(names.slice().sort());
  });
});
