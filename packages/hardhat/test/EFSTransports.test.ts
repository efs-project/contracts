import { expect } from "chai";
import { ethers } from "hardhat";
import { EFSIndexer, EdgeResolver, MirrorResolver, EFSFileView, EAS, SchemaRegistry } from "../typechain-types";
import { Signer, ZeroAddress, ZeroHash } from "ethers";
import { deployIndexerProxy } from "./helpers/deployIndexerProxy";
import { deployResolverProxy } from "./helpers/deployResolverProxy";

const ZERO_BYTES32 = ZeroHash;
const NO_EXPIRATION = 0n;

/**
 * EFS Transports & Data Model — exercises the standalone DATA, MIRROR, and
 * placement primitives under the ADR-0041 PIN/TAG model.
 *
 * - File placement (DATA at a folder/anchor slot) is PIN (cardinality 1):
 *     PIN(definition=anchorUID, refUID=DATA) — one active PIN per
 *     (attester, definition, targetSchema) slot. Removal is `eas.revoke()`,
 *     never `applies=false`.
 * - PROPERTY value binding (contentType, etc.) is also PIN under a key anchor.
 * - Folder visibility / sub-folder enumeration would be TAG (cardinality N) but
 *   isn't exercised here — those cases live in EFSFileView.test.ts.
 */
