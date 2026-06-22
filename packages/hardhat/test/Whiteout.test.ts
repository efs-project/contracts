import { expect } from "chai";
import { ethers } from "hardhat";
import {
  WhiteoutResolver,
  EFSIndexer,
  EdgeResolver,
  EFSFileView,
  EFSRouter,
  EAS,
  SchemaRegistry,
} from "../typechain-types";
import { Signer, ZeroAddress, ZeroHash } from "ethers";
import { deployIndexerProxy } from "./helpers/deployIndexerProxy";
import { deployResolverProxy } from "./helpers/deployResolverProxy";

/**
 * Whiteout — conformance suite for the WHITEOUT cross-lens negative mask (ADR-0055).
 *
 * WHITEOUT = "render this path empty in MY view; stop fall-through to lower lenses" WITHOUT
 * substituting the lens's own content (overlayfs whiteout / lens-local delete). The one filesystem
 * primitive additive-only lenses otherwise lack.
 *
 * Covers the per-name vectors (1–12) PLUS the per-name folder + folder-fix vectors (13–14, ADR-0055):
 *   1  per-name whiteout hides one child in a directory listing
 *   2  lens-scoped below — Lk's whiteout suppresses a lower lens's placement
 *   3  lens-scoped above transparent — higher lens's positive PIN beats lower lens's whiteout
 *   4  same-lens positive override — a lens's own newer PIN beats its own earlier whiteout
 *   5  revoke un-hides
 *   6  idempotent / no-op-safe — whiteout of an empty path resolves empty, no revert
 *   7  cross-lens unaffected — viewer not including Lk still sees the item
 *   8  re-whiteout last-writer-wins — revoking a stale UID doesn't clear a newer marker
 *   9  write-guard rejections — each invalid write reverts with the resolver's specific error
 *   10 router negative-terminal — router serves not-found, no fall-through to a lower lens
 *   11 getFilesAtPath negative terminal — view/router consistency
 *   12 whiteout in the FILTERED listing — doubly-suppressed skipped exactly once
 *   13 folder whiteout hides a (visibility-TAG-listed) folder
 *   14 folder whiteout + same-lens visibility-TAG re-add → visible (THE FOLDER-FIX)
 *   15 plain phase-1 listing scan is BUDGET-BOUNDED when many direct files are whited out
 *
 * HARNESS: the beforeEach predicts deterministic CREATE addresses via the deployer nonce, so this
 * file MUST be run as a FULL FILE (`yarn test test/Whiteout.test.ts`), NEVER via `--grep` — a grep
 * run that skips deploy txs desyncs the nonce predictions.
 */

const ZERO_BYTES32 = ZeroHash;
const NO_EXPIRATION = 0n;

// FROZEN schema field strings (must be byte-identical to the deploy registrations — hashed into UID).
const ANCHOR_SCHEMA = "string name, bytes32 forSchema";
const PROPERTY_SCHEMA = "string value";
const DATA_SCHEMA = ""; // empty (pure identity, ADR-0049)
const PIN_SCHEMA = "bytes32 definition";
const TAG_SCHEMA = "bytes32 definition, int256 weight";
const WHITEOUT_SCHEMA = ""; // empty (pure-identity negative marker, ADR-0055)

