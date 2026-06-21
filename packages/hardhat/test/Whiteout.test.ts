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
 * Covers the per-name vectors (1–12) PLUS the opaque-directory + folder-fix vectors (13–24, ADR-0055
 * opaque variant) and resolver-unit opaque checks:
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
 *   15 opaque hides all lower-lens children
 *   16 opaque suppresses a lower child added AFTER the marker (races future additions)
 *   17 opaque shows the opaque lens's OWN children, cuts only strictly-lower ones
 *   18 opaque + per-name whiteout compose
 *   19 opaque is lens-scoped — a viewer excluding the opaque lens is unaffected
 *   20 opaque revoke un-hides
 *   21 opaque is transparent to a HIGHER lens
 *   22 opaque write-guards (OpaqueTargetNotFolder / ZeroRef / NotRevocable / HasExpiration / BadPayload / WrongSchema)
 *   23 opaque in the FILTERED listing — doubly-suppressed skipped once
 *   24 direct file resolution under an opaque dir — router 2-B 404 + getFilesAtPath empty
 *   + resolver-unit: isOpaque toggle, append-once, last-writer-wins, lens-scoping
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
const WHITEOUT_OPAQUE_SCHEMA = "bool opaque"; // non-empty (distinct UID from WHITEOUT; ADR-0055 opaque)

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
  let whiteoutOpaqueSchemaUID: string;
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

  /**
   * Attest a WHITEOUT_OPAQUE (ADR-0055 opaque variant). refUID = the opaque directory's OWN anchor
   * (a generic FOLDER). Payload = abi.encode(true) (the canonical valid shape). The optional `override`
   * lets the opaque write-guard vectors deliberately produce invalid shapes.
   */
  const attestOpaque = async (
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
      schema: override.schema ?? whiteoutOpaqueSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: override.expirationTime ?? NO_EXPIRATION,
        revocable: override.revocable ?? true,
        refUID,
        data: override.data ?? enc.encode(["bool"], [true]),
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
    //   +4..+10  7 schema registrations (ANCHOR, PROPERTY, DATA, PIN, TAG, WHITEOUT, WHITEOUT_OPAQUE)
    //   +11 WhiteoutResolver impl
    //   +12 WhiteoutResolver proxy    ← resolver baked into BOTH WHITEOUT UIDs; initialized last
    const n = await ethers.provider.getTransactionCount(ownerAddr);
    const futureEdgeResolverAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: n + 1 });
    const futureIndexerAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: n + 3 });
    whiteoutResolverAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: n + 12 });

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
    whiteoutOpaqueSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      [WHITEOUT_OPAQUE_SCHEMA, whiteoutResolverAddr, true],
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
    await (await registry.register(WHITEOUT_OPAQUE_SCHEMA, whiteoutResolverAddr, true)).wait();

    // (+11,+12) WhiteoutResolver behind a proxy. initialize(indexer) reads ANCHOR_SCHEMA_UID +
    // getParent — the indexer already exists, so this resolves cleanly.
    whiteoutResolver = await deployResolverProxy<WhiteoutResolver>(
      "WhiteoutResolver",
      [await eas.getAddress()],
      [await indexer.getAddress()],
      owner,
    );
    expect(await whiteoutResolver.getAddress()).to.equal(whiteoutResolverAddr);
    // Self-UID verify gate: the resolver derived the same WHITEOUT + WHITEOUT_OPAQUE UIDs we registered.
    expect(await whiteoutResolver.whiteoutSchemaUID()).to.equal(whiteoutSchemaUID);
    expect(await whiteoutResolver.whiteoutOpaqueSchemaUID()).to.equal(whiteoutOpaqueSchemaUID);
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
      // +0 register WHITEOUT, +1 register WHITEOUT_OPAQUE, +2 impl, +3 proxy.
      const woAddr = ethers.getCreateAddress({ from: a, nonce: woNonce + 3 });
      whiteoutSchemaUID = ethers.solidityPackedKeccak256(
        ["string", "address", "bool"],
        [WHITEOUT_SCHEMA, woAddr, true],
      );
      whiteoutOpaqueSchemaUID = ethers.solidityPackedKeccak256(
        ["string", "address", "bool"],
        [WHITEOUT_OPAQUE_SCHEMA, woAddr, true],
      );
      await (await reg2.register(WHITEOUT_SCHEMA, woAddr, true)).wait();
      await (await reg2.register(WHITEOUT_OPAQUE_SCHEMA, woAddr, true)).wait();

      whiteoutResolver = await deployResolverProxy<WhiteoutResolver>(
        "WhiteoutResolver",
        [await eas2.getAddress()],
        [await indexer.getAddress()],
        owner,
      );
      expect(await whiteoutResolver.getAddress()).to.equal(woAddr);
      expect(await whiteoutResolver.whiteoutSchemaUID()).to.equal(whiteoutSchemaUID);
      expect(await whiteoutResolver.whiteoutOpaqueSchemaUID()).to.equal(whiteoutOpaqueSchemaUID);

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
      const onchainUID = await createAnchor("onchain", transportsUID);
      await mirrorResolver.setTransportsAnchor(transportsUID);

      const dir = await createAnchor("dir", dirRoot);
      fileAnchor = await createAnchor("doc.txt", dir, dataSchemaUID);

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
  // VECTOR 15 — opaque hides ALL lower-lens children in a listing
  // ════════════════════════════════════════════════════════════════════════════
  it("vector 15: an opaque marker hides every lower-lens child from the listing", async function () {
    const root = await createAnchor("root", ZERO_BYTES32);
    const dir = await createAnchor("dir", root);

    // ALICE (lower lens) places three files; OWNER (higher lens) makes `dir` opaque.
    const a1 = await createAnchor("a1.txt", dir, dataSchemaUID);
    const a2 = await createAnchor("a2.txt", dir, dataSchemaUID);
    const a3 = await createAnchor("a3.txt", dir, dataSchemaUID);
    await createPin(a1, await mintData(alice), alice);
    await createPin(a2, await mintData(alice), alice);
    await createPin(a3, await mintData(alice), alice);

    // Baseline: viewer [owner, alice] sees all three.
    let page = await fileView.getDirectoryPageBySchemaAndAddressList(
      dir,
      dataSchemaUID,
      [ownerAddr, aliceAddr],
      "0x",
      10,
    );
    expect(page.items.map(i => i.uid)).to.have.members([a1, a2, a3]);

    // OWNER makes `dir` opaque → all of alice's (below the cut) children vanish for [owner, alice].
    await attestOpaque(dir, owner);
    expect(await whiteoutResolver.isOpaque(dir, ownerAddr)).to.equal(true);
    page = await fileView.getDirectoryPageBySchemaAndAddressList(dir, dataSchemaUID, [ownerAddr, aliceAddr], "0x", 10);
    expect(page.items.length).to.equal(0);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // VECTOR 16 — opaque + a LATER-added lower child is still hidden (races future additions)
  // ════════════════════════════════════════════════════════════════════════════
  it("vector 16: opaque suppresses a lower-lens child added AFTER the opaque marker", async function () {
    const root = await createAnchor("root", ZERO_BYTES32);
    const dir = await createAnchor("dir", root);

    await attestOpaque(dir, owner); // opaque FIRST
    // ALICE adds a child AFTER the opaque marker exists.
    const late = await createAnchor("late.txt", dir, dataSchemaUID);
    await createPin(late, await mintData(alice), alice);

    const page = await fileView.getDirectoryPageBySchemaAndAddressList(
      dir,
      dataSchemaUID,
      [ownerAddr, aliceAddr],
      "0x",
      10,
    );
    expect(page.items.length).to.equal(0); // still hidden — opaque covers future additions
  });

  // ════════════════════════════════════════════════════════════════════════════
  // VECTOR 17 — opaque + the OPAQUE lens's OWN child is shown (only lower lenses are cut)
  // ════════════════════════════════════════════════════════════════════════════
  it("vector 17: opaque shows the opaque lens's own children, hides only strictly-lower ones", async function () {
    const root = await createAnchor("root", ZERO_BYTES32);
    const dir = await createAnchor("dir", root);

    const ownFile = await createAnchor("mine.txt", dir, dataSchemaUID);
    const aliceFile = await createAnchor("hers.txt", dir, dataSchemaUID);
    await createPin(ownFile, await mintData(owner), owner); // owner's OWN content (at the cut line)
    await createPin(aliceFile, await mintData(alice), alice); // alice below the cut

    await attestOpaque(dir, owner);
    const page = await fileView.getDirectoryPageBySchemaAndAddressList(
      dir,
      dataSchemaUID,
      [ownerAddr, aliceAddr],
      "0x",
      10,
    );
    expect(page.items.map(i => i.uid)).to.deep.equal([ownFile]); // owner's own shown, alice's cut
  });

  // ════════════════════════════════════════════════════════════════════════════
  // VECTOR 18 — opaque + per-name whiteout COMPOSE (independent suppressors, both honored)
  //   The opaque marker cuts all of a lower lens's children; a per-name whiteout independently masks a
  //   specific UNPLACED entry. Both predicates fire in the same single pass and the surviving item is
  //   the opaque lens's own placement. (A per-name whiteout on a child the opaque lens PLACES itself is
  //   overridden by that placement — the same-lens positive-before-whiteout rule, vectors 4/11 — so
  //   compose is meaningful only when the whited entry isn't re-placed by an at/above lens.)
  // ════════════════════════════════════════════════════════════════════════════
  it("vector 18: opaque + a per-name whiteout compose (both suppressors honored in one pass)", async function () {
    const root = await createAnchor("root", ZERO_BYTES32);
    const dir = await createAnchor("dir", root);

    const keep = await createAnchor("keep.txt", dir, dataSchemaUID);
    await createPin(keep, await mintData(owner), owner); // owner's OWN placement (at the cut line)
    // Alice's lower child — opaque-cut.
    const aliceFile = await createAnchor("hers.txt", dir, dataSchemaUID);
    await createPin(aliceFile, await mintData(alice), alice);
    // A child PLACED BY ALICE that OWNER per-name whites out — owner has no placement of his own here,
    // so the whiteout is owner's active terminal (not overridden). It is ALSO below the opaque cut, so
    // two independent suppressors apply; it must be dropped exactly once (no double-count corruption).
    const aliceWhited = await createAnchor("zap.txt", dir, dataSchemaUID);
    await createPin(aliceWhited, await mintData(alice), alice);

    await attestOpaque(dir, owner); // cuts alice's children
    await attestWhiteout(aliceWhited, owner); // owner ALSO per-name whites out one of them

    const page = await fileView.getDirectoryPageBySchemaAndAddressList(
      dir,
      dataSchemaUID,
      [ownerAddr, aliceAddr],
      "0x",
      10,
    );
    // Only owner's `keep` survives: `hers` + `zap` are opaque-cut (and `zap` is also per-name whited).
    expect(page.items.map(i => i.uid)).to.deep.equal([keep]);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // VECTOR 19 — opaque is lens-scoped: a viewer excluding the opaque lens is unaffected
  // ════════════════════════════════════════════════════════════════════════════
  it("vector 19: opaque is lens-scoped — a viewer excluding the opaque lens sees lower children", async function () {
    const root = await createAnchor("root", ZERO_BYTES32);
    const dir = await createAnchor("dir", root);
    const aliceFile = await createAnchor("hers.txt", dir, dataSchemaUID);
    await createPin(aliceFile, await mintData(alice), alice);

    await attestOpaque(dir, owner);

    // Viewer = [alice] only (excludes owner) → owner's opaque is invisible → alice's child shows.
    const aliceView = await fileView.getDirectoryPageBySchemaAndAddressList(dir, dataSchemaUID, [aliceAddr], "0x", 10);
    expect(aliceView.items.map(i => i.uid)).to.deep.equal([aliceFile]);
    expect(await whiteoutResolver.isOpaque(dir, aliceAddr)).to.equal(false);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // VECTOR 20 — opaque revoke un-hides the lower children
  // ════════════════════════════════════════════════════════════════════════════
  it("vector 20: revoking the opaque marker un-hides lower-lens children", async function () {
    const root = await createAnchor("root", ZERO_BYTES32);
    const dir = await createAnchor("dir", root);
    const aliceFile = await createAnchor("hers.txt", dir, dataSchemaUID);
    await createPin(aliceFile, await mintData(alice), alice);

    const opUID = await attestOpaque(dir, owner);
    let page = await fileView.getDirectoryPageBySchemaAndAddressList(
      dir,
      dataSchemaUID,
      [ownerAddr, aliceAddr],
      "0x",
      10,
    );
    expect(page.items.length).to.equal(0);

    await revoke(whiteoutOpaqueSchemaUID, opUID, owner);
    expect(await whiteoutResolver.isOpaque(dir, ownerAddr)).to.equal(false);
    page = await fileView.getDirectoryPageBySchemaAndAddressList(dir, dataSchemaUID, [ownerAddr, aliceAddr], "0x", 10);
    expect(page.items.map(i => i.uid)).to.deep.equal([aliceFile]); // falls through again
  });

  // ════════════════════════════════════════════════════════════════════════════
  // VECTOR 21 — opaque is transparent to a HIGHER lens (a lens above the opaque lens still shows)
  // ════════════════════════════════════════════════════════════════════════════
  it("vector 21: opaque by a lower lens is transparent to a higher lens's own placement", async function () {
    const root = await createAnchor("root", ZERO_BYTES32);
    const dir = await createAnchor("dir", root);
    const file = await createAnchor("doc.txt", dir, dataSchemaUID);

    // ALICE (lower) makes `dir` opaque; OWNER (higher) places his own content there.
    await attestOpaque(dir, alice);
    await createPin(file, await mintData(owner), owner);

    // Viewer [owner, alice]: owner is ABOVE alice's opaque cut (index 0 <= cut at 1) → owner's own
    // child is shown (an opaque by Lk suppresses only lenses strictly below Lk).
    const page = await fileView.getDirectoryPageBySchemaAndAddressList(
      dir,
      dataSchemaUID,
      [ownerAddr, aliceAddr],
      "0x",
      10,
    );
    expect(page.items.map(i => i.uid)).to.deep.equal([file]);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // VECTOR 21a — higher-lens whiteout of the opaque-lens's OWN child (P3 close-out)
  //   Stack [L0, L1(opaque), L2]: L1 marks `dir` opaque AND places its own child C; L0 (ABOVE the cut)
  //   whites out C. The higher whiteout legitimately wins — the negative terminal at i < the
  //   contributing index fires before L1's positive placement, so C is dropped. (Exercises the
  //   precedence of a strictly-higher whiteout over the opaque lens's own at-cut positive.)
  // ════════════════════════════════════════════════════════════════════════════
  it("vector 21a: a higher lens's whiteout of the opaque lens's own child wins (child dropped)", async function () {
    const root = await createAnchor("root", ZERO_BYTES32);
    const dir = await createAnchor("dir", root);

    // Viewer stack [bob (L0, above), owner (L1, opaque), alice (L2, below)].
    const child = await createAnchor("c.txt", dir, dataSchemaUID);
    // L1 = owner makes `dir` opaque AND places its OWN content at `child` (owner is AT the cut line).
    await attestOpaque(dir, owner);
    await createPin(child, await mintData(owner), owner);

    // Baseline: with [owner, alice] the opaque-lens's own child IS shown (vector 17 territory).
    let page = await fileView.getDirectoryPageBySchemaAndAddressList(
      dir,
      dataSchemaUID,
      [ownerAddr, aliceAddr],
      "0x",
      10,
    );
    expect(page.items.map(i => i.uid)).to.deep.equal([child]);

    // L0 = bob (strictly ABOVE owner) whites out `child`. Viewer [bob, owner, alice]: bob's negative
    // terminal at i=0 fires BEFORE owner's positive placement at i=1 → child dropped.
    await attestWhiteout(child, bob);
    page = await fileView.getDirectoryPageBySchemaAndAddressList(
      dir,
      dataSchemaUID,
      [bobAddr, ownerAddr, aliceAddr],
      "0x",
      10,
    );
    expect(page.items.length).to.equal(0); // the higher whiteout legitimately wins
  });

  // ════════════════════════════════════════════════════════════════════════════
  // VECTOR 21b — multi-level opaque cut: two opaque lenses in one stack (P3 close-out)
  //   Stack [L0, L1(opaque), L2, L3(opaque)] listing `dir` where L1 AND L3 both opaque `dir`. The
  //   highest-precedence opaque (L1) is the effective cut — children contributed by L2/L3/below are
  //   dropped, L0/L1's own children are shown. (Exercises `_opaqueCutIdx` returning the FIRST/highest
  //   opaque and stopping; a lower opaque is irrelevant once a higher one cuts.)
  // ════════════════════════════════════════════════════════════════════════════
  it("vector 21b: with two opaque lenses, the highest-precedence opaque is the effective cut", async function () {
    const root = await createAnchor("root", ZERO_BYTES32);
    const dir = await createAnchor("dir", root);

    // Viewer stack [bob (L0), owner (L1, opaque), alice (L2), carol (L3, opaque)].
    const [, , , carol] = await ethers.getSigners();
    const carolAddr = await carol.getAddress();

    // One child per lens, each placed by that lens (so each child's contributing lens is its placer).
    const bobChild = await createAnchor("bob.txt", dir, dataSchemaUID);
    const ownerChild = await createAnchor("owner.txt", dir, dataSchemaUID);
    const aliceChild = await createAnchor("alice.txt", dir, dataSchemaUID);
    const carolChild = await createAnchor("carol.txt", dir, dataSchemaUID);
    await createPin(bobChild, await mintData(bob), bob);
    await createPin(ownerChild, await mintData(owner), owner);
    await createPin(aliceChild, await mintData(alice), alice);
    await createPin(carolChild, await mintData(carol), carol);

    // L1 = owner AND L3 = carol both opaque `dir`. The cut is at the HIGHEST (owner, idx 1).
    await attestOpaque(dir, owner);
    await attestOpaque(dir, carol);

    const page = await fileView.getDirectoryPageBySchemaAndAddressList(
      dir,
      dataSchemaUID,
      [bobAddr, ownerAddr, aliceAddr, carolAddr],
      "0x",
      10,
    );
    // L0 (bob, i=0) and L1 (owner, i=1, AT the cut) shown; L2 (alice, i=2) and L3 (carol, i=3) cut.
    expect(page.items.map(i => i.uid)).to.have.members([bobChild, ownerChild]);
    expect(page.items.map(i => i.uid)).to.not.have.members([aliceChild, carolChild]);
    expect(page.items.length).to.equal(2);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // VECTOR 22 — opaque write-guards (each invalid opaque write reverts with the specific error)
  // ════════════════════════════════════════════════════════════════════════════
  describe("vector 22: opaque write-guard rejections", function () {
    let root: string;
    let folder: string;
    let fileAnchor: string;

    beforeEach(async function () {
      root = await createAnchor("root", ZERO_BYTES32);
      folder = await createAnchor("folder", root, ZERO_BYTES32); // generic folder (forSchema == 0)
      fileAnchor = await createAnchor("file.txt", root, dataSchemaUID); // forSchema != 0
    });

    it("refUID is a FILE anchor (forSchema != 0) → OpaqueTargetNotFolder", async function () {
      await expect(attestOpaque(fileAnchor, owner)).to.be.revertedWithCustomError(
        whiteoutResolver,
        "OpaqueTargetNotFolder",
      );
    });

    it("refUID is a DATA attestation (not an anchor) → OpaqueTargetNotFolder", async function () {
      const dUID = await mintData(owner);
      await expect(attestOpaque(dUID, owner)).to.be.revertedWithCustomError(whiteoutResolver, "OpaqueTargetNotFolder");
    });

    it("refUID = 0 → ZeroRef", async function () {
      await expect(attestOpaque(ZERO_BYTES32, owner)).to.be.revertedWithCustomError(whiteoutResolver, "ZeroRef");
    });

    it("non-revocable attestation → NotRevocable", async function () {
      await expect(attestOpaque(folder, owner, { revocable: false })).to.be.revertedWithCustomError(
        whiteoutResolver,
        "NotRevocable",
      );
    });

    it("non-zero expirationTime → HasExpiration", async function () {
      const future = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 3600);
      await expect(attestOpaque(folder, owner, { expirationTime: future })).to.be.revertedWithCustomError(
        whiteoutResolver,
        "HasExpiration",
      );
    });

    it("payload = abi.encode(false) → BadPayload", async function () {
      const falsePayload = enc.encode(["bool"], [false]);
      await expect(attestOpaque(folder, owner, { data: falsePayload })).to.be.revertedWithCustomError(
        whiteoutResolver,
        "BadPayload",
      );
    });

    it("empty payload (wrong length) → BadPayload", async function () {
      await expect(attestOpaque(folder, owner, { data: "0x" })).to.be.revertedWithCustomError(
        whiteoutResolver,
        "BadPayload",
      );
    });

    it("foreign schema (correct opaque shape) pointed at this resolver → WrongSchema", async function () {
      // A schema with a DIFFERENT field string but this resolver — not WHITEOUT or WHITEOUT_OPAQUE.
      const foreignField = "bool somethingElse";
      await (await registry.register(foreignField, whiteoutResolverAddr, true)).wait();
      const foreignUID = ethers.solidityPackedKeccak256(
        ["string", "address", "bool"],
        [foreignField, whiteoutResolverAddr, true],
      );
      await expect(attestOpaque(folder, owner, { schema: foreignUID })).to.be.revertedWithCustomError(
        whiteoutResolver,
        "WrongSchema",
      );
    });

    it("a valid opaque on a generic folder succeeds (positive control)", async function () {
      await attestOpaque(folder, owner);
      expect(await whiteoutResolver.isOpaque(folder, ownerAddr)).to.equal(true);
    });

    it("opaque on ROOT-level folder is allowed (no OrphanAnchor — opaque keys on (dir) alone)", async function () {
      // Unlike a per-name whiteout, opaque has no parent-slot, so a root child folder is a valid target.
      await attestOpaque(root, owner);
      expect(await whiteoutResolver.isOpaque(root, ownerAddr)).to.equal(true);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // VECTOR 23 — opaque participates in the FILTERED listing too (doubly-suppressed skipped once)
  // ════════════════════════════════════════════════════════════════════════════
  describe("vector 23: opaque in getDirectoryPageFiltered (filtered walker)", function () {
    let excludeTagDef: string;

    beforeEach(async function () {
      const tx = await registry.register("string opaqueFilterLabel", ZeroAddress, false);
      excludeTagDef = (await tx.wait())!.logs[0].topics[1];
    });

    it("(a) opaque drops lower-lens items from a FILTERED listing (empty exclude policy)", async function () {
      const root = await createAnchor("root", ZERO_BYTES32);
      const dir = await createAnchor("dir", root);

      const own = await createAnchor("mine.txt", dir, dataSchemaUID);
      const hers = await createAnchor("hers.txt", dir, dataSchemaUID);
      await createPin(own, await mintData(owner), owner);
      await createPin(hers, await mintData(alice), alice);
      await attestOpaque(dir, owner);

      const page = await fileView.getDirectoryPageFiltered(
        dir,
        dataSchemaUID,
        [ownerAddr, aliceAddr],
        [],
        [],
        "0x",
        10,
      );
      expect(page.items.map(i => i.uid)).to.deep.equal([own]); // alice's opaque-cut, owner's own kept
      expect(page.nextCursor).to.equal("0x");
    });

    it("(b) an item suppressed by BOTH opaque AND a tag-exclusion is skipped exactly once", async function () {
      const root = await createAnchor("root", ZERO_BYTES32);
      const dir = await createAnchor("dir", root);

      // alice files: `both` is opaque-cut AND tag-excluded; `lowerClean` only opaque-cut. owner: `clean`.
      const both = await createAnchor("both.txt", dir, dataSchemaUID);
      const lowerClean = await createAnchor("lower.txt", dir, dataSchemaUID);
      const clean = await createAnchor("clean.txt", dir, dataSchemaUID);
      const dBoth = await mintData(alice);
      await createPin(both, dBoth, alice);
      await createPin(lowerClean, await mintData(alice), alice);
      await createPin(clean, await mintData(owner), owner);

      await createTag(excludeTagDef, dBoth, alice, 1n); // tag-exclude `both`
      await attestOpaque(dir, owner); // opaque cuts all of alice's (both + lowerClean)

      // Paginate at size 1 across the whole source: only owner's `clean` survives, emitted once.
      const seen: string[] = [];
      let cursor = "0x";
      let calls = 0;
      while (true) {
        calls++;
        if (calls > 20) throw new Error("filtered+opaque pagination did not terminate");
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
      expect(seen).to.deep.equal([clean]);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // VECTOR 24 — direct file resolution under an opaque dir (router 2-B + getFilesAtPath)
  //   Full-unionfs: a deep link into a suppressed subtree 404s. The router applies the per-segment
  //   opaque cut; getFilesAtPath applies the terminal opaque cut. Both must agree.
  // ════════════════════════════════════════════════════════════════════════════
  describe("vector 24: direct file resolution under an opaque dir (router + getFilesAtPath)", function () {
    let router: EFSRouter;
    let mirrorResolver: any;
    let dir: string;
    let fileAnchor: string;

    beforeEach(async function () {
      // Rebuild a router-capable stack (mirrors vector 10's setup), then make `dir` opaque by OWNER.
      const RegistryFactory = await ethers.getContractFactory("SchemaRegistry");
      const reg2 = await RegistryFactory.deploy();
      await reg2.waitForDeployment();
      const EASFactory = await ethers.getContractFactory("EAS");
      const eas2 = (await EASFactory.deploy(await reg2.getAddress())) as EAS;
      await eas2.waitForDeployment();
      eas = eas2;
      registry = reg2;

      const a = ownerAddr;
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
      mirrorResolver = await deployResolverProxy("MirrorResolver", [await eas2.getAddress()], [idxAddr, a], owner);
      indexer = await deployIndexerProxy(
        await eas2.getAddress(),
        anchorSchemaUID,
        propertySchemaUID,
        dataSchemaUID,
        owner,
      );

      await (await reg2.register(ANCHOR_SCHEMA, idxAddr, false)).wait();
      await (await reg2.register(PROPERTY_SCHEMA, idxAddr, false)).wait();
      await (await reg2.register(DATA_SCHEMA, idxAddr, false)).wait();
      await (await reg2.register(PIN_SCHEMA, edgeAddr, true)).wait();
      await (await reg2.register(TAG_SCHEMA, edgeAddr, true)).wait();
      await (await reg2.register("bytes32 transportDefinition, string uri", mirrorAddr, true)).wait();

      const woNonce = await ethers.provider.getTransactionCount(a);
      // +0 register WHITEOUT, +1 register WHITEOUT_OPAQUE, +2 impl, +3 proxy.
      const woAddr = ethers.getCreateAddress({ from: a, nonce: woNonce + 3 });
      whiteoutSchemaUID = ethers.solidityPackedKeccak256(
        ["string", "address", "bool"],
        [WHITEOUT_SCHEMA, woAddr, true],
      );
      whiteoutOpaqueSchemaUID = ethers.solidityPackedKeccak256(
        ["string", "address", "bool"],
        [WHITEOUT_OPAQUE_SCHEMA, woAddr, true],
      );
      await (await reg2.register(WHITEOUT_SCHEMA, woAddr, true)).wait();
      await (await reg2.register(WHITEOUT_OPAQUE_SCHEMA, woAddr, true)).wait();

      whiteoutResolver = await deployResolverProxy<WhiteoutResolver>(
        "WhiteoutResolver",
        [await eas2.getAddress()],
        [await indexer.getAddress()],
        owner,
      );
      expect(await whiteoutResolver.getAddress()).to.equal(woAddr);

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
        ZeroAddress,
        await whiteoutResolver.getAddress(),
      )) as EFSRouter;
      await router.waitForDeployment();

      // FileView wired with the same whiteout resolver for view/router consistency.
      const FileViewFactory = await ethers.getContractFactory("EFSFileView");
      fileView = (await FileViewFactory.deploy(
        await indexer.getAddress(),
        await edgeResolver.getAddress(),
        await whiteoutResolver.getAddress(),
      )) as EFSFileView;
      await fileView.waitForDeployment();

      const dirRoot = await createAnchor("root", ZERO_BYTES32);
      const transportsUID = await createAnchor("transports", dirRoot);
      const onchainUID = await createAnchor("onchain", transportsUID);
      await mirrorResolver.setTransportsAnchor(transportsUID);

      dir = await createAnchor("dir", dirRoot);
      fileAnchor = await createAnchor("doc.txt", dir, dataSchemaUID);

      // ALICE places content with a web3:// mirror so an un-suppressed read serves 200.
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
    });

    it("baseline: with no opaque, [owner, alice] resolves alice's file (200) and getFilesAtPath sees it", async function () {
      const res = await router.request(["dir", "doc.txt"], [{ key: "lenses", value: `${ownerAddr},${aliceAddr}` }]);
      expect(res.statusCode).to.equal(200n);
      const page = await fileView.getFilesAtPath(fileAnchor, [ownerAddr, aliceAddr], dataSchemaUID, "0x", 10);
      expect(page.items.length).to.equal(1);
    });

    it("owner makes `dir` opaque → router 404s the deep link for [owner, alice]; getFilesAtPath empty", async function () {
      await attestOpaque(dir, owner);

      // Router: the terminal segment (doc.txt under the opaque dir) is alice-contributed (below the
      // cut) → 404. (The terminal-segment opaque cut suffices here; the per-segment machinery also
      // covers intermediate folders deeper down.)
      const res = await router.request(["dir", "doc.txt"], [{ key: "lenses", value: `${ownerAddr},${aliceAddr}` }]);
      expect(res.statusCode).to.equal(404n);

      // getFilesAtPath agrees (view/router consistency).
      const page = await fileView.getFilesAtPath(fileAnchor, [ownerAddr, aliceAddr], dataSchemaUID, "0x", 10);
      expect(page.items.length).to.equal(0);
    });

    it("a viewer EXCLUDING the opaque lens still resolves (200) — opaque is lens-scoped", async function () {
      await attestOpaque(dir, owner);
      const res = await router.request(["dir", "doc.txt"], [{ key: "lenses", value: `${aliceAddr}` }]);
      expect(res.statusCode).to.equal(200n);
      const page = await fileView.getFilesAtPath(fileAnchor, [aliceAddr], dataSchemaUID, "0x", 10);
      expect(page.items.length).to.equal(1);
    });

    it("the opaque lens's OWN re-add resolves (200) — opaque shows the curating lens's content", async function () {
      await attestOpaque(dir, owner);
      // OWNER places his own content at the terminal anchor → he is AT the cut line (not below) → 200.
      await createPin(fileAnchor, await mintData(owner), owner);
      await eas.connect(owner).attest({
        schema: mirrorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: await edgeResolver.getActivePinTarget(fileAnchor, ownerAddr, dataSchemaUID),
          data: enc.encode(
            ["bytes32", "string"],
            [
              await indexer.resolvePath(
                await indexer.resolvePath(await indexer.rootAnchorUID(), "transports"),
                "onchain",
              ),
              `web3://${await eas.getAddress()}`,
            ],
          ),
          value: 0n,
        },
      });
      const res = await router.request(["dir", "doc.txt"], [{ key: "lenses", value: `${ownerAddr},${aliceAddr}` }]);
      expect(res.statusCode).to.equal(200n);
    });

    // ────────────────────────────────────────────────────────────────────────
    // VECTOR 24c — INTERMEDIATE-segment opaque cut (router 2-B non-terminal branch, P3 close-out)
    //   A deep link `/dir/sub/file` where `sub` (and thus `file`) is contributed by a BELOW-cut lens
    //   (alice). With OWNER making `dir` opaque, the router's per-segment cut must 404 at the
    //   INTERMEDIATE `sub` segment — not just the terminal — so suppression can't be bypassed by
    //   deep-linking past the listing. Exercises the non-terminal branch of EFSRouter's per-segment
    //   opaque cut (the `i != resource.length - 1` resolvePath path, then `_segmentOpaqueSuppressed`).
    // ────────────────────────────────────────────────────────────────────────
    it("intermediate-segment opaque cut: a deep link through a below-cut subfolder 404s at the intermediate segment", async function () {
      // Build `/dir/sub/file.txt`: `sub` is a generic FOLDER made visible by ALICE's visibility TAG
      // (definition = dataSchemaUID, ADR-0038); `file.txt` under it is placed by ALICE. Both are
      // below-cut content. `dir` itself stays a normal (non-opaque, transparent) folder for now.
      const sub = await createAnchor("sub", dir, ZERO_BYTES32);
      await createTag(dataSchemaUID, sub, alice); // alice contributes `sub`'s visibility (folder)
      const deepFile = await createAnchor("file.txt", sub, dataSchemaUID);
      const dDeep = await mintData(alice);
      await createPin(deepFile, dDeep, alice);
      await eas.connect(alice).attest({
        schema: mirrorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: dDeep,
          data: enc.encode(
            ["bytes32", "string"],
            [
              await indexer.resolvePath(
                await indexer.resolvePath(await indexer.rootAnchorUID(), "transports"),
                "onchain",
              ),
              `web3://${await eas.getAddress()}`,
            ],
          ),
          value: 0n,
        },
      });

      // Baseline: with no opaque, [owner, alice] resolves the deep file (200) — proves the deep path
      // is otherwise reachable, so the later 404 is the opaque cut, not a missing path.
      let res = await router.request(
        ["dir", "sub", "file.txt"],
        [{ key: "lenses", value: `${ownerAddr},${aliceAddr}` }],
      );
      expect(res.statusCode).to.equal(200n);

      // OWNER makes `dir` opaque. The deep link walks: segment `sub` is resolved UNDER `dir` (the
      // INTERMEDIATE segment), `sub`'s contributing lens is alice (below the cut) → suppressed → 404
      // at the intermediate segment, before the terminal `file.txt` is ever reached.
      await attestOpaque(dir, owner);
      res = await router.request(["dir", "sub", "file.txt"], [{ key: "lenses", value: `${ownerAddr},${aliceAddr}` }]);
      expect(res.statusCode).to.equal(404n);

      // Lens-scoped: a viewer EXCLUDING the opaque lens still resolves the deep file (200).
      const aliceRes = await router.request(["dir", "sub", "file.txt"], [{ key: "lenses", value: `${aliceAddr}` }]);
      expect(aliceRes.statusCode).to.equal(200n);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // RESOLVER-UNIT — opaque marker liveness, last-writer-wins, append-once discovery
  // ════════════════════════════════════════════════════════════════════════════
  describe("resolver-unit: opaque marker semantics", function () {
    let root: string;
    let folder: string;

    beforeEach(async function () {
      root = await createAnchor("root", ZERO_BYTES32);
      folder = await createAnchor("folder", root, ZERO_BYTES32);
    });

    it("isOpaque toggles true on attest, false on revoke", async function () {
      expect(await whiteoutResolver.isOpaque(folder, ownerAddr)).to.equal(false);
      const opUID = await attestOpaque(folder, owner);
      expect(await whiteoutResolver.isOpaque(folder, ownerAddr)).to.equal(true);
      await revoke(whiteoutOpaqueSchemaUID, opUID, owner);
      expect(await whiteoutResolver.isOpaque(folder, ownerAddr)).to.equal(false);
    });

    it("append-once: re-opaquing the same dir by the same attester does not double-push", async function () {
      await attestOpaque(folder, owner);
      await attestOpaque(folder, owner);
      expect(await whiteoutResolver.getOpaqueDirsCount(ownerAddr)).to.equal(1n);
      expect(await whiteoutResolver.isOpaque(folder, ownerAddr)).to.equal(true);
    });

    it("last-writer-wins: revoking a STALE opaque UID does not clear the live newer marker", async function () {
      const first = await attestOpaque(folder, owner);
      const second = await attestOpaque(folder, owner); // overwrites the live marker
      expect(await whiteoutResolver.isOpaque(folder, ownerAddr)).to.equal(true);

      await revoke(whiteoutOpaqueSchemaUID, first, owner); // stale → no-op
      expect(await whiteoutResolver.isOpaque(folder, ownerAddr)).to.equal(true);

      await revoke(whiteoutOpaqueSchemaUID, second, owner); // live → clears
      expect(await whiteoutResolver.isOpaque(folder, ownerAddr)).to.equal(false);
    });

    it("opaque is lens-scoped at the resolver: another attester's marker is independent", async function () {
      await attestOpaque(folder, owner);
      expect(await whiteoutResolver.isOpaque(folder, ownerAddr)).to.equal(true);
      expect(await whiteoutResolver.isOpaque(folder, aliceAddr)).to.equal(false);
    });
  });
});