describe("EFS Transports & Data Model", function () {
  let indexer: EFSIndexer;
  let edgeResolver: EdgeResolver;
  let mirrorResolver: MirrorResolver;
  let fileView: EFSFileView;
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
  let mirrorSchemaUID: string;

  let rootUID: string;
  let transportsUID: string;
  let ipfsTransportUID: string;
  let arweaveTransportUID: string;
  let onchainTransportUID: string;
  let _httpsTransportUID: string;
  let _magnetTransportUID: string;

  // Per-test active-edge index: `${target}|${definition}|${attester}` → live attestation UID.
  // Lets `unpin()` revoke the live PIN without per-test bookkeeping.
  let activePinIndex: Map<string, string>;

  const enc = new ethers.AbiCoder();

  const encodeAnchor = (name: string, schema: string = ZERO_BYTES32) =>
    enc.encode(["string", "bytes32"], [name, schema]);

  const encodePropertyValue = (value: string) => enc.encode(["string"], [value]);

  const encodePin = (definition: string) => enc.encode(["bytes32"], [definition]);

  const encodeMirror = (transportDef: string, uri: string) => enc.encode(["bytes32", "string"], [transportDef, uri]);

  const getUID = (receipt: any): string => {
    for (const log of receipt.logs) {
      try {
        const parsed = eas.interface.parseLog(log);
        if (parsed?.name === "Attested") return parsed.args.uid;
      } catch {}
    }
    throw new Error("No Attested event found");
  };

  beforeEach(async function () {
    [owner, alice, bob] = await ethers.getSigners();
    const ownerAddr = await owner.getAddress();
    activePinIndex = new Map();

    // Deploy EAS infrastructure
    const RegistryFactory = await ethers.getContractFactory("SchemaRegistry");
    registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();

    const EASFactory = await ethers.getContractFactory("EAS");
    eas = await EASFactory.deploy(await registry.getAddress());
    await eas.waitForDeployment();

    // Nonce prediction (EdgeResolver, MirrorResolver, and EFSIndexer are all proxy-ified, ADR-0048):
    //   nonce+0:  EdgeResolver implementation
    //   nonce+1:  EdgeResolver proxy (the resolver baked into the PIN/TAG schema UIDs)
    //   nonce+2:  MirrorResolver implementation
    //   nonce+3:  MirrorResolver proxy (the resolver baked into the MIRROR schema UID)
    //   nonce+4:  ANCHOR schema
    //   nonce+5:  PROPERTY schema
    //   nonce+6:  DATA schema (empty — ADR-0049)
    //   nonce+7:  PIN schema
    //   nonce+8:  TAG schema
    //   nonce+9:  MIRROR schema
    //   nonce+10: EFSIndexer implementation
    //   nonce+11: EFSIndexer proxy (the resolver baked into the EFS schema UIDs)
    //   nonce+12: EFSFileView
    const currentNonce = await ethers.provider.getTransactionCount(ownerAddr);

    // EdgeResolver PROXY is the resolver (ADR-0048): impl = +0, proxy = +1. See deployResolverProxy().
    const futureEdgeResolverAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: currentNonce + 1 });
    // MirrorResolver PROXY is the resolver (ADR-0048): impl = +2, proxy = +3.
    const futureMirrorResolverAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: currentNonce + 3 });
    // EFSIndexer PROXY is the resolver (ADR-0048): impl = +10, proxy = +11. See deployIndexerProxy().
    const futureIndexerAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: currentNonce + 11 });

    // Pre-compute schema UIDs
    anchorSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      ["string name, bytes32 forSchema", futureIndexerAddr, false],
    );
    propertySchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      ["string value", futureIndexerAddr, false],
    );
    // DATA is an empty schema — pure identity (ADR-0049).
    dataSchemaUID = ethers.solidityPackedKeccak256(["string", "address", "bool"], ["", futureIndexerAddr, false]);
    pinSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      ["bytes32 definition", futureEdgeResolverAddr, true],
    );
    tagSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      ["bytes32 definition, int256 weight", futureEdgeResolverAddr, true],
    );
    mirrorSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      ["bytes32 transportDefinition, string uri", futureMirrorResolverAddr, true],
    );

    // Deploy EdgeResolver behind a proxy (ADR-0048): impl + proxy; initialize() sets the PIN/TAG
    // schema UIDs + partner refs. The proxy address is baked into the PIN/TAG schema UIDs.
    edgeResolver = await deployResolverProxy<EdgeResolver>(
      "EdgeResolver",
      [await eas.getAddress()],
      [pinSchemaUID, tagSchemaUID, futureIndexerAddr, await registry.getAddress()],
      owner,
    );
    expect(await edgeResolver.getAddress()).to.equal(futureEdgeResolverAddr);

    // Deploy MirrorResolver behind a proxy (ADR-0048). initialize() wires the (predicted) indexer
    // proxy address + owner; the proxy address is what's baked into the MIRROR schema UID.
    mirrorResolver = await deployResolverProxy<MirrorResolver>(
      "MirrorResolver",
      [await eas.getAddress()],
      [futureIndexerAddr, ownerAddr],
      owner,
    );
    expect(await mirrorResolver.getAddress()).to.equal(futureMirrorResolverAddr);

    // Register schemas
    await (await registry.register("string name, bytes32 forSchema", futureIndexerAddr, false)).wait();
    await (await registry.register("string value", futureIndexerAddr, false)).wait();
    await (await registry.register("", futureIndexerAddr, false)).wait(); // DATA: empty schema (ADR-0049)
    await (await registry.register("bytes32 definition", await edgeResolver.getAddress(), true)).wait();
    await (await registry.register("bytes32 definition, int256 weight", await edgeResolver.getAddress(), true)).wait();
    await (
      await registry.register("bytes32 transportDefinition, string uri", await mirrorResolver.getAddress(), true)
    ).wait();

    // Deploy EFSIndexer behind a proxy (ADR-0048)
    indexer = await deployIndexerProxy(
      await eas.getAddress(),
      anchorSchemaUID,
      propertySchemaUID,
      dataSchemaUID,
      owner,
    );
    expect(await indexer.getAddress()).to.equal(futureIndexerAddr);

    // Deploy EFSFileView
    const FileViewFactory = await ethers.getContractFactory("EFSFileView");
    fileView = await FileViewFactory.deploy(await indexer.getAddress(), await edgeResolver.getAddress());

    // Wire contracts
    await indexer.wireContracts(
      await edgeResolver.getAddress(),
      pinSchemaUID,
      tagSchemaUID,
      ZeroAddress, // no sort overlay in this test
      ZERO_BYTES32,
      await mirrorResolver.getAddress(),
      mirrorSchemaUID,
      await registry.getAddress(),
    );

    // Create root anchor
    const rootTx = await eas.attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: ZERO_BYTES32,
        data: encodeAnchor("root"),
        value: 0n,
      },
    });
    rootUID = getUID(await rootTx.wait());
    expect(await indexer.rootAnchorUID()).to.equal(rootUID);

    // Create /transports/ anchor tree (shared across all tests)
    const mkAnchor = async (parent: string, name: string) => {
      const tx = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: parent,
          data: encodeAnchor(name),
          value: 0n,
        },
      });
      return getUID(await tx.wait());
    };
    transportsUID = await mkAnchor(rootUID, "transports");
    ipfsTransportUID = await mkAnchor(transportsUID, "ipfs");
    arweaveTransportUID = await mkAnchor(transportsUID, "arweave");
    onchainTransportUID = await mkAnchor(transportsUID, "onchain");
    _httpsTransportUID = await mkAnchor(transportsUID, "https");
    _magnetTransportUID = await mkAnchor(transportsUID, "magnet");

    // Wire transport ancestry into MirrorResolver
    await mirrorResolver.setTransportsAnchor(transportsUID);
  });

  // ─── Helpers ──────────────────────────────────────────────────────────────

  async function createAnchor(
    parentUID: string,
    name: string,
    schema: string = ZERO_BYTES32,
    signer: Signer = owner,
  ): Promise<string> {
    const tx = await eas.connect(signer).attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: parentUID,
        data: encodeAnchor(name, schema),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  }

  // DATA is an empty schema — pure identity (ADR-0049). The `_contentHash`/`_size` params are
  // ignored (kept so existing call sites read clearly about what the DATA stands for); the DATA
  // attestation itself carries no inline payload.
  async function createData(_contentHash: string, _size: bigint, signer: Signer = owner): Promise<string> {
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
  }

  /**
   * Attach a PROPERTY to a container under the unified free-floating model
   * (ADR-0035) but with PIN-based binding (ADR-0041): key anchor under the
   * container, free-floating PROPERTY(value), and a PIN (cardinality 1) that
   * binds them. Returns the PROPERTY UID. Re-binding the same key with a new
   * PROPERTY UID supersedes the prior PIN in O(1).
   */
  async function createProperty(
    containerUID: string,
    key: string,
    value: string,
    signer: Signer = owner,
  ): Promise<string> {
    let keyAnchorUID: string = await indexer.resolveAnchor(containerUID, key, propertySchemaUID);
    if (keyAnchorUID === ZERO_BYTES32) {
      const keyTx = await eas.connect(signer).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: containerUID,
          data: encodeAnchor(key, propertySchemaUID),
          value: 0n,
        },
      });
      keyAnchorUID = getUID(await keyTx.wait());
    }

    const propTx = await eas.connect(signer).attest({
      schema: propertySchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: ZERO_BYTES32,
        data: encodePropertyValue(value),
        value: 0n,
      },
    });
    const propertyUID = getUID(await propTx.wait());

    await pinAt(propertyUID, keyAnchorUID, signer);
    return propertyUID;
  }

  /**
   * PIN a target under a definition (cardinality 1: each attester has one
   * active PIN per (definition, targetSchema) slot). Re-pinning at the same
   * slot supersedes prior PIN in O(1). Returns the PIN attestation UID.
   */
  async function pinAt(targetUID: string, definitionUID: string, signer: Signer = owner): Promise<string> {
    const tx = await eas.connect(signer).attest({
      schema: pinSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: targetUID,
        data: encodePin(definitionUID),
        value: 0n,
      },
    });
    const uid = getUID(await tx.wait());
    activePinIndex.set(`${targetUID}|${definitionUID}|${await signer.getAddress()}`, uid);
    return uid;
  }

  /** Revoke the live PIN for (target, def, attester). */
  async function unpinAt(targetUID: string, definitionUID: string, signer: Signer = owner): Promise<void> {
    const key = `${targetUID}|${definitionUID}|${await signer.getAddress()}`;
    const uid = activePinIndex.get(key);
    if (uid === undefined) throw new Error(`no active PIN tracked for ${key}`);
    await eas.connect(signer).revoke({
      schema: pinSchemaUID,
      data: { uid, value: 0n },
    });
    activePinIndex.delete(key);
  }

  async function createMirror(
    dataUID: string,
    transportDefUID: string,
    uri: string,
    signer: Signer = owner,
  ): Promise<string> {
    const tx = await eas.connect(signer).attest({
      schema: mirrorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: dataUID,
        data: encodeMirror(transportDefUID, uri),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  }

  // ─── DATA Tests ───────────────────────────────────────────────────────────

  describe("Standalone DATA", function () {
    it("should create standalone DATA — empty, pure identity (ADR-0049)", async function () {
      const contentHash = ethers.keccak256(ethers.toUtf8Bytes("hello world"));
      const dataUID = await createData(contentHash, 11n);

      expect(dataUID).to.not.equal(ZERO_BYTES32);
      const att = await eas.getAttestation(dataUID);
      expect(att.schema).to.equal(dataSchemaUID);
      expect(att.refUID).to.equal(ZERO_BYTES32); // standalone
      expect(att.revocable).to.equal(false);
      expect(att.data).to.equal("0x"); // empty schema — no inline fields
    });

    // AGENT-NOTE: removed "should populate dataByContentKey on first DATA" and "should not
    // overwrite dataByContentKey for duplicate contentHash" — DATA is empty (ADR-0049), carries
    // no contentHash, and `dataByContentKey` is no longer written. Content-hash dedup moves to
    // the property index + REDIRECT primitive (ADR-0050); that's future PROPERTY/SDK work.

    it("should reject DATA with refUID (must be standalone)", async function () {
      // Create an anchor to use as refUID
      const anchorUID = await createAnchor(rootUID, "test-folder");

      // DATA with refUID should fail (resolver returns false → EAS reverts)
      await expect(
        eas.attest({
          schema: dataSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: anchorUID,
            data: "0x", // empty DATA (ADR-0049)
            value: 0n,
          },
        }),
      ).to.be.reverted;
    });
  });

  // ─── Lifecycle: permanent content schemas reject EAS expiry (PR #24 P2) ─────
  // ANCHOR/DATA/PROPERTY are non-revocable permanent structure; EFS reads filter on revocation/index
  // state, not EAS expiry, so an expiring one would resolve forever past expiry. The kernel rejects a
  // nonzero expirationTime alongside the existing non-revocable checks. Far-future expiry passes EAS's
  // own check and reaches EFSIndexer.onAttest (which returns false → EAS reverts the attestation).
  describe("permanent content rejects EAS expiry", function () {
    const FUTURE_EXPIRY = 9_999_999_999n;

    it("rejects an ANCHOR with a nonzero expirationTime", async function () {
      await expect(
        eas.attest({
          schema: anchorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: FUTURE_EXPIRY,
            revocable: false,
            refUID: rootUID,
            data: encodeAnchor("expiring-folder"),
            value: 0n,
          },
        }),
      ).to.be.reverted;
    });

    it("rejects a DATA with a nonzero expirationTime", async function () {
      await expect(
        eas.attest({
          schema: dataSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: FUTURE_EXPIRY,
            revocable: false,
            refUID: ZERO_BYTES32,
            data: "0x",
            value: 0n,
          },
        }),
      ).to.be.reverted;
    });

    it("rejects a PROPERTY with a nonzero expirationTime", async function () {
      await expect(
        eas.attest({
          schema: propertySchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: FUTURE_EXPIRY,
            revocable: false,
            refUID: ZERO_BYTES32,
            data: encodePropertyValue("x"),
            value: 0n,
          },
        }),
      ).to.be.reverted;
    });
  });

  // ─── PROPERTY on DATA Tests ───────────────────────────────────────────────

  describe("PROPERTY on DATA", function () {
    it("should allow PROPERTY on DATA attestation (contentType)", async function () {
      const contentHash = ethers.keccak256(ethers.toUtf8Bytes("image data"));
      const dataUID = await createData(contentHash, 1024n);
      const propUID = await createProperty(dataUID, "contentType", "image/jpeg");

      expect(propUID).to.not.equal(ZERO_BYTES32);
    });
  });

  // ─── MIRROR Tests ─────────────────────────────────────────────────────────

  describe("MirrorResolver", function () {
    let testDataUID: string;

    beforeEach(async function () {
      // Create a DATA to attach mirrors to
      const contentHash = ethers.keccak256(ethers.toUtf8Bytes("cat.jpg"));
      testDataUID = await createData(contentHash, 50000n);
    });

    it("should create MIRROR on DATA", async function () {
      const mirrorUID = await createMirror(testDataUID, ipfsTransportUID, "ipfs://QmTestHash123");
      expect(mirrorUID).to.not.equal(ZERO_BYTES32);
    });

    it("rejects a MIRROR with non-canonical (trailing-byte) payload (NonCanonicalPayload)", async function () {
      // Regression for Codex P2 (comment 3433701055): abi.decode tolerates a canonical prefix with
      // trailing words, so `abi.encode(transportDefinition, uri) || extraWord` decodes to the SAME
      // (transportDefinition, uri) and would mint a second mirror under a distinct permanent UID, while
      // an SDK/subgraph reconstructing the UID from the decoded fields sees only one. The dynamic
      // `string uri` rules out a fixed-length check, so MirrorResolver re-encodes and hash-compares.
      // Transport + uri + DATA are all valid here, so ONLY the canonical-payload guard can reject it.
      const canonical = encodeMirror(ipfsTransportUID, "ipfs://QmCanonical");
      await expect(
        eas.connect(owner).attest({
          schema: mirrorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: testDataUID,
            data: canonical + "00".repeat(32), // one trailing word past the canonical encoding
            value: 0n,
          },
        }),
      ).to.be.revertedWithCustomError(mirrorResolver, "NonCanonicalPayload");
    });

    it("rejects a FOREIGN schema pointed at MirrorResolver (WrongSchema) — no MirrorSet/index", async function () {
      // Regression for Codex P2 (comment 3432672732): EAS invokes onAttest for ANY schema registered
      // against this resolver. A foreign schema with an otherwise-valid DATA ref + transport + URI must
      // NOT pass — it would emit MirrorSet and pollute the event-reconstruction flow (specs/03), even
      // though the router (which queries MIRROR_SCHEMA_UID) never serves it. Sibling typed resolvers
      // (AliasResolver/ListEntryResolver/EdgeResolver) all guard their own schema; MirrorResolver must too.
      const mirrorResolverAddr = await mirrorResolver.getAddress();
      // Foreign schema: leading fields match so onAttest's abi.decode((bytes32,string)) still succeeds,
      // but the extra field makes the UID differ. Same resolver, revocable=true — so ONLY the schema
      // guard (not NotRevocable / refUID / transport checks) can reject it.
      const foreignDef = "bytes32 transportDefinition, string uri, uint256 salt";
      await (await registry.register(foreignDef, mirrorResolverAddr, true)).wait();
      const foreignSchemaUID = ethers.solidityPackedKeccak256(
        ["string", "address", "bool"],
        [foreignDef, mirrorResolverAddr, true],
      );
      expect(foreignSchemaUID).to.not.equal(mirrorSchemaUID);

      const foreignData = enc.encode(
        ["bytes32", "string", "uint256"],
        [ipfsTransportUID, "ipfs://QmForeignInjection", 0n],
      );
      await expect(
        eas.connect(owner).attest({
          schema: foreignSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: testDataUID,
            data: foreignData,
            value: 0n,
          },
        }),
      ).to.be.revertedWithCustomError(mirrorResolver, "WrongSchema");

      // Control: the canonical MIRROR schema still works.
      const realMirror = await createMirror(testDataUID, ipfsTransportUID, "ipfs://QmRealMirror");
      expect(realMirror).to.not.equal(ZERO_BYTES32);
    });

    it("should allow multiple mirrors on same DATA", async function () {
      const m1 = await createMirror(testDataUID, ipfsTransportUID, "ipfs://QmHash1");
      const m2 = await createMirror(testDataUID, arweaveTransportUID, "ar://ArHash1");
      expect(m1).to.not.equal(m2);
    });

    it("emits MirrorSet with the uri + transportDefinition (subgraph events, PR #24)", async function () {
      const ownerAddr = await owner.getAddress();
      const uri = "ipfs://QmEventTestHash";
      const tx = await eas.attest({
        schema: mirrorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: testDataUID,
          data: encodeMirror(ipfsTransportUID, uri),
          value: 0n,
        },
      });
      const mirrorUID = getUID(await tx.wait());
      await expect(tx)
        .to.emit(mirrorResolver, "MirrorSet")
        .withArgs(testDataUID, ownerAddr, ipfsTransportUID, mirrorUID, uri);
    });

    it("emits MirrorCleared on revoke (subgraph events, PR #24)", async function () {
      const ownerAddr = await owner.getAddress();
      const mirrorUID = await createMirror(testDataUID, ipfsTransportUID, "ipfs://QmEventClear");
      const tx = await eas.connect(owner).revoke({ schema: mirrorSchemaUID, data: { uid: mirrorUID, value: 0n } });
      await expect(tx)
        .to.emit(mirrorResolver, "MirrorCleared")
        .withArgs(testDataUID, ownerAddr, ipfsTransportUID, mirrorUID);
    });

    it("should reject a MIRROR with a nonzero expirationTime (HasExpiration)", async function () {
      // A MIRROR is active-until-revoked with no expiry; an expiring mirror would read as live
      // forever (reads filter on revocation, not expiry). Far-future expiry passes EAS → resolver.
      await expect(
        eas.attest({
          schema: mirrorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: 9_999_999_999n,
            revocable: true,
            refUID: testDataUID,
            data: encodeMirror(ipfsTransportUID, "ipfs://QmTestHash123"),
            value: 0n,
          },
        }),
      ).to.be.revertedWithCustomError(mirrorResolver, "HasExpiration");
    });

    it("should reject a non-revocable MIRROR (NotRevocable)", async function () {
      // A MIRROR must stay retractable (removal is via eas.revoke()). The revocable *schema* only
      // permits revocable attestations; EAS still accepts revocable=false, which the resolver rejects
      // so a dead/hostile mirror URI can't be welded on permanently.
      await expect(
        eas.attest({
          schema: mirrorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: testDataUID,
            data: encodeMirror(ipfsTransportUID, "ipfs://QmTestHash123"),
            value: 0n,
          },
        }),
      ).to.be.revertedWithCustomError(mirrorResolver, "NotRevocable");
    });

    it("should reject MIRROR without refUID", async function () {
      await expect(
        eas.attest({
          schema: mirrorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: ZERO_BYTES32,
            data: encodeMirror(ipfsTransportUID, "ipfs://QmHash"),
            value: 0n,
          },
        }),
      ).to.be.reverted;
    });

    it("should reject MIRROR referencing non-DATA attestation", async function () {
      // Try to attach mirror to an anchor (not DATA)
      await expect(
        eas.attest({
          schema: mirrorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: transportsUID, // an anchor, not DATA
            data: encodeMirror(ipfsTransportUID, "ipfs://QmHash"),
            value: 0n,
          },
        }),
      ).to.be.reverted;
    });

    it("should reject MIRROR with invalid transport definition", async function () {
      // Use a random bytes32 that's not an anchor
      const fakeTransport = ethers.keccak256(ethers.toUtf8Bytes("not-a-transport"));
      await expect(createMirror(testDataUID, fakeTransport, "fake://something")).to.be.reverted;
    });

    it("should reject MIRROR whose transport anchor is not under /transports/", async function () {
      // Create an anchor outside /transports/ tree
      const randomAnchor = await createAnchor(rootUID, "not-transports");
      await expect(createMirror(testDataUID, randomAnchor, "ipfs://QmHash")).to.be.reverted;
    });

    it("should accept MIRROR with nested transport anchor (/transports/ipfs/v2)", async function () {
      const ipfsV2 = await createAnchor(ipfsTransportUID, "v2");
      const mirrorUID = await createMirror(testDataUID, ipfsV2, "ipfs://QmNestedHash");
      expect(mirrorUID).to.not.equal(ZERO_BYTES32);
    });

    it("should accept MIRROR with an s3:// URI (widened scheme allowlist, supersedes ADR-0023)", async function () {
      // ADR-0048 MIRROR change: scheme safety is a client-render concern, not a write-time one
      // (the router never executes URIs). s3:// (and ftp://, gs://, dat://, bittorrent://) are now
      // accepted; only active-content schemes (javascript:, data:) remain rejected.
      const mirrorUID = await createMirror(testDataUID, ipfsTransportUID, "s3://my-bucket/cat.jpg");
      expect(mirrorUID).to.not.equal(ZERO_BYTES32);
    });

    it("should accept MIRROR with an ftp:// URI (widened scheme allowlist)", async function () {
      const mirrorUID = await createMirror(testDataUID, ipfsTransportUID, "ftp://ftp.example.com/cat.jpg");
      expect(mirrorUID).to.not.equal(ZERO_BYTES32);
    });

    it("should still reject MIRROR with a javascript: URI (XSS scheme stays blocked)", async function () {
      await expect(createMirror(testDataUID, ipfsTransportUID, "javascript:alert(1)")).to.be.reverted;
    });

    it("should be discoverable via getReferencingAttestations", async function () {
      await createMirror(testDataUID, ipfsTransportUID, "ipfs://QmHash1");
      await createMirror(testDataUID, arweaveTransportUID, "ar://ArHash1");

      const mirrors = await indexer.getReferencingAttestations(testDataUID, mirrorSchemaUID, 0, 10, false, false);
      expect(mirrors.length).to.equal(2);
    });
  });

  // ─── MirrorResolver upgradeable lifecycle (ADR-0048) ──────────────────────
  describe("MirrorResolver upgradeable lifecycle", function () {
    it("rejects re-initialization through the proxy", async function () {
      await expect(
        mirrorResolver.initialize(await indexer.getAddress(), await owner.getAddress()),
      ).to.be.revertedWithCustomError(mirrorResolver, "InvalidInitialization");
    });

    it("exposes the constructor EAS via getEAS() through the proxy", async function () {
      expect(await mirrorResolver.getEAS()).to.equal(await eas.getAddress());
    });

    it("reads the indexer ref from ERC-7201 config (set in initialize)", async function () {
      expect(await mirrorResolver.indexer()).to.equal(await indexer.getAddress());
    });

    it("gates setTransportsAnchor behind onlyOwner (former msg.sender==_deployer)", async function () {
      // transportsAnchorUID is already set in beforeEach; a non-owner call must revert on the
      // ownership check before reaching the one-shot guard.
      await expect(mirrorResolver.connect(alice).setTransportsAnchor(transportsUID)).to.be.revertedWithCustomError(
        mirrorResolver,
        "OwnableUnauthorizedAccount",
      );
    });

    it("keeps the one-shot guard: owner cannot re-set transportsAnchorUID", async function () {
      await expect(mirrorResolver.setTransportsAnchor(transportsUID)).to.be.revertedWith("already set");
    });
  });

  // ─── PIN-based file placement ─────────────────────────────────────────────

  describe("PIN-based file placement", function () {
    let memesUID: string;
    let catDataUID: string;

    beforeEach(async function () {
      memesUID = await createAnchor(rootUID, "memes");

      const contentHash = ethers.keccak256(ethers.toUtf8Bytes("cat picture"));
      catDataUID = await createData(contentHash, 5000n);
    });

    it("should place DATA at path via PIN", async function () {
      // ADR-0041: file placement is cardinality 1 — the active PIN at the
      // (definition=anchor, attester, schema=DATA) slot identifies the file.
      await pinAt(catDataUID, memesUID);

      const ownerAddr = await owner.getAddress();
      expect(await edgeResolver.getActivePinTarget(memesUID, ownerAddr, dataSchemaUID)).to.equal(catDataUID);
      expect(await edgeResolver.isActiveEdge(ownerAddr, catDataUID, memesUID, pinSchemaUID)).to.equal(true);
    });

    it("should remove DATA from path via PIN revocation", async function () {
      const ownerAddr = await owner.getAddress();
      await pinAt(catDataUID, memesUID);
      expect(await edgeResolver.getActivePinTarget(memesUID, ownerAddr, dataSchemaUID)).to.equal(catDataUID);

      // Removal under ADR-0041 is always EAS revoke — there is no `applies=false`
      await unpinAt(catDataUID, memesUID);

      expect(await edgeResolver.getActivePinTarget(memesUID, ownerAddr, dataSchemaUID)).to.equal(ZERO_BYTES32);
      expect(await edgeResolver.isActiveEdge(ownerAddr, catDataUID, memesUID, pinSchemaUID)).to.equal(false);
    });

    it("should handle re-pin after revoke: slot reads correctly through pin → revoke → pin", async function () {
      const ownerAddr = await owner.getAddress();

      // Initial: empty slot
      expect(await edgeResolver.getActivePinTarget(memesUID, ownerAddr, dataSchemaUID)).to.equal(ZERO_BYTES32);
      expect(await edgeResolver.hasActiveEdge(catDataUID, memesUID)).to.equal(false);

      // Pin
      await pinAt(catDataUID, memesUID);
      expect(await edgeResolver.getActivePinTarget(memesUID, ownerAddr, dataSchemaUID)).to.equal(catDataUID);
      expect(await edgeResolver.hasActiveEdge(catDataUID, memesUID)).to.equal(true);

      // Revoke
      await unpinAt(catDataUID, memesUID);
      expect(await edgeResolver.getActivePinTarget(memesUID, ownerAddr, dataSchemaUID)).to.equal(ZERO_BYTES32);
      expect(await edgeResolver.hasActiveEdge(catDataUID, memesUID)).to.equal(false);

      // Re-pin: DATA must reappear in the slot
      await pinAt(catDataUID, memesUID);
      expect(await edgeResolver.getActivePinTarget(memesUID, ownerAddr, dataSchemaUID)).to.equal(catDataUID);
      expect(await edgeResolver.hasActiveEdge(catDataUID, memesUID)).to.equal(true);
    });

    it("should support same DATA at multiple paths (one PIN per slot)", async function () {
      const animalsUID = await createAnchor(rootUID, "animals");
      const ownerAddr = await owner.getAddress();

      await pinAt(catDataUID, memesUID);
      await pinAt(catDataUID, animalsUID);

      expect(await edgeResolver.getActivePinTarget(memesUID, ownerAddr, dataSchemaUID)).to.equal(catDataUID);
      expect(await edgeResolver.getActivePinTarget(animalsUID, ownerAddr, dataSchemaUID)).to.equal(catDataUID);
    });

    it("should support multiple DATAs at same path by different attesters", async function () {
      const aliceAddr = await alice.getAddress();
      const bobAddr = await bob.getAddress();

      // Alice and Bob each create their own DATA and pin it at /memes/.
      // PIN cardinality 1 is per-attester — each gets their own slot.
      const aliceHash = ethers.keccak256(ethers.toUtf8Bytes("alice cat"));
      const aliceData = await createData(aliceHash, 100n, alice);
      await pinAt(aliceData, memesUID, alice);

      const bobHash = ethers.keccak256(ethers.toUtf8Bytes("bob cat"));
      const bobData = await createData(bobHash, 200n, bob);
      await pinAt(bobData, memesUID, bob);

      expect(await edgeResolver.getActivePinTarget(memesUID, aliceAddr, dataSchemaUID)).to.equal(aliceData);
      expect(await edgeResolver.getActivePinTarget(memesUID, bobAddr, dataSchemaUID)).to.equal(bobData);
    });

    it("should propagate containsAttestations up the tree", async function () {
      const aliceAddr = await alice.getAddress();

      // Create /memes/funny/
      const funnyUID = await createAnchor(memesUID, "funny");

      // Alice pins DATA at /memes/funny/
      const hash = ethers.keccak256(ethers.toUtf8Bytes("funny cat"));
      const dataUID = await createData(hash, 100n, alice);
      await pinAt(dataUID, funnyUID, alice);

      // containsAttestations should propagate to /memes/funny/, /memes/, and root
      expect(await indexer.containsAttestations(funnyUID, aliceAddr)).to.equal(true);
      expect(await indexer.containsAttestations(memesUID, aliceAddr)).to.equal(true);
      expect(await indexer.containsAttestations(rootUID, aliceAddr)).to.equal(true);
    });
  });

  // ─── MAX_ANCHOR_DEPTH Tests ───────────────────────────────────────────────

  describe("MAX_ANCHOR_DEPTH", function () {
    it("should enforce maximum anchor depth", async function () {
      let parent = rootUID;
      // Create a chain of 32 levels (root + 32 = 33 total, but root doesn't count as depth)
      for (let i = 0; i < 32; i++) {
        parent = await createAnchor(parent, `level${i}`);
      }

      // 33rd level should fail
      await expect(createAnchor(parent, "too-deep")).to.be.revertedWithCustomError(indexer, "AnchorTooDeep");
    });
  });

  // ─── EFSFileView Integration Tests ────────────────────────────────────────

  describe("EFSFileView.getFilesAtPath", function () {
    it("should return DATAs pinned at a path", async function () {
      const memesUID = await createAnchor(rootUID, "memes-view");
      const contentHash = ethers.keccak256(ethers.toUtf8Bytes("view test"));
      const dataUID = await createData(contentHash, 42n);
      await pinAt(dataUID, memesUID);

      const ownerAddr = await owner.getAddress();
      const { items } = await fileView.getFilesAtPath(memesUID, [ownerAddr], dataSchemaUID, "0x", 10);

      expect(items.length).to.equal(1);
      expect(items[0].uid).to.equal(dataUID);
      // DATA is empty (ADR-0049); contentHash is no longer an inline DATA field, so the
      // listing surfaces bytes32(0). Surfacing the hash PROPERTY is future property-index work.
      expect(items[0].contentHash).to.equal(ZERO_BYTES32);
      expect(items[0].hasData).to.equal(true);
    });
  });

  describe("EFSFileView.getDataMirrors", function () {
    it("should return mirrors for a DATA", async function () {
      const contentHash = ethers.keccak256(ethers.toUtf8Bytes("mirror test"));
      const dataUID = await createData(contentHash, 100n);
      await createMirror(dataUID, ipfsTransportUID, "ipfs://QmTest");

      const mirrors = await fileView.getDataMirrors(dataUID, 0, 10);
      expect(mirrors.length).to.equal(1);
      expect(mirrors[0].uri).to.equal("ipfs://QmTest");
      expect(mirrors[0].transportDefinition).to.equal(ipfsTransportUID);
    });
  });

  describe("EFSFileView.getCanonicalData", function () {
    it("getCanonicalData is a deprecated no-op returning bytes32(0) (ADR-0049)", async function () {
      // DATA is empty/pure-identity; there is no intrinsic content-hash index. Canonical/dedup
      // resolution moves to the property index + REDIRECT primitive (ADR-0050) — future work.
      const contentHash = ethers.keccak256(ethers.toUtf8Bytes("canonical test"));
      await createData(contentHash, 50n);

      expect(await fileView.getCanonicalData(contentHash)).to.equal(ZERO_BYTES32);
    });
  });

  // ─── Full Upload Flow (atomic) ────────────────────────────────────────────

  describe("Full upload flow", function () {
    it("should create DATA + PROPERTY + MIRROR + PIN in sequence", async function () {
      // Create file anchor path
      const docsUID = await createAnchor(rootUID, "docs");

      // 1. Create DATA
      const contentHash = ethers.keccak256(ethers.toUtf8Bytes("# Hello World\n"));
      const dataUID = await createData(contentHash, 15n);

      // 2. Attach PROPERTY (contentType) — bound via PIN under the key anchor
      await createProperty(dataUID, "contentType", "text/markdown");

      // 3. Create MIRROR (onchain retrieval)
      await createMirror(dataUID, onchainTransportUID, "web3://0x1234567890123456789012345678901234567890");

      // 4. PIN to place at /docs/ (file placement is cardinality 1)
      await pinAt(dataUID, docsUID);

      // Verify: DATA at /docs/ via PIN read
      const ownerAddr = await owner.getAddress();
      expect(await edgeResolver.getActivePinTarget(docsUID, ownerAddr, dataSchemaUID)).to.equal(dataUID);

      // Verify: mirrors on DATA
      const mirrors = await indexer.getReferencingAttestations(dataUID, mirrorSchemaUID, 0, 10, false, false);
      expect(mirrors.length).to.equal(1);

      // AGENT-NOTE: dropped the dedup assertion (`dataByContentKey`) — DATA is empty (ADR-0049)
      // and carries no contentHash; dedup is now property-index + REDIRECT work (ADR-0050).
    });
  });
});
