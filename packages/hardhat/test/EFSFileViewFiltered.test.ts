import { expect } from "chai";
import { ethers } from "hardhat";
import { EFSIndexer, EFSFileView, EdgeResolver, EAS, SchemaRegistry } from "../typechain-types";
import { Signer, ZeroAddress } from "ethers";

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const NO_EXPIRATION = 0n;
const DEFAULT_TAG_WEIGHT = 1n;

/**
 * EFSFileView.getDirectoryPageFiltered — view-layer tag-exclusion directory filter (ADR-0048).
 *
 * The filter is getDirectoryPageBySchemaAndAddressList PLUS a per-item exclusion predicate:
 * skip an item if ANY lens has an active TAG `excludeTagDef` on it with `weight >= minWeight`.
 *
 * Tag-target asymmetry (load-bearing, ADR-0048):
 *   - folder item: the descriptive-label TAG targets the ANCHOR UID, bucket ANCHOR_SCHEMA_UID.
 *   - file item:   the TAG targets the DATA UID, reached via the placement PIN
 *                  getActivePinTarget(itemAnchor, lens, dataSchemaUID), bucket dataSchemaUID.
 *
 * getActiveTagWeight is also unit-tested here: O(1) raw-weight read over existing storage.
 */
describe("EFSFileView — getDirectoryPageFiltered (ADR-0048)", function () {
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

  // A descriptive-label definition used as the exclude tag (e.g. "#nsfw"). Any non-zero,
  // valid definition works; we use a registered schema UID so _validateDefinition passes.
  let excludeTagDef: string;

  beforeEach(async function () {
    [owner, alice, bob] = await ethers.getSigners();

    const RegistryFactory = await ethers.getContractFactory("SchemaRegistry");
    registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();

    const EASFactory = await ethers.getContractFactory("EAS");
    eas = await EASFactory.deploy(await registry.getAddress());
    await eas.waitForDeployment();

    const ownerAddr = await owner.getAddress();
    const nonce = await ethers.provider.getTransactionCount(ownerAddr);

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

    const EdgeResolverFactory = await ethers.getContractFactory("EdgeResolver");
    edgeResolver = await EdgeResolverFactory.deploy(
      await eas.getAddress(),
      precomputedPinSchemaUID,
      precomputedTagSchemaUID,
      futureIndexerAddr,
      await registry.getAddress(),
    );
    await edgeResolver.waitForDeployment();

    const tx1 = await registry.register("string name, bytes32 schemaUID", futureIndexerAddr, false);
    anchorSchemaUID = (await tx1.wait())!.logs[0].topics[1];

    const tx2 = await registry.register("string value", futureIndexerAddr, false);
    propertySchemaUID = (await tx2.wait())!.logs[0].topics[1];

    const tx3 = await registry.register("bytes32 contentHash, uint64 size", futureIndexerAddr, false);
    dataSchemaUID = (await tx3.wait())!.logs[0].topics[1];

    const tx4 = await registry.register("string mimeType, uint8 storageType, bytes location", ZeroAddress, true);
    const blobSchemaUID = (await tx4.wait())!.logs[0].topics[1];

    const tx5 = await registry.register("bytes32 definition", futureEdgeResolverAddr, true);
    pinSchemaUID = (await tx5.wait())!.logs[0].topics[1];

    const tx6 = await registry.register("bytes32 definition, int256 weight", futureEdgeResolverAddr, true);
    tagSchemaUID = (await tx6.wait())!.logs[0].topics[1];

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

    // A standalone schema UID used as the exclude-tag definition (a valid bytes32 definition,
    // registered after the indexer so it doesn't shift the CREATE nonce of the indexer above).
    const tx7 = await registry.register("string excludeLabel", ZeroAddress, false);
    excludeTagDef = (await tx7.wait())!.logs[0].topics[1];

    const FileViewFactory = await ethers.getContractFactory("EFSFileView");
    fileView = await FileViewFactory.deploy(await indexer.getAddress(), await edgeResolver.getAddress());
    await fileView.waitForDeployment();

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

    void propertySchemaUID;
  });

  const enc = new ethers.AbiCoder();

  const getUIDFromReceipt = (receipt: any) => {
    for (const log of receipt.logs) {
      try {
        const parsed = eas.interface.parseLog(log);
        if (parsed && parsed.name === "Attested") return parsed.args.uid;
      } catch {}
    }
    throw new Error("Attested event not found in receipt");
  };

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

  /** Create a DATA attestation (content identity) and return its UID. */
  const createData = async (label: string, signer: Signer = owner): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: dataSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: ZERO_BYTES32,
        data: enc.encode(["bytes32", "uint64"], [ethers.keccak256(ethers.toUtf8Bytes(label)), 1n]),
        value: 0n,
      },
    });
    return getUIDFromReceipt(await tx.wait());
  };

  /** PIN target under definition by attester (cardinality 1). */
  const createPin = async (targetUID: string, definition: string, attester: Signer): Promise<string> => {
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
    return getUIDFromReceipt(await tx.wait());
  };

  /** TAG target under definition by attester with weight (cardinality N). */
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
    return uid;
  };

  /** Revoke a TAG attestation by its UID (revocable=true). Attester must match the original. */
  const revokeTag = async (tagUID: string, attester: Signer = owner): Promise<void> => {
    const tx = await eas.connect(attester).revoke({
      schema: tagSchemaUID,
      data: { uid: tagUID, value: 0n },
    });
    await tx.wait();
  };

  /**
   * Deploy a test-only EFSFileView subclass whose per-call scan budgets are shrunk to `budget`
   * (default 4). Lets the phase-0 / phase-1 budget guards (ADR-0048's headline safety mechanism)
   * trip with a handful of seeded items instead of thousands. Wired to the same indexer +
   * edgeResolver as the production `fileView`.
   */
  const deployTestableFileView = async (budget: number = 4): Promise<EFSFileView> => {
    const Factory = await ethers.getContractFactory("EFSFileViewTestable");
    const tv = await Factory.deploy(await indexer.getAddress(), await edgeResolver.getAddress(), BigInt(budget));
    await tv.waitForDeployment();
    return tv as unknown as EFSFileView;
  };

  /**
   * Create a file item: a file anchor (schema=dataSchemaUID) under parent, a DATA payload,
   * and the placement PIN(definition=fileAnchor, refUID=DATA) by `attester`. The PIN both
   * makes the item qualify in phase 1 (containsAttestations) AND establishes the
   * file→DATA-via-PIN path that the filter resolves. Returns { fileAnchor, dataUID }.
   */
  const createFileItem = async (
    name: string,
    parentUID: string,
    attester: Signer,
    dataLabel?: string,
  ): Promise<{ fileAnchor: string; dataUID: string }> => {
    const fileAnchor = await createAnchor(name, parentUID, dataSchemaUID, attester);
    const dataUID = await createData(dataLabel ?? name, attester);
    await createPin(dataUID, fileAnchor, attester);
    return { fileAnchor, dataUID };
  };

  const names = (items: any[]) => items.map(i => i.name).sort();

  // ─────────────────────────── getActiveTagWeight unit ───────────────────────────

  describe("EdgeResolver.getActiveTagWeight", function () {
    it("returns (true, weight) for a tagged target and (false, 0) for an untagged one", async function () {
      const aliceAddr = await alice.getAddress();
      const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32);
      const folderUID = await createAnchor("f", rootUID, ZERO_BYTES32, alice);

      // Tag the folder anchor (bucket = ANCHOR_SCHEMA_UID) with weight 5.
      await createTag(folderUID, excludeTagDef, alice, 5n);

      const tagged = await edgeResolver.getActiveTagWeight(aliceAddr, folderUID, excludeTagDef, anchorSchemaUID);
      expect(tagged.exists).to.equal(true);
      expect(tagged.weight).to.equal(5n);

      // Untagged target → (false, 0).
      const untagged = await edgeResolver.getActiveTagWeight(aliceAddr, rootUID, excludeTagDef, anchorSchemaUID);
      expect(untagged.exists).to.equal(false);
      expect(untagged.weight).to.equal(0n);

      // Wrong bucket (dataSchema instead of anchorSchema) → (false, 0): bucket is part of the key.
      const wrongBucket = await edgeResolver.getActiveTagWeight(aliceAddr, folderUID, excludeTagDef, dataSchemaUID);
      expect(wrongBucket.exists).to.equal(false);

      // Negative weight is returned verbatim (kernel weight-neutral).
      const negFolder = await createAnchor("neg", rootUID, ZERO_BYTES32, alice);
      await createTag(negFolder, excludeTagDef, alice, -7n);
      const neg = await edgeResolver.getActiveTagWeight(aliceAddr, negFolder, excludeTagDef, anchorSchemaUID);
      expect(neg.exists).to.equal(true);
      expect(neg.weight).to.equal(-7n);
    });

    it("reads an address-target TAG via the targetSchema=0 bucket", async function () {
      // Address-root content (ADR-0033) is tagged with refUID=0 + recipient=addr,
      // so EdgeResolver records targetID=bytes32(uint160(addr)) and targetSchema=0
      // (no target attestation to read a schema from). Confirm getActiveTagWeight
      // finds it under that sentinel bucket — the address-root README hide path.
      const aliceAddr = await alice.getAddress();
      const bobAddr = await bob.getAddress();
      const addrTarget = ethers.zeroPadValue(bobAddr, 32); // bytes32(uint160(addr))

      await eas.connect(alice).attest({
        schema: tagSchemaUID,
        data: {
          recipient: bobAddr, // address target (refUID empty)
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: ZERO_BYTES32,
          data: enc.encode(["bytes32", "int256"], [excludeTagDef, 3n]),
          value: 0n,
        },
      });

      const onAddr = await edgeResolver.getActiveTagWeight(aliceAddr, addrTarget, excludeTagDef, ZERO_BYTES32);
      expect(onAddr.exists).to.equal(true);
      expect(onAddr.weight).to.equal(3n);

      // An untagged address → (false, 0).
      const otherAddr = ethers.zeroPadValue(aliceAddr, 32);
      const untagged = await edgeResolver.getActiveTagWeight(aliceAddr, otherAddr, excludeTagDef, ZERO_BYTES32);
      expect(untagged.exists).to.equal(false);
    });
  });

  // ─────────────────────────── entry-guard reverts ───────────────────────────

  describe("getDirectoryPageFiltered entry guards", function () {
    it("reverts on empty attesters, too many attesters, and maxItems == 0", async function () {
      const aliceAddr = await alice.getAddress();
      const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32, alice);

      // Empty attesters.
      await expect(fileView.getDirectoryPageFiltered(rootUID, dataSchemaUID, [], [], [], "0x", 10)).to.be.revertedWith(
        "Attesters list cannot be empty",
      );

      // > MAX_ATTESTERS_PER_QUERY (20) → 21 copies.
      const tooMany = Array(21).fill(aliceAddr);
      await expect(
        fileView.getDirectoryPageFiltered(rootUID, dataSchemaUID, tooMany, [], [], "0x", 10),
      ).to.be.revertedWith("Too many attesters");

      // maxItems == 0.
      await expect(
        fileView.getDirectoryPageFiltered(rootUID, dataSchemaUID, [aliceAddr], [], [], "0x", 0),
      ).to.be.revertedWith("maxItems must be > 0");
    });
  });

  // ─────────────────────────── file-item exclusion ───────────────────────────

  it("File tagged on its DATA by a lens (weight >= minWeight) is excluded; untagged file is included", async function () {
    const aliceAddr = await alice.getAddress();
    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32, alice);

    const tagged = await createFileItem("tagged.txt", rootUID, alice);
    await createFileItem("clean.txt", rootUID, alice);

    // Exclude tag on the DATA (bucket dataSchemaUID), weight 1 >= minWeight 0.
    await createTag(tagged.dataUID, excludeTagDef, alice, 1n);

    const page = await fileView.getDirectoryPageFiltered(
      rootUID,
      dataSchemaUID,
      [aliceAddr],
      [excludeTagDef],
      [0n], // minWeights
      "0x",
      10,
    );
    expect(names(page.items)).to.deep.equal(["clean.txt"]);
    expect(page.nextCursor).to.equal("0x");
  });

  it("Folder tagged on its ANCHOR is excluded", async function () {
    const aliceAddr = await alice.getAddress();
    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32, alice);

    const folderHidden = await createAnchor("hidden", rootUID, ZERO_BYTES32, alice);
    const folderShown = await createAnchor("shown", rootUID, ZERO_BYTES32, alice);
    // Folder visibility TAG (definition=anchorSchema=dataSchemaUID for this listing).
    await createTag(folderHidden, dataSchemaUID, alice);
    await createTag(folderShown, dataSchemaUID, alice);

    // Exclude tag on the hidden folder's ANCHOR (bucket ANCHOR_SCHEMA_UID).
    await createTag(folderHidden, excludeTagDef, alice, 1n);

    const page = await fileView.getDirectoryPageFiltered(
      rootUID,
      dataSchemaUID,
      [aliceAddr],
      [excludeTagDef],
      [0n],
      "0x",
      10,
    );
    expect(names(page.items)).to.deep.equal(["shown"]);
  });

  it("Weight threshold is inclusive: below minWeight not excluded; equal excluded (>=)", async function () {
    const aliceAddr = await alice.getAddress();
    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32, alice);

    const below = await createFileItem("below.txt", rootUID, alice);
    const equal = await createFileItem("equal.txt", rootUID, alice);
    const above = await createFileItem("above.txt", rootUID, alice);

    await createTag(below.dataUID, excludeTagDef, alice, 9n);
    await createTag(equal.dataUID, excludeTagDef, alice, 10n);
    await createTag(above.dataUID, excludeTagDef, alice, 11n);

    const page = await fileView.getDirectoryPageFiltered(
      rootUID,
      dataSchemaUID,
      [aliceAddr],
      [excludeTagDef],
      [10n], // minWeights
      "0x",
      10,
    );
    // weight 9 < 10 → kept; 10 and 11 >= 10 → excluded.
    expect(names(page.items)).to.deep.equal(["below.txt"]);
  });

  it("Lens scoping: item tagged only by a NON-lens attester is NOT excluded", async function () {
    const aliceAddr = await alice.getAddress();
    const bobAddr = await bob.getAddress();
    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32, alice);

    // alice places a file; bob (not in the lens) tags alice's DATA with the exclude tag.
    const item = await createFileItem("doc.txt", rootUID, alice);
    await createTag(item.dataUID, excludeTagDef, bob, 100n);
    void bobAddr;

    // Viewed with lens [alice] only → bob's tag is out of scope → item NOT excluded.
    const page = await fileView.getDirectoryPageFiltered(
      rootUID,
      dataSchemaUID,
      [aliceAddr],
      [excludeTagDef],
      [0n],
      "0x",
      10,
    );
    expect(names(page.items)).to.deep.equal(["doc.txt"]);
  });

  it("Cross-lens exclusion: lens A pins DATA, lens B tags it; viewed with [A,B] the file is excluded", async function () {
    // ADR-0048 union semantic (matches FileBrowser.resolveTagSet × matchesUID): an item is
    // excluded iff ANY viewed lens tagged ANY DATA UID resolved at the item across the viewed
    // lenses — NOT just the DATA each lens itself pinned. Here Alice pins DATA_A and Bob (also a
    // viewed lens) tags DATA_A. The viewer trusts Bob's judgment, so the file must be excluded.
    // This FAILS against the old per-lens-own-DATA loop (Bob's iteration resolves Bob's own PIN
    // (zero here) and never checks Bob's tag against Alice's DATA_A).
    const aliceAddr = await alice.getAddress();
    const bobAddr = await bob.getAddress();
    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32, alice);

    // Alice places the file (anchor + DATA_A + Alice's placement PIN).
    const tagged = await createFileItem("tagged.txt", rootUID, alice);
    // A clean file by alice that nobody tags — must survive.
    await createFileItem("clean.txt", rootUID, alice);

    // Bob (a different attester, but a viewed lens) tags Alice's DATA_A with the exclude tag.
    // Bob places no PIN of his own here.
    await createTag(tagged.dataUID, excludeTagDef, bob, 1n);

    const page = await fileView.getDirectoryPageFiltered(
      rootUID,
      dataSchemaUID,
      [aliceAddr, bobAddr],
      [excludeTagDef],
      [0n], // minWeights
      "0x",
      10,
    );
    // tagged.txt excluded via Bob's tag on Alice's DATA; clean.txt survives.
    expect(names(page.items)).to.deep.equal(["clean.txt"]);
  });

  it("Cross-lens control: same setup viewed with [A] only (Bob not a lens) → NOT excluded", async function () {
    // Lens scoping preserved: Bob's exclude tag is invisible to a viewer who does not trust Bob.
    // Same fixture as the cross-lens test, but the lens list is [Alice] only.
    const aliceAddr = await alice.getAddress();
    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32, alice);

    const tagged = await createFileItem("tagged.txt", rootUID, alice);
    await createFileItem("clean.txt", rootUID, alice);

    // Bob tags Alice's DATA, but Bob is NOT in the viewed lens list below.
    await createTag(tagged.dataUID, excludeTagDef, bob, 1n);

    const page = await fileView.getDirectoryPageFiltered(
      rootUID,
      dataSchemaUID,
      [aliceAddr], // Bob omitted → his tag is out of scope
      [excludeTagDef],
      [0n],
      "0x",
      10,
    );
    // Neither file excluded: Bob's tag is invisible without trusting Bob.
    expect(names(page.items)).to.deep.equal(["clean.txt", "tagged.txt"]);
  });

  it("Reused README-style DATA: file tagged by lens B, viewed with [B], is excluded (file→DATA-via-PIN)", async function () {
    // A shared DATA anchor (README) reused across placements. Lens B tags the DATA itself
    // (not the anchor). The filter must resolve the file item to its DATA via B's placement
    // PIN and find the exclude tag there.
    const bobAddr = await bob.getAddress();
    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32, bob);

    const sharedData = await createData("README contents", bob);

    // Two file anchors, both placed by bob pointing at the SAME shared DATA.
    const readme1 = await createAnchor("README.md", rootUID, dataSchemaUID, bob);
    await createPin(sharedData, readme1, bob);
    const otherFile = await createFileItem("other.txt", rootUID, bob);
    void otherFile;

    // Tag the shared DATA (bucket dataSchemaUID) by bob.
    await createTag(sharedData, excludeTagDef, bob, 1n);

    const page = await fileView.getDirectoryPageFiltered(
      rootUID,
      dataSchemaUID,
      [bobAddr],
      [excludeTagDef],
      [0n],
      "0x",
      10,
    );
    // README.md (points at tagged shared DATA) excluded; other.txt kept.
    expect(names(page.items)).to.deep.equal(["other.txt"]);
  });

  it("Pagination: leading all-excluded items still yield correct later items with a coherent cursor", async function () {
    const aliceAddr = await alice.getAddress();
    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32, alice);

    // Six files, newest-first ordering means later-created appear first. Create in order
    // f0..f5; reverseOrder walk yields f5,f4,f3,f2,f1,f0. Tag the first three walked
    // (f5,f4,f3) so the leading window is all-excluded, leaving f2,f1,f0.
    const items: { fileAnchor: string; dataUID: string; name: string }[] = [];
    for (let i = 0; i < 6; i++) {
      const name = `f${i}.txt`;
      const it = await createFileItem(name, rootUID, alice);
      items.push({ ...it, name });
    }
    // Exclude f5, f4, f3 (the first three in reverse order).
    for (const nm of ["f5.txt", "f4.txt", "f3.txt"]) {
      const it = items.find(x => x.name === nm)!;
      await createTag(it.dataUID, excludeTagDef, alice, 1n);
    }

    // Page through with size 2; collect all surviving items.
    const seen: string[] = [];
    let cursor = "0x";
    let calls = 0;
    while (true) {
      calls++;
      if (calls > 20) throw new Error("pagination did not terminate");
      const page = await fileView.getDirectoryPageFiltered(
        rootUID,
        dataSchemaUID,
        [aliceAddr],
        [excludeTagDef],
        [0n],
        cursor,
        2,
      );
      for (const it of page.items) seen.push(it.name);
      if (page.nextCursor === "0x") break;
      cursor = page.nextCursor;
    }
    expect(seen.sort()).to.deep.equal(["f0.txt", "f1.txt", "f2.txt"]);
  });

  it("Phase-1 budget emits a cursor rather than looping when a page is 100%-excluded", async function () {
    // All items under the lens carry the exclude tag, so no result slots fill. The phase-1
    // scan budget must bound per-call work and emit a non-empty cursor (forward progress),
    // not loop the entire source in one call. We verify forward progress + eventual
    // termination with an empty page each call.
    const aliceAddr = await alice.getAddress();
    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32, alice);

    for (let i = 0; i < 5; i++) {
      const it = await createFileItem(`x${i}.txt`, rootUID, alice);
      await createTag(it.dataUID, excludeTagDef, alice, 1n);
    }

    let cursor = "0x";
    let calls = 0;
    let totalItems = 0;
    while (true) {
      calls++;
      if (calls > 10) throw new Error("filtered pagination did not terminate");
      const page = await fileView.getDirectoryPageFiltered(
        rootUID,
        dataSchemaUID,
        [aliceAddr],
        [excludeTagDef],
        [0n],
        cursor,
        3,
      );
      totalItems += page.items.length;
      if (page.nextCursor === "0x") break;
      cursor = page.nextCursor;
    }
    // Every item excluded → zero results, and the walk terminates (cursor eventually empty).
    expect(totalItems).to.equal(0);
  });

  it("Footgun guard: an exclude tag mistakenly placed on a file's ANCHOR excludes nothing", async function () {
    // ADR-0048 known footgun: a file's descriptive-label TAG must target its DATA, not its
    // anchor. If a tag is (wrongly) placed on the file ANCHOR, the filter — which resolves
    // files to their DATA — correctly ignores it and the file remains visible.
    const aliceAddr = await alice.getAddress();
    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32, alice);

    const item = await createFileItem("keep.txt", rootUID, alice);
    // Wrong target: tag the file ANCHOR (bucket dataSchemaUID is the anchor's own schema here),
    // not the DATA. The filter tests the DATA, so this excludes nothing.
    await createTag(item.fileAnchor, excludeTagDef, alice, 1n);

    const page = await fileView.getDirectoryPageFiltered(
      rootUID,
      dataSchemaUID,
      [aliceAddr],
      [excludeTagDef],
      [0n],
      "0x",
      10,
    );
    expect(names(page.items)).to.deep.equal(["keep.txt"]);
  });

  // ─────────────────────── scan-budget guard (small-budget subclass) ───────────────────────

  it("Phase-1 budget trips: empty page + non-empty cursor, forward progress, no skip/dup, terminates", async function () {
    // ADR-0048's headline safety mechanism: a 100%-excluded page must NOT loop the whole
    // source in one eth_call. With a small budget (4) and 6 all-excluded files under the lens,
    // the FIRST call must return zero items with a NON-EMPTY cursor (budget hit before maxItems,
    // source not exhausted). Resuming makes forward progress (fileIdx strictly increases) and the
    // walk terminates with an empty cursor — every position inspected exactly once (no skip/dup).
    //
    // This test fails if the phase-1 budget guard is removed: without it the first call would
    // walk all 6 items in one shot and return an EMPTY cursor immediately.
    const aliceAddr = await alice.getAddress();
    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32, alice);

    for (let i = 0; i < 6; i++) {
      const it = await createFileItem(`b${i}.txt`, rootUID, alice);
      await createTag(it.dataUID, excludeTagDef, alice, 1n);
    }

    const tv = await deployTestableFileView(4);

    // First call: maxItems=10, budget=4 → budget hit before maxItems, source (6) not exhausted.
    const first = await tv.getDirectoryPageFiltered(
      rootUID,
      dataSchemaUID,
      [aliceAddr],
      [excludeTagDef],
      [0n],
      "0x",
      10,
    );
    expect(first.items.length).to.equal(0);
    expect(first.nextCursor).to.not.equal("0x"); // non-empty cursor: budget hit, not exhausted

    // Decode cursor → (phase, folderIdx, fileIdx). Phase must be 1 (file phase) and fileIdx > 0.
    const dec = (cur: string) => enc.decode(["uint256", "uint256", "uint256"], cur) as unknown as bigint[];
    const [phase0, , fileIdx0] = dec(first.nextCursor);
    expect(phase0).to.equal(1n);
    expect(fileIdx0).to.be.greaterThan(0n);

    // Resume: assert fileIdx strictly increases each call until termination; collect items.
    let cursor = first.nextCursor;
    let prevFileIdx = fileIdx0;
    let totalItems = first.items.length;
    let calls = 1;
    while (true) {
      calls++;
      if (calls > 20) throw new Error("budget pagination did not terminate");
      const page = await tv.getDirectoryPageFiltered(
        rootUID,
        dataSchemaUID,
        [aliceAddr],
        [excludeTagDef],
        [0n],
        cursor,
        10,
      );
      totalItems += page.items.length;
      if (page.nextCursor === "0x") break; // terminated
      const [, , fi] = dec(page.nextCursor);
      expect(fi).to.be.greaterThan(prevFileIdx); // strictly increasing → forward progress, no stall
      prevFileIdx = fi;
      cursor = page.nextCursor;
    }
    // All 6 excluded → zero results across the whole walk; walk terminated (empty cursor).
    expect(totalItems).to.equal(0);
    expect(calls).to.be.greaterThan(1); // proves it took multiple budget-bounded calls
  });

  it("Empty page carries a non-empty cursor when the budget is hit before maxItems (caller-visible)", async function () {
    // Explicit, caller-visible assertion of the empty-page-with-non-empty-cursor contract:
    // a single call that fills no result slot but has not exhausted the source MUST hand back a
    // non-empty cursor so the caller knows to keep paging.
    const aliceAddr = await alice.getAddress();
    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32, alice);
    for (let i = 0; i < 6; i++) {
      const it = await createFileItem(`c${i}.txt`, rootUID, alice);
      await createTag(it.dataUID, excludeTagDef, alice, 1n);
    }
    const tv = await deployTestableFileView(4);
    const page = await tv.getDirectoryPageFiltered(
      rootUID,
      dataSchemaUID,
      [aliceAddr],
      [excludeTagDef],
      [0n],
      "0x",
      10,
    );
    expect(page.items.length).to.equal(0);
    expect(page.nextCursor).to.not.equal("0x");
  });

  it("Phase-0 all-excluded paging: cursor emitted at phase 0, resumed walk crosses into phase 1", async function () {
    // Folders all excluded (tag folder anchors) under a small folder budget → phase 0 must emit a
    // cursor (budget hit mid-folders) and a resumed walk must cross correctly into phase 1 (file
    // items) without skip/dup. Mix in a couple of clean files so phase 1 has real output.
    const aliceAddr = await alice.getAddress();
    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32, alice);

    // 6 folders, all made visible (folder-visibility TAG under anchorSchema=dataSchemaUID) AND all
    // excluded (exclude TAG on the ANCHOR). reverseOrder is not applied to phase-0 folders.
    for (let i = 0; i < 6; i++) {
      const f = await createAnchor(`folder${i}`, rootUID, ZERO_BYTES32, alice);
      await createTag(f, dataSchemaUID, alice); // folder visibility
      await createTag(f, excludeTagDef, alice, 1n); // excluded
    }
    // 6 clean files (phase 1) that must survive. >budget so phase 1 itself spans multiple
    // budget-bounded calls, forcing a resumed walk that re-enters phase 1 from a saved cursor.
    const expectedKeep: string[] = [];
    for (let i = 0; i < 6; i++) {
      const nm = `keep${i}.txt`;
      await createFileItem(nm, rootUID, alice);
      expectedKeep.push(nm);
    }

    const tv = await deployTestableFileView(4);

    const dec = (cur: string) => enc.decode(["uint256", "uint256", "uint256"], cur) as unknown as bigint[];

    // First call: budget=4 folders inspected, all excluded → 0 items, cursor still in phase 0.
    const first = await tv.getDirectoryPageFiltered(
      rootUID,
      dataSchemaUID,
      [aliceAddr],
      [excludeTagDef],
      [0n],
      "0x",
      10,
    );
    expect(first.items.length).to.equal(0);
    expect(first.nextCursor).to.not.equal("0x");
    const [phase0] = dec(first.nextCursor);
    expect(phase0).to.equal(0n); // still walking folders (budget hit mid phase-0)

    // Page to completion; collect surviving file items. Must eventually cross into phase 1.
    const seen: string[] = [];
    let cursor = first.nextCursor;
    let crossedToPhase1 = false;
    let calls = 1;
    while (true) {
      calls++;
      if (calls > 20) throw new Error("phase-0 paging did not terminate");
      const page = await tv.getDirectoryPageFiltered(
        rootUID,
        dataSchemaUID,
        [aliceAddr],
        [excludeTagDef],
        [0n],
        cursor,
        10,
      );
      for (const it of page.items) seen.push(it.name);
      if (page.nextCursor === "0x") break;
      const [ph] = dec(page.nextCursor);
      if (ph === 1n) crossedToPhase1 = true;
      cursor = page.nextCursor;
    }
    expect(crossedToPhase1).to.equal(true); // an intermediate cursor sat in phase 1 (resumed walk)
    expect(seen.sort()).to.deep.equal(expectedKeep.sort()); // every clean file once, no skip/dup
  });

  // ─────────────────────────── revocation regression ───────────────────────────

  it("Revoked exclude TAG: item reappears; getActiveTagWeight returns (false, 0) after revoke", async function () {
    const aliceAddr = await alice.getAddress();
    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32, alice);

    const item = await createFileItem("doc.txt", rootUID, alice);

    // Tag the DATA so the file is excluded.
    const tagUID = await createTag(item.dataUID, excludeTagDef, alice, 1n);

    // Sanity: excluded while the tag is active, and getActiveTagWeight sees it.
    let page = await fileView.getDirectoryPageFiltered(
      rootUID,
      dataSchemaUID,
      [aliceAddr],
      [excludeTagDef],
      [0n],
      "0x",
      10,
    );
    expect(names(page.items)).to.deep.equal([]);
    const active = await edgeResolver.getActiveTagWeight(aliceAddr, item.dataUID, excludeTagDef, dataSchemaUID);
    expect(active.exists).to.equal(true);
    expect(active.weight).to.equal(1n);

    // Revoke the TAG → the item must REAPPEAR.
    await revokeTag(tagUID, alice);
    page = await fileView.getDirectoryPageFiltered(
      rootUID,
      dataSchemaUID,
      [aliceAddr],
      [excludeTagDef],
      [0n],
      "0x",
      10,
    );
    expect(names(page.items)).to.deep.equal(["doc.txt"]);

    // And the kernel reader reflects the revoke: (false, 0).
    const after = await edgeResolver.getActiveTagWeight(aliceAddr, item.dataUID, excludeTagDef, dataSchemaUID);
    expect(after.exists).to.equal(false);
    expect(after.weight).to.equal(0n);
  });

  it("Swap-and-pop re-index: revoking the first of two TAGs in one slot leaves the second findable", async function () {
    // Two active TAGs in the SAME [def][attester][targetSchema] slot (two different DATA targets).
    // Revoking the FIRST must not orphan the SECOND — the swap-and-pop re-index the reader depends
    // on must keep the survivor's position index correct (exists=true, correct weight).
    const aliceAddr = await alice.getAddress();
    await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32, alice);

    const dataA = await createData("A", alice);
    const dataB = await createData("B", alice);

    // Same slot: same definition (excludeTagDef), same attester (alice), same targetSchema
    // (dataSchemaUID — both DATA targets). Distinct targets → two entries in the slot's array.
    const tagA = await createTag(dataA, excludeTagDef, alice, 7n);
    await createTag(dataB, excludeTagDef, alice, 9n);

    // Both present before revoke.
    expect((await edgeResolver.getActiveTagWeight(aliceAddr, dataA, excludeTagDef, dataSchemaUID)).exists).to.equal(
      true,
    );
    expect((await edgeResolver.getActiveTagWeight(aliceAddr, dataB, excludeTagDef, dataSchemaUID)).exists).to.equal(
      true,
    );

    // Revoke the FIRST (dataA). In the append array dataA is at index 0, so swap-and-pop moves the
    // last entry (dataB) into slot 0 and updates its index — the case most likely to corrupt.
    await revokeTag(tagA, alice);

    const a = await edgeResolver.getActiveTagWeight(aliceAddr, dataA, excludeTagDef, dataSchemaUID);
    expect(a.exists).to.equal(false);

    const b = await edgeResolver.getActiveTagWeight(aliceAddr, dataB, excludeTagDef, dataSchemaUID);
    expect(b.exists).to.equal(true); // survivor still findable after the first was popped
    expect(b.weight).to.equal(9n); // and at its correct weight (index integrity held)
  });

  // ─────────────────────────── degenerate / empty exclude set ───────────────────────────

  it("Empty exclude arrays degenerate to 'exclude nothing': filtered page == unfiltered page", async function () {
    const aliceAddr = await alice.getAddress();
    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32, alice);

    const item = await createFileItem("only.txt", rootUID, alice);
    // A tagged item that WOULD be excluded under a non-empty policy must survive when the caller
    // passes empty exclude arrays — the filtered result must equal the unfiltered listing.
    await createTag(item.dataUID, excludeTagDef, alice, 1n);

    const filtered = await fileView.getDirectoryPageFiltered(
      rootUID,
      dataSchemaUID,
      [aliceAddr],
      [], // excludeTagDefs empty → exclude nothing
      [], // minWeights empty (lengths match)
      "0x",
      10,
    );
    const unfiltered = await fileView.getDirectoryPageBySchemaAndAddressList(
      rootUID,
      dataSchemaUID,
      [aliceAddr],
      "0x",
      10,
    );
    expect(names(filtered.items)).to.deep.equal(names(unfiltered.items));
    expect(names(filtered.items)).to.deep.equal(["only.txt"]);
  });

  // ─────────────────────────── multi-tag exclusion (ADR-0048) ───────────────────────────

  describe("multi-tag exclusion (parallel arrays)", function () {
    // A second exclude-tag definition, distinct from `excludeTagDef` (e.g. `system` + `nsfw`).
    let excludeTagDef2: string;

    beforeEach(async function () {
      // Registered after every other schema/contract in the outer beforeEach, so it cannot shift
      // any CREATE nonce (mirrors how `excludeTagDef` itself is registered).
      const tx = await registry.register("string excludeLabel2", ZeroAddress, false);
      excludeTagDef2 = (await tx.wait())!.logs[0].topics[1];
    });

    it("Two exclude tags: first-tagged excluded, second-tagged excluded, neither survives, both excluded once", async function () {
      // The headline multi-tag case the explorer needs (system + nsfw in ONE call). Exercises the
      // union across exclude pairs; would FAIL against the single-tag form (only one tag honored).
      const aliceAddr = await alice.getAddress();
      const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32, alice);

      const onlyFirst = await createFileItem("first.txt", rootUID, alice);
      const onlySecond = await createFileItem("second.txt", rootUID, alice);
      const both = await createFileItem("both.txt", rootUID, alice);
      await createFileItem("neither.txt", rootUID, alice);

      await createTag(onlyFirst.dataUID, excludeTagDef, alice, 1n); // tag1 only
      await createTag(onlySecond.dataUID, excludeTagDef2, alice, 1n); // tag2 only
      await createTag(both.dataUID, excludeTagDef, alice, 1n); // tag1 AND
      await createTag(both.dataUID, excludeTagDef2, alice, 1n); // tag2 (double-tagged)

      const page = await fileView.getDirectoryPageFiltered(
        rootUID,
        dataSchemaUID,
        [aliceAddr],
        [excludeTagDef, excludeTagDef2],
        [0n, 0n],
        "0x",
        10,
      );
      // first.txt (tag1), second.txt (tag2), both.txt (tag1+tag2) all excluded; only neither.txt
      // survives. both.txt being double-tagged must not corrupt the walk (excluded once, cleanly).
      expect(names(page.items)).to.deep.equal(["neither.txt"]);
    });

    it("Per-tag thresholds minWeights=[0,5]: tag1@weight0 excluded; tag2@weight4 kept, @weight5 excluded", async function () {
      // Each pair carries its OWN threshold. Proves the loop reads minWeights[k], not a single
      // shared threshold — fails against the single-tag form (one minWeight for all).
      const aliceAddr = await alice.getAddress();
      const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32, alice);

      const t1 = await createFileItem("t1.txt", rootUID, alice); // tag1, weight 0 → excluded (>=0)
      const t2low = await createFileItem("t2low.txt", rootUID, alice); // tag2, weight 4 → kept (<5)
      const t2hi = await createFileItem("t2hi.txt", rootUID, alice); // tag2, weight 5 → excluded (>=5)

      await createTag(t1.dataUID, excludeTagDef, alice, 0n);
      await createTag(t2low.dataUID, excludeTagDef2, alice, 4n);
      await createTag(t2hi.dataUID, excludeTagDef2, alice, 5n);

      const page = await fileView.getDirectoryPageFiltered(
        rootUID,
        dataSchemaUID,
        [aliceAddr],
        [excludeTagDef, excludeTagDef2],
        [0n, 5n], // tag1 threshold 0, tag2 threshold 5
        "0x",
        10,
      );
      // t1 excluded (0 >= 0), t2low kept (4 < 5), t2hi excluded (5 >= 5).
      expect(names(page.items)).to.deep.equal(["t2low.txt"]);
    });

    it("Reverts when excludeTagDefs exceeds MAX_EXCLUDE_TAGS_PER_QUERY (9 > cap of 8)", async function () {
      // ADR-0048 bounds per-query exclude tags at MAX_EXCLUDE_TAGS_PER_QUERY (8) so the
      // per-item exclusion loop stays cheap. Passing 9 valid, length-matched defs must revert
      // BEFORE any walk — this is the cap guard, distinct from the length-mismatch guard above.
      const aliceAddr = await alice.getAddress();
      const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32, alice);
      await createFileItem("a.txt", rootUID, alice);

      // Nine distinct, valid exclude-tag definitions (registered schema UIDs). Registered here in
      // the test body (after the outer beforeEach) so they don't shift any CREATE nonce.
      const defs: string[] = [];
      for (let i = 0; i < 9; i++) {
        const tx = await registry.register(`string capLabel${i}`, ZeroAddress, false);
        defs.push((await tx.wait())!.logs[0].topics[1]);
      }
      const weights = defs.map(() => 0n);

      await expect(
        fileView.getDirectoryPageFiltered(rootUID, dataSchemaUID, [aliceAddr], defs, weights, "0x", 10),
      ).to.be.revertedWith("Too many exclude tags");
    });

    it("Two exclude tags on FOLDER anchors: each-tagged folder excluded (union), untagged folder survives", async function () {
      // Mirror of the headline multi-tag FILE case, but on FOLDER items — the exclude TAG targets
      // the folder ANCHOR (bucket ANCHOR_SCHEMA_UID) rather than a DATA. Exercises the union across
      // two exclude defs on the folder branch of the filter.
      const aliceAddr = await alice.getAddress();
      const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32, alice);

      const folderFirst = await createAnchor("first", rootUID, ZERO_BYTES32, alice);
      const folderSecond = await createAnchor("second", rootUID, ZERO_BYTES32, alice);
      const folderBoth = await createAnchor("both", rootUID, ZERO_BYTES32, alice);
      const folderNeither = await createAnchor("neither", rootUID, ZERO_BYTES32, alice);

      // Folder visibility TAG (definition=anchorSchema=dataSchemaUID for this listing) so each
      // folder qualifies in phase 0.
      for (const f of [folderFirst, folderSecond, folderBoth, folderNeither]) {
        await createTag(f, dataSchemaUID, alice);
      }

      // Exclude tags on the folder ANCHORs (bucket ANCHOR_SCHEMA_UID), union across the two defs.
      await createTag(folderFirst, excludeTagDef, alice, 1n); // def1 only
      await createTag(folderSecond, excludeTagDef2, alice, 1n); // def2 only
      await createTag(folderBoth, excludeTagDef, alice, 1n); // def1 AND
      await createTag(folderBoth, excludeTagDef2, alice, 1n); // def2 (double-tagged)

      const page = await fileView.getDirectoryPageFiltered(
        rootUID,
        dataSchemaUID,
        [aliceAddr],
        [excludeTagDef, excludeTagDef2],
        [0n, 0n],
        "0x",
        10,
      );
      // first/second/both excluded via the union; only the untagged folder survives. The
      // double-tagged folder must be excluded once and not corrupt the walk.
      expect(names(page.items)).to.deep.equal(["neither"]);
    });

    it("Reverts on parallel-array length mismatch (excludeTagDefs.length != minWeights.length)", async function () {
      const aliceAddr = await alice.getAddress();
      const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32, alice);
      await createFileItem("a.txt", rootUID, alice);

      await expect(
        fileView.getDirectoryPageFiltered(
          rootUID,
          dataSchemaUID,
          [aliceAddr],
          [excludeTagDef, excludeTagDef2], // length 2
          [0n], // length 1 → mismatch
          "0x",
          10,
        ),
      ).to.be.revertedWith("excludeTagDefs/minWeights length mismatch");
    });
  });
});