describe("Whiteout (WHITEOUT cross-lens negative mask, ADR-0055)", function () {
  let indexer: EFSIndexer;
  let edgeResolver: EdgeResolver;
  let whiteoutResolver: WhiteoutResolver;
  let fileView: EFSFileView;
  let eas: EAS;
  let registry: SchemaRegistry;

  let owner: Signer; // primary lens (Lk)
  let alice: Signer; // lower / other lens
  let bob: Signer; // third lens

  let ownerAddr: string;
  let aliceAddr: string;
  let bobAddr: string;

  let anchorSchemaUID: string;
  let dataSchemaUID: string;
  let propertySchemaUID: string;
  let pinSchemaUID: string;
  let tagSchemaUID: string;
  let whiteoutSchemaUID: string;
  let mirrorSchemaUID: string;

  let whiteoutResolverAddr: string;

  const enc = new ethers.AbiCoder();

  const getUID = (receipt: any): string => {
    for (const log of receipt.logs) {
      try {
        const parsed = eas.interface.parseLog(log);
        if (parsed?.name === "Attested") return parsed.args.uid;
      } catch {
        /* ignore */
      }
    }
    throw new Error("No Attested event found");
  };

  // ── Mint helpers ───────────────────────────────────────────────────────────

  /** Create an anchor (generic folder when schema=0, file anchor when schema=dataSchemaUID). */
  const createAnchor = async (
    name: string,
    parentUID: string,
    forSchema: string = ZERO_BYTES32,
    signer: Signer = owner,
  ): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: parentUID,
        data: enc.encode(["string", "bytes32"], [name, forSchema]),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  /** Mint a DATA attestation (empty, pure identity, ADR-0049). */
  const mintData = async (signer: Signer = owner): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: dataSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: ZERO_BYTES32,
        data: "0x",
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  /** Mint a free-floating PROPERTY value (non-revocable, ADR-0052). */
  const mintProperty = async (value: string, signer: Signer = owner): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: propertySchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: ZERO_BYTES32,
        data: enc.encode(["string"], [value]),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  /** Create a TAG (cardinality N). definition=def, refUID=target, with weight (default 1). */
  const createTag = async (
    definition: string,
    target: string,
    signer: Signer = owner,
    weight: bigint = 1n,
  ): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: tagSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: target,
        data: enc.encode(["bytes32", "int256"], [definition, weight]),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  /** Create a PIN (cardinality 1 — file placement). definition=anchor, refUID=DATA. */
  const createPin = async (definition: string, target: string, signer: Signer = owner): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: pinSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: target,
        data: enc.encode(["bytes32"], [definition]),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  /**
   * Attest a WHITEOUT. refUID = the suppressed source (a child path ANCHOR). The WHITEOUT field
   * string is empty (pure-identity marker), revocable=true, expiration=0 (the canonical valid shape).
   * The optional `override` lets the write-guard vectors deliberately produce invalid shapes.
   */
  const attestWhiteout = async (
    refUID: string,
    signer: Signer = owner,
    override: {
      data?: string;
      revocable?: boolean;
      expirationTime?: bigint;
      schema?: string;
    } = {},
  ): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: override.schema ?? whiteoutSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: override.expirationTime ?? NO_EXPIRATION,
        revocable: override.revocable ?? true,
        refUID,
        data: override.data ?? "0x",
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  const revoke = async (schema: string, uid: string, signer: Signer = owner): Promise<void> => {
    await eas.connect(signer).revoke({ schema, data: { uid, value: 0n } });
  };

  beforeEach(async function () {
    [owner, alice, bob] = await ethers.getSigners();
    ownerAddr = await owner.getAddress();
    aliceAddr = await alice.getAddress();
    bobAddr = await bob.getAddress();

    const RegistryFactory = await ethers.getContractFactory("SchemaRegistry");
    registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();

    const EASFactory = await ethers.getContractFactory("EAS");
    eas = await EASFactory.deploy(await registry.getAddress());
    await eas.waitForDeployment();

    // ── Nonce-predicted deploy plan ────────────────────────────────────────────
    // The WhiteoutResolver self-derives its WHITEOUT schema UID against its PROXY address in
    // initialize() (delegatecall ⇒ address(this) == proxy), and its initialize() reads
    // indexer.ANCHOR_SCHEMA_UID() + getParent — so the indexer must already exist when the whiteout
    // PROXY is initialized. Deploy order (each *Proxy helper runs impl-then-proxy = 2 txs):
    //   +0  EdgeResolver impl
    //   +1  EdgeResolver proxy        ← resolver baked into PIN/TAG UIDs
    //   +2  EFSIndexer impl
    //   +3  EFSIndexer proxy          ← resolver baked into ANCHOR/PROPERTY/DATA UIDs
    //   +4..+9   6 schema registrations (ANCHOR, PROPERTY, DATA, PIN, TAG, WHITEOUT)
    //   +10 WhiteoutResolver impl
    //   +11 WhiteoutResolver proxy    ← resolver baked into the WHITEOUT UID; initialized last
    const n = await ethers.provider.getTransactionCount(ownerAddr);
    const futureEdgeResolverAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: n + 1 });
    const futureIndexerAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: n + 3 });
    whiteoutResolverAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: n + 11 });

    anchorSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      [ANCHOR_SCHEMA, futureIndexerAddr, false],
    );
    propertySchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      [PROPERTY_SCHEMA, futureIndexerAddr, false],
    );
    dataSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      [DATA_SCHEMA, futureIndexerAddr, false],
    );
    pinSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      [PIN_SCHEMA, futureEdgeResolverAddr, true],
    );
    tagSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      [TAG_SCHEMA, futureEdgeResolverAddr, true],
    );
    whiteoutSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      [WHITEOUT_SCHEMA, whiteoutResolverAddr, true],
    );

    // (+0,+1) EdgeResolver behind a proxy — initialize sets PIN/TAG UIDs + partner refs.
    edgeResolver = await deployResolverProxy<EdgeResolver>(
      "EdgeResolver",
      [await eas.getAddress()],
      [pinSchemaUID, tagSchemaUID, futureIndexerAddr, await registry.getAddress()],
      owner,
    );
    expect(await edgeResolver.getAddress()).to.equal(futureEdgeResolverAddr);

    // (+2,+3) EFSIndexer behind a proxy.
    indexer = await deployIndexerProxy(
      await eas.getAddress(),
      anchorSchemaUID,
      propertySchemaUID,
      dataSchemaUID,
      owner,
    );
    expect(await indexer.getAddress()).to.equal(futureIndexerAddr);

    // (+4..+9) Register the 6 schemas against their (predicted) resolvers.
    await (await registry.register(ANCHOR_SCHEMA, futureIndexerAddr, false)).wait();
    await (await registry.register(PROPERTY_SCHEMA, futureIndexerAddr, false)).wait();
    await (await registry.register(DATA_SCHEMA, futureIndexerAddr, false)).wait();
    await (await registry.register(PIN_SCHEMA, futureEdgeResolverAddr, true)).wait();
    await (await registry.register(TAG_SCHEMA, futureEdgeResolverAddr, true)).wait();
    await (await registry.register(WHITEOUT_SCHEMA, whiteoutResolverAddr, true)).wait();

    // (+10,+11) WhiteoutResolver behind a proxy. initialize(indexer) reads ANCHOR_SCHEMA_UID +
    // getParent — the indexer already exists, so this resolves cleanly.
    whiteoutResolver = await deployResolverProxy<WhiteoutResolver>(
      "WhiteoutResolver",
      [await eas.getAddress()],
      [await indexer.getAddress()],
      owner,
    );
    expect(await whiteoutResolver.getAddress()).to.equal(whiteoutResolverAddr);
    // Self-UID verify gate: the resolver derived the same WHITEOUT UID we registered.
    expect(await whiteoutResolver.whiteoutSchemaUID()).to.equal(whiteoutSchemaUID);
    expect(await whiteoutResolver.anchorSchemaUID()).to.equal(anchorSchemaUID);

    // Wire the indexer → edgeResolver link so EdgeResolver.onAttest can call propagateContains.
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

    // EFSFileView wired WITH the whiteout resolver (3rd ctor arg).
    const FileViewFactory = await ethers.getContractFactory("EFSFileView");
    fileView = (await FileViewFactory.deploy(
      await indexer.getAddress(),
      await edgeResolver.getAddress(),
      await whiteoutResolver.getAddress(),
    )) as EFSFileView;
    await fileView.waitForDeployment();

    void mirrorSchemaUID;
    void propertySchemaUID;
  });

  // ════════════════════════════════════════════════════════════════════════════
  // VECTOR 1 — per-name whiteout hides one child in a directory listing
  // ════════════════════════════════════════════════════════════════════════════
  it("vector 1: per-name whiteout hides exactly one child in a folder listing", async function () {
    const root = await createAnchor("root", ZERO_BYTES32);
    const dir = await createAnchor("dir", root);

    // Two file anchors under dir, both placed (PIN) by ALICE so they list as files. Owner views
    // [owner, alice] and whites out one child — the canonical per-name hide of a lower lens's
    // content (a lens whiting out its OWN placement is the same-lens-override case, vector 4).
    const keepAnchor = await createAnchor("keep.txt", dir, dataSchemaUID);
    const hideAnchor = await createAnchor("hide.txt", dir, dataSchemaUID);
    const dKeep = await mintData(alice);
    const dHide = await mintData(alice);
    await createPin(keepAnchor, dKeep, alice);
    await createPin(hideAnchor, dHide, alice);

    // Sanity: both visible before any whiteout (viewer = [owner, alice]).
    let page = await fileView.getDirectoryPageBySchemaAndAddressList(
      dir,
      dataSchemaUID,
      [ownerAddr, aliceAddr],
      "0x",
      10,
    );
    expect(page.items.map(i => i.uid)).to.have.members([keepAnchor, hideAnchor]);

    // Owner whites out hide.txt in his own view.
    await attestWhiteout(hideAnchor, owner);
    expect(await whiteoutResolver.isWhitedOut(dir, ownerAddr, hideAnchor)).to.equal(true);

    page = await fileView.getDirectoryPageBySchemaAndAddressList(dir, dataSchemaUID, [ownerAddr, aliceAddr], "0x", 10);
    expect(page.items.map(i => i.uid)).to.deep.equal([keepAnchor]); // exactly one hidden
  });

  // ════════════════════════════════════════════════════════════════════════════
  // VECTOR 2 — lens-scoped below: Lk's whiteout suppresses a LOWER lens's placement
  // ════════════════════════════════════════════════════════════════════════════
  it("vector 2: Lk's whiteout suppresses a lower lens's placement (no fall-through)", async function () {
    const root = await createAnchor("root", ZERO_BYTES32);
    const dir = await createAnchor("dir", root);
    const fileAnchor = await createAnchor("doc.txt", dir, dataSchemaUID);

    // ALICE (lower lens) places the file; OWNER (higher lens) has no placement of his own.
    const dAlice = await mintData(alice);
    await createPin(fileAnchor, dAlice, alice);

    // Viewer = [owner, alice]. Owner whites out the entry → suppresses alice's placement below.
    await attestWhiteout(fileAnchor, owner);

    const page = await fileView.getDirectoryPageBySchemaAndAddressList(
      dir,
      dataSchemaUID,
      [ownerAddr, aliceAddr],
      "0x",
      10,
    );
    expect(page.items.map(i => i.uid)).to.not.include(fileAnchor);
    expect(page.items.length).to.equal(0);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // VECTOR 3 — lens-scoped above transparent: higher lens's positive PIN beats a lower
  //            lens's whiteout (the item is visible)
  // ════════════════════════════════════════════════════════════════════════════
  it("vector 3: higher lens's positive PIN beats a lower lens's whiteout (visible)", async function () {
    const root = await createAnchor("root", ZERO_BYTES32);
    const dir = await createAnchor("dir", root);
    const fileAnchor = await createAnchor("doc.txt", dir, dataSchemaUID);

    // ALICE (lower lens) whites the entry out; OWNER (higher lens) places his own content there.
    await attestWhiteout(fileAnchor, alice);
    const dOwner = await mintData(owner);
    await createPin(fileAnchor, dOwner, owner);

    // Viewer = [owner, alice]: owner's positive PIN terminates the scan before alice's whiteout.
    const page = await fileView.getDirectoryPageBySchemaAndAddressList(
      dir,
      dataSchemaUID,
      [ownerAddr, aliceAddr],
      "0x",
      10,
    );
    expect(page.items.map(i => i.uid)).to.deep.equal([fileAnchor]); // visible

    // Symmetry: with ONLY alice as the lens, her whiteout DOES suppress it.
    const aliceOnly = await fileView.getDirectoryPageBySchemaAndAddressList(dir, dataSchemaUID, [aliceAddr], "0x", 10);
    expect(aliceOnly.items.length).to.equal(0);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // VECTOR 4 — same-lens positive override: a lens's own NEWER PIN beats its own earlier whiteout
  // ════════════════════════════════════════════════════════════════════════════
  it("vector 4: a lens's own newer PIN beats its own earlier whiteout (positive-before-whiteout)", async function () {
    const root = await createAnchor("root", ZERO_BYTES32);
    const dir = await createAnchor("dir", root);
    const fileAnchor = await createAnchor("doc.txt", dir, dataSchemaUID);

    // Owner first whites it out, THEN places his own content at the same anchor.
    await attestWhiteout(fileAnchor, owner);
    const dOwner = await mintData(owner);
    await createPin(fileAnchor, dOwner, owner);

    // The marker is still live (whiteout was not revoked), but the predicate checks the positive
    // PIN FIRST within the lens → visible.
    expect(await whiteoutResolver.isWhitedOut(dir, ownerAddr, fileAnchor)).to.equal(true);
    const page = await fileView.getDirectoryPageBySchemaAndAddressList(dir, dataSchemaUID, [ownerAddr], "0x", 10);
    expect(page.items.map(i => i.uid)).to.deep.equal([fileAnchor]);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // VECTOR 5 — revoke un-hides
  // ════════════════════════════════════════════════════════════════════════════
  it("vector 5: revoking the whiteout un-hides the entry", async function () {
    const root = await createAnchor("root", ZERO_BYTES32);
    const dir = await createAnchor("dir", root);
    const fileAnchor = await createAnchor("doc.txt", dir, dataSchemaUID);
    const dAlice = await mintData(alice);
    await createPin(fileAnchor, dAlice, alice);

    const woUID = await attestWhiteout(fileAnchor, owner);
    expect(await whiteoutResolver.isWhitedOut(dir, ownerAddr, fileAnchor)).to.equal(true);
    let page = await fileView.getDirectoryPageBySchemaAndAddressList(
      dir,
      dataSchemaUID,
      [ownerAddr, aliceAddr],
      "0x",
      10,
    );
    expect(page.items.length).to.equal(0);

    await revoke(whiteoutSchemaUID, woUID, owner);
    expect(await whiteoutResolver.isWhitedOut(dir, ownerAddr, fileAnchor)).to.equal(false);

    page = await fileView.getDirectoryPageBySchemaAndAddressList(dir, dataSchemaUID, [ownerAddr, aliceAddr], "0x", 10);
    expect(page.items.map(i => i.uid)).to.deep.equal([fileAnchor]); // alice's placement now falls through
  });

  // ════════════════════════════════════════════════════════════════════════════
  // VECTOR 6 — idempotent / no-op-safe: whiteout of a path with no lower content
  // ════════════════════════════════════════════════════════════════════════════
  it("vector 6: whiteout of a path with no lower content succeeds, resolves empty, no revert", async function () {
    const root = await createAnchor("root", ZERO_BYTES32);
    const dir = await createAnchor("dir", root);
    // A bare anchor with NO placement under any lens.
    const emptyAnchor = await createAnchor("ghost.txt", dir, dataSchemaUID);

    // Whiting out an empty path does not revert (attestWhiteout throws on revert) and marks active.
    await attestWhiteout(emptyAnchor, owner);
    expect(await whiteoutResolver.isWhitedOut(dir, ownerAddr, emptyAnchor)).to.equal(true);

    // Re-whiteout the SAME child by the SAME attester: idempotent (no double-push, no revert).
    await attestWhiteout(emptyAnchor, owner);
    // Discovery list holds the child exactly once (append-once membership guard).
    expect(await whiteoutResolver.getChildrenWhitedOutCount(dir, ownerAddr)).to.equal(1n);

    // Listing resolves to empty (the anchor never had a placement anyway).
    const page = await fileView.getDirectoryPageBySchemaAndAddressList(dir, dataSchemaUID, [ownerAddr], "0x", 10);
    expect(page.items.length).to.equal(0);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // VECTOR 7 — cross-lens unaffected: a viewer NOT including Lk still sees the item
  // ════════════════════════════════════════════════════════════════════════════
  it("vector 7: a viewer not including the whiteout author still sees the item", async function () {
    const root = await createAnchor("root", ZERO_BYTES32);
    const dir = await createAnchor("dir", root);
    const fileAnchor = await createAnchor("doc.txt", dir, dataSchemaUID);

    // Alice places the file; OWNER whites it out (owner = Lk).
    const dAlice = await mintData(alice);
    await createPin(fileAnchor, dAlice, alice);
    await attestWhiteout(fileAnchor, owner);

    // Viewer = [alice] only (does NOT include owner) → owner's whiteout is invisible → item shows.
    const aliceView = await fileView.getDirectoryPageBySchemaAndAddressList(dir, dataSchemaUID, [aliceAddr], "0x", 10);
    expect(aliceView.items.map(i => i.uid)).to.deep.equal([fileAnchor]);

    // Viewer = [bob] (unrelated) → also unaffected: bob has no placement so nothing lists, but
    // owner's whiteout still doesn't apply to bob's lens (no cross-lens leakage either way).
    expect(await whiteoutResolver.isWhitedOut(dir, bobAddr, fileAnchor)).to.equal(false);
    expect(await whiteoutResolver.isWhitedOut(dir, aliceAddr, fileAnchor)).to.equal(false);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // VECTOR 8 — re-whiteout last-writer-wins: revoking a STALE uid doesn't clear a newer marker
  // ════════════════════════════════════════════════════════════════════════════
  it("vector 8: revoking a stale whiteout UID does not clear the marker held by a newer one", async function () {
    const root = await createAnchor("root", ZERO_BYTES32);
    const dir = await createAnchor("dir", root);
    const fileAnchor = await createAnchor("doc.txt", dir, dataSchemaUID);
    const dAlice = await mintData(alice);
    await createPin(fileAnchor, dAlice, alice);

    // Owner whites it out TWICE on the same (parent, child) slot — the 2nd overwrites the marker.
    const woFirst = await attestWhiteout(fileAnchor, owner);
    const woSecond = await attestWhiteout(fileAnchor, owner);
    expect(await whiteoutResolver.isWhitedOut(dir, ownerAddr, fileAnchor)).to.equal(true);
    // Append-once: the discovery list still holds the child exactly once despite two attests.
    expect(await whiteoutResolver.getChildrenWhitedOutCount(dir, ownerAddr)).to.equal(1n);

    // Revoke the STALE (first) UID — the live marker is owned by the second, so it must survive.
    await revoke(whiteoutSchemaUID, woFirst, owner);
    expect(await whiteoutResolver.isWhitedOut(dir, ownerAddr, fileAnchor)).to.equal(true);

    // The entry stays hidden under [owner, alice].
    let page = await fileView.getDirectoryPageBySchemaAndAddressList(
      dir,
      dataSchemaUID,
      [ownerAddr, aliceAddr],
      "0x",
      10,
    );
    expect(page.items.length).to.equal(0);

    // Now revoke the LIVE (second) UID — the marker clears, the entry un-hides.
    await revoke(whiteoutSchemaUID, woSecond, owner);
    expect(await whiteoutResolver.isWhitedOut(dir, ownerAddr, fileAnchor)).to.equal(false);
    page = await fileView.getDirectoryPageBySchemaAndAddressList(dir, dataSchemaUID, [ownerAddr, aliceAddr], "0x", 10);
    expect(page.items.map(i => i.uid)).to.deep.equal([fileAnchor]);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // VECTOR 9 — write-guard rejections (each invalid write reverts with the specific error)
  // ════════════════════════════════════════════════════════════════════════════
  describe("vector 9: write-guard rejections", function () {
    let root: string;
    let dir: string;
    let validChild: string;

    beforeEach(async function () {
      root = await createAnchor("root", ZERO_BYTES32);
      dir = await createAnchor("dir", root);
      validChild = await createAnchor("doc.txt", dir, dataSchemaUID);
    });

    it("refUID = 0 → ZeroRef", async function () {
      await expect(attestWhiteout(ZERO_BYTES32, owner)).to.be.revertedWithCustomError(whiteoutResolver, "ZeroRef");
    });

    it("non-empty payload → BadPayload", async function () {
      await expect(
        attestWhiteout(validChild, owner, { data: enc.encode(["uint256"], [1n]) }),
      ).to.be.revertedWithCustomError(whiteoutResolver, "BadPayload");
    });

    it("non-revocable attestation → NotRevocable", async function () {
      await expect(attestWhiteout(validChild, owner, { revocable: false })).to.be.revertedWithCustomError(
        whiteoutResolver,
        "NotRevocable",
      );
    });

    it("non-zero expirationTime → HasExpiration", async function () {
      const future = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 100000n;
      await expect(attestWhiteout(validChild, owner, { expirationTime: future })).to.be.revertedWithCustomError(
        whiteoutResolver,
        "HasExpiration",
      );
    });

    it("refUID is a DATA attestation (not an anchor) → SourceNotAnchor", async function () {
      const data = await mintData();
      await expect(attestWhiteout(data, owner)).to.be.revertedWithCustomError(whiteoutResolver, "SourceNotAnchor");
    });

    it("refUID is a PROPERTY attestation → SourceNotAnchor", async function () {
      const prop = await mintProperty("hello");
      await expect(attestWhiteout(prop, owner)).to.be.revertedWithCustomError(whiteoutResolver, "SourceNotAnchor");
    });

    it("refUID is a PIN attestation → SourceNotAnchor", async function () {
      const data = await mintData();
      const pin = await createPin(validChild, data, owner);
      await expect(attestWhiteout(pin, owner)).to.be.revertedWithCustomError(whiteoutResolver, "SourceNotAnchor");
    });

    it("refUID is another WHITEOUT attestation → SourceNotAnchor", async function () {
      const wo = await attestWhiteout(validChild, owner);
      await expect(attestWhiteout(wo, owner)).to.be.revertedWithCustomError(whiteoutResolver, "SourceNotAnchor");
    });

    it("refUID is a root-level anchor (no parent) → OrphanAnchor", async function () {
      // `root` was minted with refUID=0 ⇒ getParent(root)=0 ⇒ root-level ⇒ OrphanAnchor.
      await expect(attestWhiteout(root, owner)).to.be.revertedWithCustomError(whiteoutResolver, "OrphanAnchor");
    });

    it("foreign schema pointed at this resolver → WrongSchema", async function () {
      // Register a DIFFERENT schema (non-empty field) against the SAME WhiteoutResolver proxy. EAS
      // lets anyone do this; the resolver's onAttest must reject it (schema != self-derived UID).
      const foreignField = "uint256 attack";
      await (await registry.register(foreignField, whiteoutResolverAddr, true)).wait();
      const foreignUID = ethers.solidityPackedKeccak256(
        ["string", "address", "bool"],
        [foreignField, whiteoutResolverAddr, true],
      );
      await expect(
        attestWhiteout(validChild, owner, { schema: foreignUID, data: enc.encode(["uint256"], [1n]) }),
      ).to.be.revertedWithCustomError(whiteoutResolver, "WrongSchema");
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // VECTOR 10 — router negative-terminal: serve not-found, no fall-through to a lower lens
  // ════════════════════════════════════════════════════════════════════════════
  describe("vector 10: router negative-terminal", function () {
    let router: EFSRouter;
    let mirrorResolver: any;
    let dirRoot: string;
    let fileAnchor: string;
    let dir: string;
    let childAnchor: string;
    let onchainUID: string;

    // The router beforeEach builds a fresh stack INCLUDING a MirrorResolver (the router needs a
    // wired MIRROR schema to serve content), the WhiteoutResolver, and a /transports/ tree, then
    // seeds a single file placed by ALICE with a web3:// mirror so a non-whited read serves 200.
    beforeEach(async function () {
      const RegistryFactory = await ethers.getContractFactory("SchemaRegistry");
      const reg2 = await RegistryFactory.deploy();
      await reg2.waitForDeployment();
      const EASFactory = await ethers.getContractFactory("EAS");
      const eas2 = (await EASFactory.deploy(await reg2.getAddress())) as EAS;
      await eas2.waitForDeployment();

      // Rebind the suite-level helpers' `eas`/`registry` to this isolated stack for vector 10.
      eas = eas2;
      registry = reg2;

      const a = ownerAddr;
      // Predict each resolver/indexer PROXY address from a FRESHLY read nonce right before its
      // deploy (each *Proxy helper = exactly 2 deployer txs: impl, then proxy). Computing offsets
      // immediately before each deploy is more robust than one cumulative offset chain.
      const edgeNonce = await ethers.provider.getTransactionCount(a);
      const edgeAddr = ethers.getCreateAddress({ from: a, nonce: edgeNonce + 1 });
      const mirrorAddr = ethers.getCreateAddress({ from: a, nonce: edgeNonce + 3 });
      const idxAddr = ethers.getCreateAddress({ from: a, nonce: edgeNonce + 5 });

      anchorSchemaUID = ethers.solidityPackedKeccak256(["string", "address", "bool"], [ANCHOR_SCHEMA, idxAddr, false]);
      propertySchemaUID = ethers.solidityPackedKeccak256(
        ["string", "address", "bool"],
        [PROPERTY_SCHEMA, idxAddr, false],
      );
      dataSchemaUID = ethers.solidityPackedKeccak256(["string", "address", "bool"], [DATA_SCHEMA, idxAddr, false]);
      pinSchemaUID = ethers.solidityPackedKeccak256(["string", "address", "bool"], [PIN_SCHEMA, edgeAddr, true]);
      tagSchemaUID = ethers.solidityPackedKeccak256(["string", "address", "bool"], [TAG_SCHEMA, edgeAddr, true]);
      mirrorSchemaUID = ethers.solidityPackedKeccak256(
        ["string", "address", "bool"],
        ["bytes32 transportDefinition, string uri", mirrorAddr, true],
      );

      edgeResolver = await deployResolverProxy<EdgeResolver>(
        "EdgeResolver",
        [await eas2.getAddress()],
        [pinSchemaUID, tagSchemaUID, idxAddr, await reg2.getAddress()],
        owner,
      );
      expect(await edgeResolver.getAddress()).to.equal(edgeAddr);
      mirrorResolver = await deployResolverProxy("MirrorResolver", [await eas2.getAddress()], [idxAddr, a], owner);
      expect(await mirrorResolver.getAddress()).to.equal(mirrorAddr);
      indexer = await deployIndexerProxy(
        await eas2.getAddress(),
        anchorSchemaUID,
        propertySchemaUID,
        dataSchemaUID,
        owner,
      );
      expect(await indexer.getAddress()).to.equal(idxAddr);

      // Predict the WHITEOUT proxy fresh (after the 6 non-whiteout registrations), then register
      // WHITEOUT against it and deploy it last (its initialize reads the now-existing indexer).
      await (await reg2.register(ANCHOR_SCHEMA, idxAddr, false)).wait();
      await (await reg2.register(PROPERTY_SCHEMA, idxAddr, false)).wait();
      await (await reg2.register(DATA_SCHEMA, idxAddr, false)).wait();
      await (await reg2.register(PIN_SCHEMA, edgeAddr, true)).wait();
      await (await reg2.register(TAG_SCHEMA, edgeAddr, true)).wait();
      await (await reg2.register("bytes32 transportDefinition, string uri", mirrorAddr, true)).wait();

      const woNonce = await ethers.provider.getTransactionCount(a);
      // +0 register WHITEOUT, +1 impl, +2 proxy.
      const woAddr = ethers.getCreateAddress({ from: a, nonce: woNonce + 2 });
      whiteoutSchemaUID = ethers.solidityPackedKeccak256(
        ["string", "address", "bool"],
        [WHITEOUT_SCHEMA, woAddr, true],
      );
      await (await reg2.register(WHITEOUT_SCHEMA, woAddr, true)).wait();

      whiteoutResolver = await deployResolverProxy<WhiteoutResolver>(
        "WhiteoutResolver",
        [await eas2.getAddress()],
        [await indexer.getAddress()],
        owner,
      );
      expect(await whiteoutResolver.getAddress()).to.equal(woAddr);
      expect(await whiteoutResolver.whiteoutSchemaUID()).to.equal(whiteoutSchemaUID);

      await indexer.wireContracts(
        await edgeResolver.getAddress(),
        pinSchemaUID,
        tagSchemaUID,
        ZeroAddress,
        ZERO_BYTES32,
        await mirrorResolver.getAddress(),
        mirrorSchemaUID,
        await reg2.getAddress(),
      );

      const RouterFactory = await ethers.getContractFactory("EFSRouter");
      router = (await RouterFactory.deploy(
        await indexer.getAddress(),
        await eas2.getAddress(),
        await edgeResolver.getAddress(),
        await reg2.getAddress(),
        dataSchemaUID,
        ZeroAddress, // systemAccount → falls back to indexer.DEPLOYER() (= owner)
        await whiteoutResolver.getAddress(),
      )) as EFSRouter;
      await router.waitForDeployment();

      // Build /dir/doc.txt with a /transports/onchain ancestry so the web3:// mirror is accepted.
      dirRoot = await createAnchor("root", ZERO_BYTES32);
      const transportsUID = await createAnchor("transports", dirRoot);
      onchainUID = await createAnchor("onchain", transportsUID);
      await mirrorResolver.setTransportsAnchor(transportsUID);

      dir = await createAnchor("dir", dirRoot);
      fileAnchor = await createAnchor("doc.txt", dir, dataSchemaUID);
      // A SECOND file under the SAME folder, for the deep-link-into-a-whited-folder vector.
      childAnchor = await createAnchor("child.txt", dir, dataSchemaUID);

      // ALICE (lower lens) places real content with a web3:// mirror so an un-whited read serves 200.
      // transportDefinition must be the /transports/onchain anchor (a descendant of /transports/),
      // and the URI must carry a parseable address — point it at the EAS contract as a stand-in
      // chunk-manager (the router extcodecopies it; non-empty code ⇒ 200).
      const dAlice = await mintData(alice);
      await createPin(fileAnchor, dAlice, alice);
      await eas2.connect(alice).attest({
        schema: mirrorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: dAlice,
          data: enc.encode(["bytes32", "string"], [onchainUID, `web3://${await eas2.getAddress()}`]),
          value: 0n,
        },
      });
      // Alice (lower lens) also places /dir/child.txt with a web3:// mirror so /dir/child.txt is 200
      // when not whited; the deep-link vector then whiteouts the FOLDER /dir and expects 404.
      const dChild = await mintData(alice);
      await createPin(childAnchor, dChild, alice);
      await eas2.connect(alice).attest({
        schema: mirrorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: dChild,
          data: enc.encode(["bytes32", "string"], [onchainUID, `web3://${await eas2.getAddress()}`]),
          value: 0n,
        },
      });
    });

    it("baseline: alice's placement serves (200) when no whiteout is present", async function () {
      const res = await router.request(["dir", "doc.txt"], [{ key: "lenses", value: `${aliceAddr}` }]);
      expect(res.statusCode).to.equal(200n);
    });

    it("owner's whiteout makes the router serve not-found and NOT fall through to alice", async function () {
      // Owner (higher lens) whites the path out. Viewer = [owner, alice]: the negative terminal
      // stops the scan at owner, NO fall-through to alice's placement, NO system gap-fill → 404.
      await attestWhiteout(fileAnchor, owner);

      const res = await router.request(["dir", "doc.txt"], [{ key: "lenses", value: `${ownerAddr},${aliceAddr}` }]);
      expect(res.statusCode).to.equal(404n);

      // Cross-lens unaffected: a viewer of [alice] only still gets 200 (owner's whiteout invisible).
      const aliceRes = await router.request(["dir", "doc.txt"], [{ key: "lenses", value: `${aliceAddr}` }]);
      expect(aliceRes.statusCode).to.equal(200n);
    });

    it("revoking the router whiteout restores fall-through to the lower lens (un-hide)", async function () {
      const woUID = await attestWhiteout(fileAnchor, owner);
      let res = await router.request(["dir", "doc.txt"], [{ key: "lenses", value: `${ownerAddr},${aliceAddr}` }]);
      expect(res.statusCode).to.equal(404n);

      await revoke(whiteoutSchemaUID, woUID, owner);
      res = await router.request(["dir", "doc.txt"], [{ key: "lenses", value: `${ownerAddr},${aliceAddr}` }]);
      expect(res.statusCode).to.equal(200n); // alice's placement now falls through
    });

    // ADR-0055 deep-link terminal (spec/04): a whiteout on the FOLDER /dir must 404 a deep link
    // GET /dir/child.txt — the per-SEGMENT terminal fires while walking the path, not only on the
    // leaf. Without it the leaf check passes (child.txt isn't itself whited) and a lower lens's
    // content leaks through.
    it("deep link into a whited-out folder 404s (no fall-through to a lower lens's child)", async function () {
      // Control: with NO whiteout, the deep link serves alice's child.txt (200).
      let res = await router.request(["dir", "child.txt"], [{ key: "lenses", value: `${ownerAddr},${aliceAddr}` }]);
      expect(res.statusCode).to.equal(200n);

      // Owner (higher lens) whiteouts the FOLDER /dir itself.
      await attestWhiteout(dir, owner);
      expect(await whiteoutResolver.isWhitedOut(dirRoot, ownerAddr, dir)).to.equal(true);

      // Viewer [owner, alice]: the per-segment terminal fires at the `dir` segment → 404, with NO
      // fall-through to alice's child.txt placement.
      res = await router.request(["dir", "child.txt"], [{ key: "lenses", value: `${ownerAddr},${aliceAddr}` }]);
      expect(res.statusCode).to.equal(404n);

      // Control: a viewer whose lens list EXCLUDES the whiteout author (alice only) is unaffected → 200.
      const aliceRes = await router.request(["dir", "child.txt"], [{ key: "lenses", value: `${aliceAddr}` }]);
      expect(aliceRes.statusCode).to.equal(200n);
    });

    // ADR-0055 folder re-add fix: the per-SEGMENT intermediate-folder whiteout terminal uses the
    // LISTING positive (PIN OR folder visibility TAG), NOT the PIN-only resolution positive. Folders
    // are made visible by a visibility TAG (ADR-0038; upload emits `TAG(definition=dataSchemaUID,
    // refUID=folder)`), so a lens that whiteouts an inherited folder and then RE-ADDS it (by uploading
    // its own child, which re-emits the folder's visibility TAG) makes the folder TRAVERSABLE again
    // for that lens — listings show it via `EFSFileView._isItemWhitedOutForListing`, and the router
    // must traverse it consistently. Regression vector: before this fix the intermediate `dir` segment
    // used a PIN-only positive that never saw the folder TAG, so the router still 404'd the owner's
    // own re-added child. The leaf DATA read stays PIN-only (a folder TAG must NOT un-gate it).
    it("folder whiteout + same-lens visibility-TAG re-add → owner's own re-added child traverses (200); lower lens's non-whited child still shows (200); leaf whiteout still 404s", async function () {
      // alice (lower lens) already placed /dir/child.txt in the beforeEach (her visibility TAG on /dir
      // + her file). owner (higher lens) whiteouts the FOLDER /dir, THEN "uploads" /dir/own.txt:
      // owner re-emits his OWN visibility TAG on /dir (the re-add) and places his own DATA at own.txt
      // with a web3:// mirror so the leaf serves 200.
      const ownChildAnchor = await createAnchor("own.txt", dir, dataSchemaUID);

      await attestWhiteout(dir, owner); // owner whiteouts the inherited folder /dir
      expect(await whiteoutResolver.isWhitedOut(dirRoot, ownerAddr, dir)).to.equal(true);

      // owner RE-ADDS /dir via his own folder visibility TAG (definition=dataSchemaUID, refUID=dir),
      // exactly what the ancestor-walk visibility-TAG step of an upload emits (ADR-0038 / overview §7).
      await createTag(dataSchemaUID, dir, owner);
      // owner places his own DATA at /dir/own.txt with a web3:// mirror (so the leaf can serve 200).
      const dOwn = await mintData(owner);
      await createPin(ownChildAnchor, dOwn, owner);
      await eas.connect(owner).attest({
        schema: mirrorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: dOwn,
          data: enc.encode(["bytes32", "string"], [onchainUID, `web3://${await eas.getAddress()}`]),
          value: 0n,
        },
      });

      // GET /dir/own.txt (owner's re-added child) → 200: owner re-asserted /dir via his visibility
      // TAG, so the intermediate `dir` segment is traversable for owner (listing positive), and the
      // leaf own.txt has owner's placement PIN.
      const ownRes = await router.request(["dir", "own.txt"], [{ key: "lenses", value: `${ownerAddr},${aliceAddr}` }]);
      expect(ownRes.statusCode).to.equal(200n);

      // GET /dir/other.txt (alice's child.txt — owner did NOT place it under owner) → 200, and this
      // is the CORRECT overlayfs semantics, not 404. Once owner re-adds /dir (its visibility TAG), the
      // intermediate `dir` segment is traversable for owner, so the walk descends to the leaf. The
      // leaf DATA read is PIN-only over [owner, alice], keyed (parent=/dir, child=child.txt): owner has
      // no placement at child.txt AND owner's only whiteout is on the FOLDER /dir (keyed on (dirRoot,
      // owner, dir)) — owner never whited child.txt itself — so owner is NOT a leaf negative terminal
      // and the scan falls through to alice's placement. Whiteout-then-readd of a DIRECTORY exposes the
      // lower layer's children that were not INDIVIDUALLY whited; to also hide child.txt owner would
      // whiteout child.txt specifically. (The leaf terminal stays PIN-only — the folder TAG did not
      // un-gate it; it stayed gated and simply found alice's lower-lens PIN.)
      const otherRes = await router.request(
        ["dir", "child.txt"],
        [{ key: "lenses", value: `${ownerAddr},${aliceAddr}` }],
      );
      expect(otherRes.statusCode).to.equal(200n);

      // To actually hide alice's child under owner's lens, owner whiteouts the LEAF child.txt itself.
      // Now the leaf PIN-only terminal fires at owner (negative terminal on (parent=/dir, child.txt))
      // → 404, with NO fall-through to alice — the leaf gating is intact and unweakened by this fix.
      await attestWhiteout(childAnchor, owner);
      const hiddenRes = await router.request(
        ["dir", "child.txt"],
        [{ key: "lenses", value: `${ownerAddr},${aliceAddr}` }],
      );
      expect(hiddenRes.statusCode).to.equal(404n);

      // Control: a viewer of [alice] only (no whiteout in her lens) sees alice's child.txt → 200.
      const aliceOnly = await router.request(["dir", "child.txt"], [{ key: "lenses", value: `${aliceAddr}` }]);
      expect(aliceOnly.statusCode).to.equal(200n);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // VECTOR 11 — getFilesAtPath negative terminal (view/router consistency, ADR-0055)
  //   The single-anchor file reader applies the SAME (parent, lens, anchor) whiteout terminal the
  //   router's `_findDataAtPath` does, so a viewer can't see DATA via the view that the router 404s.
  // ════════════════════════════════════════════════════════════════════════════
  describe("vector 11: getFilesAtPath negative terminal (view/router consistency)", function () {
    it("a whited anchor returns empty from getFilesAtPath for the lens that whited it; an unaffected lens still sees the file", async function () {
      const root = await createAnchor("root", ZERO_BYTES32);
      const dir = await createAnchor("dir", root);
      const fileAnchor = await createAnchor("doc.txt", dir, dataSchemaUID);

      // ALICE places real content at the anchor (her DATA via her placement PIN).
      const dAlice = await mintData(alice);
      await createPin(fileAnchor, dAlice, alice);

      // Baseline: viewer [owner, alice] resolves alice's DATA (owner has no placement of his own).
      let page = await fileView.getFilesAtPath(fileAnchor, [ownerAddr, aliceAddr], dataSchemaUID, "0x", 10);
      expect(page.items.map(i => i.uid)).to.deep.equal([dAlice]);

      // Owner (higher lens) whites the anchor out. Viewer [owner, alice]: the negative terminal stops
      // the scan at owner — NO fall-through to alice's placement → empty (router would 404 here too).
      await attestWhiteout(fileAnchor, owner);
      page = await fileView.getFilesAtPath(fileAnchor, [ownerAddr, aliceAddr], dataSchemaUID, "0x", 10);
      expect(page.items.length).to.equal(0);
      expect(page.nextCursor).to.equal("0x");

      // Cross-lens unaffected: a lens that did NOT white it out (alice alone) still sees the file.
      const aliceOnly = await fileView.getFilesAtPath(fileAnchor, [aliceAddr], dataSchemaUID, "0x", 10);
      expect(aliceOnly.items.map(i => i.uid)).to.deep.equal([dAlice]);
    });

    it("same-lens positive PIN beats that lens's own earlier whiteout (positive-before-whiteout)", async function () {
      const root = await createAnchor("root", ZERO_BYTES32);
      const dir = await createAnchor("dir", root);
      const fileAnchor = await createAnchor("doc.txt", dir, dataSchemaUID);

      // Owner whites the anchor out, THEN places his own content at the same anchor (marker stays live).
      await attestWhiteout(fileAnchor, owner);
      const dOwner = await mintData(owner);
      await createPin(fileAnchor, dOwner, owner);

      expect(await whiteoutResolver.isWhitedOut(dir, ownerAddr, fileAnchor)).to.equal(true);
      // The terminal checks the positive PIN FIRST within the lens → owner's DATA is served.
      const page = await fileView.getFilesAtPath(fileAnchor, [ownerAddr], dataSchemaUID, "0x", 10);
      expect(page.items.map(i => i.uid)).to.deep.equal([dOwner]);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // VECTOR 12 — whiteout participates in the FILTERED listing too (ADR-0055 + ADR-0054)
  //   The ADR makes whiteout load-bearing in BOTH plain and filtered listings. Here the view is wired
  //   WITH a real WhiteoutResolver (the suite harness), so we assert: (a) whiteout drops an item from
  //   a FILTERED listing, and (b) an item dropped by BOTH a tag-exclusion AND a whiteout is skipped
  //   exactly once (no double-decrement / pagination corruption).
  // ════════════════════════════════════════════════════════════════════════════
  describe("vector 12: whiteout in getDirectoryPageFiltered (filtered walker)", function () {
    let excludeTagDef: string;

    beforeEach(async function () {
      // Registered after all suite deploys (in the test body's beforeEach) so it cannot shift any
      // CREATE nonce the suite's address predictions depend on. A standalone schema UID is a valid
      // bytes32 exclude-tag definition (matches EFSFileViewFiltered.test.ts).
      const tx = await registry.register("string whiteoutFilterLabel", ZeroAddress, false);
      excludeTagDef = (await tx.wait())!.logs[0].topics[1];
    });

    it("(a) whiteout drops an item from a FILTERED listing (zero exclude tags ⇒ whiteout is the only filter)", async function () {
      const root = await createAnchor("root", ZERO_BYTES32);
      const dir = await createAnchor("dir", root);

      // Two files placed by ALICE; OWNER views [owner, alice] and whites out one.
      const keepAnchor = await createAnchor("keep.txt", dir, dataSchemaUID);
      const hideAnchor = await createAnchor("hide.txt", dir, dataSchemaUID);
      const dKeep = await mintData(alice);
      const dHide = await mintData(alice);
      await createPin(keepAnchor, dKeep, alice);
      await createPin(hideAnchor, dHide, alice);

      await attestWhiteout(hideAnchor, owner);

      // Empty exclude policy → the ONLY drop is the whiteout (proves the filtered walker honors it).
      const page = await fileView.getDirectoryPageFiltered(
        dir,
        dataSchemaUID,
        [ownerAddr, aliceAddr],
        [], // no exclude tags
        [],
        "0x",
        10,
      );
      expect(page.items.map(i => i.uid)).to.deep.equal([keepAnchor]);
      expect(page.nextCursor).to.equal("0x");
    });

    it("(b) an item dropped by BOTH a tag-exclusion AND a whiteout is skipped exactly once (no pagination corruption)", async function () {
      const root = await createAnchor("root", ZERO_BYTES32);
      const dir = await createAnchor("dir", root);

      // Three files placed by ALICE: `both` is BOTH whited-out AND tag-excluded; `taggedOnly` is only
      // tag-excluded; `clean` survives. Owner views [owner, alice].
      const bothAnchor = await createAnchor("both.txt", dir, dataSchemaUID);
      const taggedAnchor = await createAnchor("tagged.txt", dir, dataSchemaUID);
      const cleanAnchor = await createAnchor("clean.txt", dir, dataSchemaUID);
      const dBoth = await mintData(alice);
      const dTagged = await mintData(alice);
      const dClean = await mintData(alice);
      await createPin(bothAnchor, dBoth, alice);
      await createPin(taggedAnchor, dTagged, alice);
      await createPin(cleanAnchor, dClean, alice);

      // Exclude tag on the DATA (file branch bucket = dataSchemaUID), by alice (a viewed lens).
      await createTag(excludeTagDef, dBoth, alice, 1n);
      await createTag(excludeTagDef, dTagged, alice, 1n);
      // AND owner whites out `both` — the doubly-suppressed item.
      await attestWhiteout(bothAnchor, owner);

      // One-shot page: only clean.txt survives. `both` being suppressed by two independent predicates
      // must not double-decrement the slot accounting or corrupt the walk.
      const page = await fileView.getDirectoryPageFiltered(
        dir,
        dataSchemaUID,
        [ownerAddr, aliceAddr],
        [excludeTagDef],
        [0n],
        "0x",
        10,
      );
      expect(page.items.map(i => i.uid)).to.deep.equal([cleanAnchor]);
      expect(page.nextCursor).to.equal("0x");

      // Paginate at size 1 across the whole source: every surviving item is yielded exactly once and
      // the doubly-suppressed item is never emitted (skip-exactly-once across page boundaries).
      const seen: string[] = [];
      let cursor = "0x";
      let calls = 0;
      while (true) {
        calls++;
        if (calls > 20) throw new Error("filtered pagination did not terminate");
        const p = await fileView.getDirectoryPageFiltered(
          dir,
          dataSchemaUID,
          [ownerAddr, aliceAddr],
          [excludeTagDef],
          [0n],
          cursor,
          1,
        );
        for (const it of p.items) seen.push(it.uid);
        if (p.nextCursor === "0x") break;
        cursor = p.nextCursor;
      }
      expect(seen).to.deep.equal([cleanAnchor]); // exactly one survivor, emitted once
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // VECTOR 13 — folder whiteout hides a FOLDER from a listing (per-name on a folder anchor)
  //   A folder is visible via a visibility TAG (definition = dataSchemaUID, ADR-0038). A per-name
  //   whiteout on the folder anchor drops it from the listing, same as a file.
  // ════════════════════════════════════════════════════════════════════════════
  it("vector 13: a per-name whiteout hides a FOLDER (visibility-TAG-listed) from the listing", async function () {
    const root = await createAnchor("root", ZERO_BYTES32);
    const dir = await createAnchor("dir", root);

    // Two generic FOLDERS under dir, made visible by ALICE's visibility TAGs (definition=dataSchemaUID).
    const keepFolder = await createAnchor("keep", dir, ZERO_BYTES32);
    const hideFolder = await createAnchor("hide", dir, ZERO_BYTES32);
    await createTag(dataSchemaUID, keepFolder, alice);
    await createTag(dataSchemaUID, hideFolder, alice);

    // Baseline: both folders list for viewer [owner, alice] (phase 0).
    let page = await fileView.getDirectoryPageBySchemaAndAddressList(
      dir,
      dataSchemaUID,
      [ownerAddr, aliceAddr],
      "0x",
      10,
    );
    expect(page.items.map(i => i.uid)).to.have.members([keepFolder, hideFolder]);

    // OWNER whites out the `hide` folder anchor → dropped from his view.
    await attestWhiteout(hideFolder, owner);
    page = await fileView.getDirectoryPageBySchemaAndAddressList(dir, dataSchemaUID, [ownerAddr, aliceAddr], "0x", 10);
    expect(page.items.map(i => i.uid)).to.deep.equal([keepFolder]);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // VECTOR 14 — folder whiteout + same-lens re-add via a visibility TAG → folder un-hidden (THE FIX)
  //   The folder-fix: a lens's own NEWER folder-visibility TAG beats that lens's own earlier whiteout
  //   in LISTINGS (folder positive assertion is a visibility TAG — Shape B — not a PIN).
  // ════════════════════════════════════════════════════════════════════════════
  it("vector 14: folder whiteout + same-lens visibility-TAG re-add → folder visible (folder-fix)", async function () {
    const root = await createAnchor("root", ZERO_BYTES32);
    const dir = await createAnchor("dir", root);
    const folder = await createAnchor("sub", dir, ZERO_BYTES32);

    // OWNER whites out the folder, THEN re-asserts its visibility with his OWN TAG (marker stays live).
    await attestWhiteout(folder, owner);
    await createTag(dataSchemaUID, folder, owner);
    expect(await whiteoutResolver.isWhitedOut(dir, ownerAddr, folder)).to.equal(true);

    // The folder-fix: the listing predicate's positive terminal now includes the visibility TAG, so
    // owner's own TAG beats his own whiteout → the folder is VISIBLE for [owner].
    const page = await fileView.getDirectoryPageBySchemaAndAddressList(dir, dataSchemaUID, [ownerAddr], "0x", 10);
    expect(page.items.map(i => i.uid)).to.deep.equal([folder]);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // VECTOR 15 — plain phase-1 scan budget under mass whiteout (ADR-0055 / ADR-0036)
  //   The whited-out skip in `getDirectoryPageBySchemaAndAddressList` phase 1 DROPS items without
  //   consuming a result slot. Without a per-call scan budget, a directory with many hidden direct
  //   files would loop the entire remaining phase-1 source in ONE eth_call. This vector deploys a
  //   testable view with a tiny budget (4), whites out every direct file, and asserts: the first
  //   call returns a BOUNDED page (≤ budget scanned) with a NON-EMPTY cursor (forward progress),
  //   and paginating to exhaustion TERMINATES (no infinite loop, no full-source scan in one call).
  //   Fails if the phase-1 budget guard is absent: the first call would return an empty cursor (or
  //   never return) instead of a bounded one.
  // ════════════════════════════════════════════════════════════════════════════
  it("vector 15: plain phase-1 listing scan is budget-bounded when many direct files are whited out", async function () {
    const root = await createAnchor("root", ZERO_BYTES32);
    const dir = await createAnchor("dir", root);

    // 6 direct files, all placed by ALICE (so they qualify in phase 1) and all whited out by OWNER.
    const N = 6;
    const fileAnchors: string[] = [];
    for (let i = 0; i < N; i++) {
      const fa = await createAnchor(`f${i}.txt`, dir, dataSchemaUID);
      const d = await mintData(alice);
      await createPin(fa, d, alice);
      await attestWhiteout(fa, owner); // owner (higher lens) hides every direct file
      fileAnchors.push(fa);
    }

    // Testable view with a tiny per-call budget (4), wired to the SAME stack incl. the whiteout
    // resolver — so the phase-1 budget guard can trip with a handful of seeded items.
    const TestableFactory = await ethers.getContractFactory("EFSFileViewTestable");
    const tv = (await TestableFactory.deploy(
      await indexer.getAddress(),
      await edgeResolver.getAddress(),
      await whiteoutResolver.getAddress(),
      4n, // small budget
    )) as unknown as EFSFileView;
    await tv.waitForDeployment();

    // Sanity: with the whiteout resolver wired, the production view (budget 2048) returns 0 items and
    // a CLEAN cursor (source < budget, so it fully exhausts in one call).
    const full = await fileView.getDirectoryPageBySchemaAndAddressList(
      dir,
      dataSchemaUID,
      [ownerAddr, aliceAddr],
      "0x",
      10,
    );
    expect(full.items.length).to.equal(0);
    expect(full.nextCursor).to.equal("0x");

    // First testable call: maxItems=10, budget=4 → budget hit before source exhausted → 0 items but
    // a NON-EMPTY cursor (bounded page, forward progress). This is the guard the fix adds.
    const first = await tv.getDirectoryPageBySchemaAndAddressList(dir, dataSchemaUID, [ownerAddr, aliceAddr], "0x", 10);
    expect(first.items.length).to.equal(0);
    expect(first.nextCursor).to.not.equal("0x"); // budget hit, source not exhausted → cursor emitted

    // Paginate to exhaustion: each call is budget-bounded; the loop MUST terminate with an empty
    // cursor and zero items (all whited out), proving no full-source scan and no infinite loop.
    let cursor = first.nextCursor;
    let calls = 1;
    let totalItems = 0;
    while (cursor !== "0x") {
      if (calls > 20) throw new Error("budget pagination did not terminate");
      const page = await tv.getDirectoryPageBySchemaAndAddressList(
        dir,
        dataSchemaUID,
        [ownerAddr, aliceAddr],
        cursor,
        10,
      );
      totalItems += page.items.length;
      cursor = page.nextCursor;
      calls++;
    }
    expect(totalItems).to.equal(0); // every direct file whited out → nothing surfaces
    expect(calls).to.be.greaterThan(1); // proves it took multiple budget-bounded calls (no one-shot scan)
  });
});
