import { expect } from "chai";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { ethers } from "hardhat";
import { EFSIndexer, EAS, SchemaRegistry } from "../typechain-types";
import { Signer, ZeroAddress } from "ethers";
import { deployIndexerProxy } from "./helpers/deployIndexerProxy";

// Constants
const NO_EXPIRATION = 0n;
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

describe("EFSIndexer", function () {
  let indexer: EFSIndexer;
  let eas: EAS;
  let registry: SchemaRegistry;
  let owner: Signer;
  let user1: Signer;
  let user2: Signer;

  let anchorSchemaUID: string;
  let propertySchemaUID: string;
  let dataSchemaUID: string;
  let blobSchemaUID: string;
  let tagSchemaUID: string;
  // let likeSchemaUID: string; // For generic indexing tests (Unused)
  // let commentSchemaUID: string; // For generic indexing tests (Unused)

  before(async function () {
    [owner, user1, user2] = await ethers.getSigners();
  });

  beforeEach(async function () {
    // 1. Deploy SchemaRegistry and EAS
    const RegistryFactory = await ethers.getContractFactory("SchemaRegistry");
    registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();

    const EASFactory = await ethers.getContractFactory("EAS");
    eas = await EASFactory.deploy(await registry.getAddress());
    await eas.waitForDeployment();

    // Determine future address of Indexer to register schemas with it first.
    // This resolves the circular dependency where schemas need a resolver address,
    // but the resolver (Indexer) needs schema UIDs in its constructor.

    const ownerAddr = await owner.getAddress();
    const nonce = await ethers.provider.getTransactionCount(ownerAddr);
    // Calculate the future address of the Indexer using the owner's nonce.
    // The Indexer is deployed after SchemaRegistry registration transactions.
    // The PROXY is the resolver baked into the schema UIDs (ADR-0048). It is deployed after the
    // 7 schema registrations AND after the EFSIndexer implementation, so it lands at nonce+8
    // (impl = nonce+7, proxy = nonce+8). See deployIndexerProxy().
    const futureIndexerAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: nonce + 8 });

    // Register Schemas with the future resolver address
    // ANCHOR: string name, bytes32 forSchema
    const tx1 = await registry.register("string name, bytes32 forSchema", futureIndexerAddr, true);
    const rc1 = await tx1.wait();
    anchorSchemaUID = rc1!.logs[0].topics[1]; // Registered(bytes32 uid, ...)

    // PROPERTY: string value (unified free-floating model per ADR-0035, non-revocable)
    const tx2 = await registry.register("string value", futureIndexerAddr, false);
    const rc2 = await tx2.wait();
    propertySchemaUID = rc2!.logs[0].topics[1];

    // DATA: empty schema — pure identity (ADR-0049). No fields; payload is zero-length.
    const tx3 = await registry.register("", futureIndexerAddr, false);
    const rc3 = await tx3.wait();
    dataSchemaUID = rc3!.logs[0].topics[1];

    // BLOB: string mimeType, uint8 storageType, bytes location
    // Register BLOB schema with no resolver (resolver = ZeroAddress) as it holds raw data.
    const tx4 = await registry.register("string mimeType, uint8 storageType, bytes location", ZeroAddress, true); // No resolver
    const rc4 = await tx4.wait();
    blobSchemaUID = rc4!.logs[0].topics[1];

    // TAG: bytes32 labelUID, int256 weight (Changed from bool isNegative)
    const tx5 = await registry.register("bytes32 labelUID, int256 weight", futureIndexerAddr, true);
    const rc5 = await tx5.wait();
    tagSchemaUID = rc5!.logs[0].topics[1];

    // LIKE: bytes32 targetUID
    const tx6 = await registry.register("bytes32 targetUID", futureIndexerAddr, true);
    await tx6.wait();
    // likeSchemaUID = rc6!.logs[0].topics[1];

    // COMMENT: bytes32 targetUID, string comment
    const tx7 = await registry.register("bytes32 targetUID, string comment", futureIndexerAddr, true);
    await tx7.wait();
    // commentSchemaUID = rc7!.logs[0].topics[1];

    // 3. Deploy Indexer
    // Note: PIN and TAG schemas are now handled by the separate EdgeResolver contract (ADR-0041),
    // not EFSIndexer. tagSchemaUID is still registered (with futureIndexerAddr as resolver) in tests
    // so that generic referencing tests still exercise the indexer's _allReferencing /
    // _referencingBySchema maps.
    indexer = await deployIndexerProxy(
      await eas.getAddress(),
      anchorSchemaUID,
      propertySchemaUID,
      dataSchemaUID,
      owner,
    );

    expect(await indexer.getAddress()).to.equal(futureIndexerAddr);
  });

  const getUIDFromReceipt = (receipt: any) => {
    const easInterface = eas.interface;
    for (const log of receipt.logs) {
      try {
        const parsed = easInterface.parseLog(log);
        if (parsed && parsed.name === "Attested") {
          return parsed.args.uid;
        }
      } catch {
        // ignore
      }
    }
    throw new Error("Attested event not found");
  };

  describe("wireContracts re-entry guard", function () {
    it("Should revert if wireContracts is called a second time", async function () {
      // EFSIndexer.wireContracts is guarded by `require(edgeResolver == address(0), "EFSIndexer: already wired")`.
      // Calling it twice must revert — this prevents a second caller from swapping edgeResolver,
      // PIN_SCHEMA_UID, or TAG_SCHEMA_UID mid-lifetime.
      // (No wireContracts is called in this test's beforeEach, so we call it twice here.)
      // Use a dummy non-zero address so the guard's `edgeResolver == address(0)` check
      // flips to false after the first call (passing ZeroAddress would leave the slot
      // unchanged and both calls would pass).
      const dummy = await owner.getAddress();

      await expect(
        indexer.wireContracts(
          dummy,
          ZERO_BYTES32,
          ZERO_BYTES32,
          ethers.ZeroAddress,
          ZERO_BYTES32,
          ethers.ZeroAddress,
          ZERO_BYTES32,
          ethers.ZeroAddress,
        ),
      ).to.not.be.reverted; // first call succeeds

      await expect(
        indexer.wireContracts(
          dummy,
          ZERO_BYTES32,
          ZERO_BYTES32,
          ethers.ZeroAddress,
          ZERO_BYTES32,
          ethers.ZeroAddress,
          ZERO_BYTES32,
          ethers.ZeroAddress,
        ),
      ).to.be.revertedWith("EFSIndexer: already wired");
    });
  });

  describe("Upgradeable proxy (ADR-0048)", function () {
    it("exposes the constructor EAS via getEAS() through the proxy", async function () {
      // getEAS() is inherited from EFSUpgradeableResolver and reads the impl's constructor
      // immutable; it must resolve correctly under the proxy's delegatecall.
      expect(await indexer.getEAS()).to.equal(await eas.getAddress());
    });

    it("initializes config + owner once and reverts on a second initialize()", async function () {
      // The proxy was already initialized in beforeEach. Config getters read ERC-7201 storage.
      expect(await indexer.ANCHOR_SCHEMA_UID()).to.equal(anchorSchemaUID);
      expect(await indexer.PROPERTY_SCHEMA_UID()).to.equal(propertySchemaUID);
      expect(await indexer.DATA_SCHEMA_UID()).to.equal(dataSchemaUID);
      expect(await indexer.owner()).to.equal(await owner.getAddress());
      // DEPLOYER() is preserved as an owner()-backed alias for ABI/consumer compatibility.
      expect(await indexer.DEPLOYER()).to.equal(await owner.getAddress());

      // A second initialize() must revert (OZ Initializable one-shot guard).
      await expect(
        indexer.initialize(anchorSchemaUID, propertySchemaUID, dataSchemaUID, await owner.getAddress()),
      ).to.be.revertedWithCustomError(indexer, "InvalidInitialization");
    });

    it("indexes an ANCHOR identically through the proxy (attest → resolvePath)", async function () {
      // The core kernel path must behave identically through the proxy: an ANCHOR attestation
      // routes through onAttest (delegatecall) and writes the directory index in proxy storage.
      const data = new ethers.AbiCoder().encode(["string", "bytes32"], ["root", ZERO_BYTES32]);
      const tx = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data,
          value: 0n,
        },
      });
      const uid = getUIDFromReceipt(await tx.wait());

      // rootAnchorUID + the name→anchor directory index were written to PROXY storage.
      expect(await indexer.rootAnchorUID()).to.equal(uid);
      expect(await indexer.resolvePath(ZERO_BYTES32, "root")).to.equal(uid);
    });

    it("gates wireContracts() and setSortsAnchor() on the owner", async function () {
      // user1 is not the owner → onlyOwner reverts (OZ OwnableUnauthorizedAccount).
      await expect(indexer.connect(user1).setSortsAnchor(ZERO_BYTES32)).to.be.revertedWithCustomError(
        indexer,
        "OwnableUnauthorizedAccount",
      );
      await expect(
        indexer
          .connect(user1)
          .wireContracts(
            await user1.getAddress(),
            ZERO_BYTES32,
            ZERO_BYTES32,
            ethers.ZeroAddress,
            ZERO_BYTES32,
            ethers.ZeroAddress,
            ZERO_BYTES32,
            ethers.ZeroAddress,
          ),
      ).to.be.revertedWithCustomError(indexer, "OwnableUnauthorizedAccount");
    });
  });

  describe("Enforcement (Anchor)", function () {
    // ... (Existing tests) ...

    it("should allow creating a root anchor (First Anchor)", async function () {
      // ... (Existing logic) ...
      const schemaEncoder = new ethers.AbiCoder();
      const data = schemaEncoder.encode(["string", "bytes32"], ["root", ZERO_BYTES32]);
      const tx = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: data,
          value: 0n,
        },
      });
      const receipt = await tx.wait();

      // Verify Indexer State
      // Note: TypeScript might not see 'rootAnchorUID' yet if typechain isn't recompiled
      // We cast to any to bypass valid compile error until recompile happens
      const rootUID = await (indexer as any).rootAnchorUID();
      const attestedUID = getUIDFromReceipt(receipt);
      expect(rootUID).to.equal(attestedUID);
    });

    it("Should fail if creating second root anchor", async function () {
      const schemaEncoder = new ethers.AbiCoder();

      // 1. Create First Root (Should Succeed)
      const data1 = schemaEncoder.encode(["string", "bytes32"], ["root1", ZERO_BYTES32]);
      await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: data1,
          value: 0n,
        },
      });

      // 2. Try to create Second Root (Should ensure parentUID is checked properly)
      // Note: New logic allows multiple roots if they have internal validation? NO.
      // Logic: if rootAnchorUID != 0, and parent == 0, and uid != rootAnchorUID -> MissingParent.
      // So this test should still pass (revert).

      const data2 = schemaEncoder.encode(["string", "bytes32"], ["root2", ZERO_BYTES32]);
      await expect(
        eas.attest({
          schema: anchorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: ZERO_BYTES32,
            data: data2,
            value: 0n,
          },
        }),
      ).to.be.revertedWithCustomError(indexer, "MissingParent");
    });

    it("should Revert when creating duplicate filename in same directory", async function () {
      const schemaEncoder = new ethers.AbiCoder();

      // 1. Create Root
      const rootData = schemaEncoder.encode(["string", "bytes32"], ["root", ZERO_BYTES32]);
      const rootTx = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: rootData,
          value: 0n,
        },
      });
      const rootReceipt = await rootTx.wait();
      const rootUID = getUIDFromReceipt(rootReceipt);

      // 2. Create "config.json" in Root (Generic Anchor)
      const data = schemaEncoder.encode(["string", "bytes32"], ["config.json", ZERO_BYTES32]);
      await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: rootUID,
          data: data,
          value: 0n,
        },
      });

      // 3. Attempt Duplicate "config.json" in Root
      await expect(
        eas.attest({
          schema: anchorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: rootUID,
            data: data,
            value: 0n,
          },
        }),
      ).to.be.revertedWithCustomError(indexer, "DuplicateFileName");
    });
  });

  describe("Enforcement (Relationships)", function () {
    it("Should accept standalone DATA with refUID=0x0 and non-revocable", async function () {
      // DATA is an empty schema (ADR-0049) — zero-length payload.
      const tx = await eas.attest({
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
      const receipt = await tx.wait();
      const uid = getUIDFromReceipt(receipt);
      expect(uid).to.not.equal(ZERO_BYTES32);
    });

    it("Should accept and index empty (zero-length) DATA — pure identity (ADR-0049)", async function () {
      // DATA is now an empty schema. A DATA attestation carries no fields; its payload is
      // zero-length. The indexer must accept it (no abi.decode) and track its UID.
      const tx = await eas.attest({
        schema: dataSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: "0x", // zero-length payload
          value: 0n,
        },
      });
      const uid = getUIDFromReceipt(await tx.wait());
      expect(uid).to.not.equal(ZERO_BYTES32);

      // Indexed in the global schema index (resolves / is tracked).
      const atts = await indexer.getAttestationsBySchema(dataSchemaUID, 0, 10, false, false);
      expect(atts).to.include(uid);
    });

    it("Should reject DATA with non-zero refUID", async function () {
      // Create an anchor first
      const schemaEncoder = new ethers.AbiCoder();
      const rootData = schemaEncoder.encode(["string", "bytes32"], ["root", ZERO_BYTES32]);
      const rootTx = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: rootData,
          value: 0n,
        },
      });
      const rootUID = getUIDFromReceipt(await rootTx.wait());

      await expect(
        eas.attest({
          schema: dataSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: rootUID, // Must be 0x0 for standalone DATA
            data: "0x",
            value: 0n,
          },
        }),
      ).to.be.revertedWithCustomError(eas, "InvalidAttestation");
    });

    it("Should reject DATA with a non-empty payload (empty-identity invariant, ADR-0049)", async function () {
      // EAS does not enforce the registered schema's ABI on attestation.data — it stores
      // whatever bytes are passed. The resolver must reject any non-zero-length DATA payload
      // so arbitrary bytes can't be smuggled in and served as valid pure-identity DATA.
      const schemaEncoder = new ethers.AbiCoder();
      await expect(
        eas.attest({
          schema: dataSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: ZERO_BYTES32,
            data: schemaEncoder.encode(["string"], ["smuggled"]), // non-empty — must be rejected
            value: 0n,
          },
        }),
      ).to.be.revertedWithCustomError(eas, "InvalidAttestation");
    });

    it("Should reject revocable PROPERTY (schema is non-revocable per ADR-0035)", async function () {
      const schemaEncoder = new ethers.AbiCoder();
      await expect(
        eas.attest({
          schema: propertySchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: ZERO_BYTES32,
            data: schemaEncoder.encode(["string"], ["val"]),
            value: 0n,
          },
        }),
      ).to.be.revertedWithCustomError(eas, "Irrevocable");
    });

    it("Should emit PropertyCreated with valueHash = keccak256(bytes(value)) (ADR-0052 dedup key)", async function () {
      // ADR-0052: the PropertyCreated valueHash topic is the value's canonical content key —
      // the lookup key clients use to find an existing value to dedup against. It is
      // keccak256 of the UTF-8 value bytes, computed from the decoded `string value` field.
      const schemaEncoder = new ethers.AbiCoder();
      const value = "image/png";
      const expectedValueHash = ethers.keccak256(ethers.toUtf8Bytes(value));
      const attesterAddr = await owner.getAddress();
      await expect(
        eas.attest({
          schema: propertySchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: ZERO_BYTES32,
            data: schemaEncoder.encode(["string"], [value]),
            value: 0n,
          },
        }),
      )
        .to.emit(indexer, "PropertyCreated")
        .withArgs(anyValue, attesterAddr, expectedValueHash);
    });

    it("Should reject PROPERTY with non-zero refUID (must be free-floating per ADR-0035)", async function () {
      const schemaEncoder = new ethers.AbiCoder();
      const rootTx = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: schemaEncoder.encode(["string", "bytes32"], ["root", ZERO_BYTES32]),
          value: 0n,
        },
      });
      const rootUID = getUIDFromReceipt(await rootTx.wait());

      await expect(
        eas.attest({
          schema: propertySchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: rootUID, // Must be 0x0 for standalone PROPERTY
            data: schemaEncoder.encode(["string"], ["val"]),
            value: 0n,
          },
        }),
      ).to.be.revertedWithCustomError(eas, "InvalidAttestation");
    });
  });

  describe("Canonical anchor-name encoding (NFC + percent-encode)", function () {
    // The on-chain anchor `name` is the canonical encoding of a human name:
    // client-side NFC normalization (not verifiable on-chain), then percent-encoding
    // of the reserved byte set with UPPERCASE hex. The resolver enforces the
    // byte-level canonical form so there is exactly ONE valid representation per name.
    const enc = new ethers.AbiCoder();

    const attestRootAnchor = (name: string) =>
      eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: enc.encode(["string", "bytes32"], [name, ZERO_BYTES32]),
          value: 0n,
        },
      });

    it('accepts the canonical encoding of "Q&A: Episode 5" and round-trips', async function () {
      // NFC("Q&A: Episode 5") percent-encoded = Q%26A%3A%20Episode%205
      const canonical = "Q%26A%3A%20Episode%205";
      const tx = await attestRootAnchor(canonical);
      const uid = getUIDFromReceipt(await tx.wait());
      // Round-trips: the stored anchor name resolves back to the same UID byte-for-byte.
      expect(await indexer.resolvePath(ZERO_BYTES32, canonical)).to.equal(uid);
    });

    it("accepts a normal simple name (readme.txt)", async function () {
      const tx = await attestRootAnchor("readme.txt");
      const uid = getUIDFromReceipt(await tx.wait());
      expect(await indexer.resolvePath(ZERO_BYTES32, "readme.txt")).to.equal(uid);
    });

    it("rejects a bare reserved byte (literal space)", async function () {
      await expect(attestRootAnchor("Episode 5")).to.be.revertedWithCustomError(indexer, "InvalidAnchorName");
    });

    it("rejects a bare reserved byte (literal &)", async function () {
      await expect(attestRootAnchor("Q&A")).to.be.revertedWithCustomError(indexer, "InvalidAnchorName");
    });

    it("rejects a truncated escape (%2)", async function () {
      await expect(attestRootAnchor("a%2")).to.be.revertedWithCustomError(indexer, "InvalidAnchorName");
    });

    it("rejects a malformed escape (%ZZ)", async function () {
      await expect(attestRootAnchor("a%ZZ")).to.be.revertedWithCustomError(indexer, "InvalidAnchorName");
    });

    it("rejects a lowercase-hex escape (%2f) as non-canonical", async function () {
      await expect(attestRootAnchor("a%2fb")).to.be.revertedWithCustomError(indexer, "InvalidAnchorName");
    });

    it("accepts an uppercase-hex escape (%2F)", async function () {
      const tx = await attestRootAnchor("a%2Fb");
      const uid = getUIDFromReceipt(await tx.wait());
      expect(await indexer.resolvePath(ZERO_BYTES32, "a%2Fb")).to.equal(uid);
    });

    it("accepts a single bare letter (A)", async function () {
      const tx = await attestRootAnchor("A");
      const uid = getUIDFromReceipt(await tx.wait());
      expect(await indexer.resolvePath(ZERO_BYTES32, "A")).to.equal(uid);
    });

    it("accepts a space escape (%20)", async function () {
      const tx = await attestRootAnchor("Episode%205");
      const uid = getUIDFromReceipt(await tx.wait());
      expect(await indexer.resolvePath(ZERO_BYTES32, "Episode%205")).to.equal(uid);
    });

    it("accepts a literal-percent escape (%25)", async function () {
      const tx = await attestRootAnchor("100%25");
      const uid = getUIDFromReceipt(await tx.wait());
      expect(await indexer.resolvePath(ZERO_BYTES32, "100%25")).to.equal(uid);
    });

    it("accepts high-bit UTF-8 pass-through (café as caf%C3%A9 — reserved escape, raw UTF-8 bytes)", async function () {
      // café NFC-encoded: the é is the two UTF-8 bytes 0xC3 0xA9; neither is reserved so both
      // pass through bare. A reserved byte (e.g. %20) elsewhere is the canonical escape.
      const name = "café%20edition"; // "café edition" → café raw UTF-8 + %20 for the space
      const tx = await attestRootAnchor(name);
      const uid = getUIDFromReceipt(await tx.wait());
      expect(await indexer.resolvePath(ZERO_BYTES32, name)).to.equal(uid);
    });

    it("rejects a non-canonical escape of an unreserved letter (%41 ≡ A)", async function () {
      await expect(attestRootAnchor("%41")).to.be.revertedWithCustomError(indexer, "InvalidAnchorName");
    });

    it("rejects a non-canonical escape of a dot (readme%2Etxt ≡ readme.txt)", async function () {
      await expect(attestRootAnchor("readme%2Etxt")).to.be.revertedWithCustomError(indexer, "InvalidAnchorName");
    });

    it("rejects a non-canonical escape of a bare dot (%2E)", async function () {
      await expect(attestRootAnchor("%2E")).to.be.revertedWithCustomError(indexer, "InvalidAnchorName");
    });

    it("rejects a non-canonical escape of dot-dot (%2E%2E)", async function () {
      await expect(attestRootAnchor("%2E%2E")).to.be.revertedWithCustomError(indexer, "InvalidAnchorName");
    });

    it("rejects a bare slash (/)", async function () {
      await expect(attestRootAnchor("a/b")).to.be.revertedWithCustomError(indexer, "InvalidAnchorName");
    });

    it('rejects the relative segment "."', async function () {
      await expect(attestRootAnchor(".")).to.be.revertedWithCustomError(indexer, "InvalidAnchorName");
    });

    it('rejects the relative segment ".."', async function () {
      await expect(attestRootAnchor("..")).to.be.revertedWithCustomError(indexer, "InvalidAnchorName");
    });
  });

  describe("Path Resolution", function () {
    it("Should resolve root paths", async function () {
      const schemaEncoder = new ethers.AbiCoder();
      const tx = await eas.connect(user1).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: schemaEncoder.encode(["string", "bytes32"], ["test_file", ZERO_BYTES32]),
          value: 0n,
        },
      });
      const receipt = await tx.wait();
      const uid = await getUIDFromReceipt(receipt);

      expect(await indexer.resolvePath(ZERO_BYTES32, "test_file")).to.equal(uid);
    });

    it("should resolve nested paths", async function () {
      const schemaEncoder = new ethers.AbiCoder();

      // /home
      const tx1 = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: schemaEncoder.encode(["string", "bytes32"], ["home", ZERO_BYTES32]),
          value: 0n,
        },
      });
      const receipt1 = await tx1.wait();
      // We need the UID. In tests we can compute it or get from event.
      // EAS emits Attested(bytes32 indexed uid, ...)
      // But `attest` function returns transaction.
      // Hardhat-EAS helpers usually return UID string but I'm calling raw contract.
      // Let's parse logs.
      const homeUID = getUIDFromReceipt(receipt1); // Attested event
      // Better: compute UID vs fetch from indexer resolvePath.
      // Here we use indexer to resolve the path and verify it matches the latest attestation.
      const resolvedHome = await indexer.resolvePath(ZERO_BYTES32, "home");
      expect(resolvedHome).to.equal(homeUID);

      // /home/user
      const tx2 = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: homeUID,
          data: schemaEncoder.encode(["string", "bytes32"], ["user", ZERO_BYTES32]),
          value: 0n,
        },
      });
      await tx2.wait();
      // Verify that the retrieved UID matches the one from resolution logic
      // Note: EAS `attest` call returns a receipt, but parsing logs depends on which contract emitted events.
      // We use getUIDFromReceipt to extract the UID from the EAS 'Attested' event.

      const userUID = await indexer.resolvePath(homeUID, "user");
      expect(userUID).to.not.equal(ZERO_BYTES32);

      // /home/user/docs
      await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: userUID,
          data: schemaEncoder.encode(["string", "bytes32"], ["docs", ZERO_BYTES32]),
          value: 0n,
        },
      });

      const docsUID = await indexer.resolvePath(userUID, "docs");
      expect(docsUID).to.not.equal(ZERO_BYTES32);
    });
  });

  describe("Hierarchy & Pagination", function () {
    let parentUID: string;
    let child1UID: string;
    let child2UID: string;
    let child3UID: string;
    const schemaEncoder = new ethers.AbiCoder();

    beforeEach(async function () {
      // Create Parent
      const txParent = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: schemaEncoder.encode(["string", "bytes32"], ["parent", ZERO_BYTES32]),
          value: 0n,
        },
      });
      const receiptParent = await txParent.wait();
      parentUID = getUIDFromReceipt(receiptParent);

      // Create 3 children
      const createChild = async (name: string) => {
        const tx = await eas.attest({
          schema: anchorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: parentUID,
            data: schemaEncoder.encode(["string", "bytes32"], [name, ZERO_BYTES32]),
            value: 0n,
          },
        });
        const receipt = await tx.wait();
        return getUIDFromReceipt(receipt);
      };

      child1UID = await createChild("child1");
      child2UID = await createChild("child2");
      child3UID = await createChild("child3");
    });

    it("Should paginate children (Forward)", async function () {
      // Updated signature: getChildren(uid, start, length, reverse, showRevoked)
      const page1 = await indexer.getChildren(parentUID, 0, 2, false, false);
      expect(page1.length).to.equal(2);
      expect(page1[0]).to.equal(child1UID);
      expect(page1[1]).to.equal(child2UID);

      const page2 = await indexer.getChildren(parentUID, 2, 2, false, false);
      expect(page2.length).to.equal(1);
      expect(page2[0]).to.equal(child3UID);

      const count = await indexer.getChildrenCount(parentUID);
      expect(count).to.equal(3);
    });

    it("Should paginate children (Reverse)", async function () {
      // Updated signature: getChildren(uid, start, length, reverse, showRevoked)
      // Reverse: start 0 means "latest"
      const page1 = await indexer.getChildren(parentUID, 0, 2, true, false);
      expect(page1.length).to.equal(2);
      expect(page1[0]).to.equal(child3UID); // Last added is first
      expect(page1[1]).to.equal(child2UID);
    });
  });

  describe("Filtering & MimeTypes", function () {
    let parentUID: string;
    // let dataUID: string;
    let userFileUID: string;
    let user2FileUID: string;
    let _fileUID: string;
    const schemaEncoder = new ethers.AbiCoder();

    beforeEach(async function () {
      // 1. Create Parent "files"
      const txParent = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: schemaEncoder.encode(["string", "bytes32"], ["files", ZERO_BYTES32]),
          value: 0n,
        },
      });
      const receiptParent = await txParent.wait();
      parentUID = getUIDFromReceipt(receiptParent);

      // 2. Create BLOB (video/mp4)
      const blobTx = await eas.attest({
        schema: blobSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: ZERO_BYTES32,
          data: schemaEncoder.encode(["string", "uint8", "bytes"], ["video/mp4", 0, "0x1234"]),
          value: 0n,
        },
      });
      await blobTx.wait();

      // 3. Create Anchor "my_video.mp4" inside "files"
      const txFile = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: parentUID,
          // Create as Data Anchor!
          data: schemaEncoder.encode(["string", "bytes32"], ["my_video.mp4", dataSchemaUID]),
          value: 0n,
        },
      });
      const rcFile = await txFile.wait();
      _fileUID = getUIDFromReceipt(rcFile);

      // 4. Create standalone DATA (empty schema, ADR-0049: refUID=0x0, non-revocable)
      const dataTx = await eas.attest({
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
      await dataTx.wait();

      // Setup for Attester Filter
      // User A creates file "user1.txt" in "files"
      const txUser1File = await eas.connect(user1).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: parentUID,
          data: schemaEncoder.encode(["string", "bytes32"], ["user1.txt", ZERO_BYTES32]),
          value: 0n,
        },
      });
      const receiptUser1File = await txUser1File.wait();
      userFileUID = getUIDFromReceipt(receiptUser1File);

      // User B creates file "user2.txt" in "files"
      const txUser2File = await eas.connect(user2).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: parentUID,
          data: schemaEncoder.encode(["string", "bytes32"], ["user2.txt", ZERO_BYTES32]),
          value: 0n,
        },
      });
      const receiptUser2File = await txUser2File.wait();
      user2FileUID = getUIDFromReceipt(receiptUser2File);
    });

    it("Should filter by Attester", async function () {
      // Filter children of "files" by User A
      const u1Files = await indexer.getChildrenByAttester(
        parentUID,
        await user1.getAddress(),
        0,
        10,
        false,
        false,
      );
      expect(u1Files.length).to.equal(1);
      expect(u1Files[0]).to.equal(userFileUID);

      // Filter children of "files" by User B
      const u2Files = await indexer.getChildrenByAttester(
        parentUID,
        await user2.getAddress(),
        0,
        10,
        false,
        false,
      );
      expect(u2Files.length).to.equal(1);
      expect(u2Files[0]).to.equal(user2FileUID);
    });
  });

  describe("Revocation", function () {
    it("should PREVENT revocation of Anchors", async function () {
      const schemaEncoder = new ethers.AbiCoder();
      // Create "temp.txt"
      const tx = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false, // Schema is now irrevocable
          refUID: ZERO_BYTES32,
          data: schemaEncoder.encode(["string", "bytes32"], ["temp.txt", ZERO_BYTES32]),
          value: 0n,
        },
      });
      const receipt = await tx.wait();
      const uid = getUIDFromReceipt(receipt); // Attested UID

      expect(await indexer.resolvePath(ZERO_BYTES32, "temp.txt")).to.equal(uid);

      // 2. Try Revoke - Should Revert because Schema is irrevocable (checked by EAS)
      // EAS logic: if schema.revocable is false, revoke() reverts with Irrevocable()
      await expect(
        eas.revoke({
          schema: anchorSchemaUID,
          data: {
            uid: uid,
            value: 0n,
          },
        }),
      ).to.be.revertedWithCustomError(eas, "Irrevocable");
    });
  });

  describe("Kernel Keep-Forever & _isRevoked Filtering", function () {
    const schemaEncoder = new ethers.AbiCoder();
    let parentUID: string;
    let _child1UID: string;
    let _child2UID: string;
    let dataUID1: string;

    beforeEach(async function () {
      // Create root anchor (parent)
      const txParent = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: schemaEncoder.encode(["string", "bytes32"], ["parent", ZERO_BYTES32]),
          value: 0n,
        },
      });
      const parentReceipt = await txParent.wait();
      parentUID = getUIDFromReceipt(parentReceipt);

      // Create two file-type child anchors (schema = DATA_SCHEMA_UID)
      const txChild1 = await eas.connect(user1).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: parentUID,
          data: schemaEncoder.encode(["string", "bytes32"], ["file1", dataSchemaUID]),
          value: 0n,
        },
      });
      _child1UID = getUIDFromReceipt(await txChild1.wait());

      const txChild2 = await eas.connect(user1).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: parentUID,
          data: schemaEncoder.encode(["string", "bytes32"], ["file2", dataSchemaUID]),
          value: 0n,
        },
      });
      _child2UID = getUIDFromReceipt(await txChild2.wait());

      // Create standalone DATA (empty schema, ADR-0049)
      const txData = await eas.connect(user1).attest({
        schema: dataSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: 0n,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: "0x",
          value: 0n,
        },
      });
      dataUID1 = getUIDFromReceipt(await txData.wait());
    });

    it("isRevoked returns false for non-revocable DATA", async function () {
      expect(await indexer.isRevoked(dataUID1)).to.equal(false);
      // DATA is non-revocable, so revoke should fail
      await expect(eas.connect(user1).revoke({ schema: dataSchemaUID, data: { uid: dataUID1, value: 0n } })).to.be
        .reverted;
    });

    it("standalone DATA is indexed in schema attestations", async function () {
      const atts = await indexer.getAttestationsBySchema(dataSchemaUID, 0, 10, false, false);
      expect(atts.length).to.be.greaterThan(0);
    });

    it("revoked referencing attestations remain in append-only kernel array; isRevoked() is set", async function () {
      // getReferencingAttestations is append-only — revocation never removes entries.
      // isRevoked() is the mechanism callers use to filter revoked items.
      const tagTx = await eas.connect(user1).attest({
        schema: tagSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: 0n,
          revocable: true,
          refUID: parentUID,
          data: schemaEncoder.encode(["bytes32", "int256"], [ethers.ZeroHash, 1n]),
          value: 0n,
        },
      });
      const tagUID = getUIDFromReceipt(await tagTx.wait());

      // Before revoke: appears in kernel
      const before = await indexer.getReferencingAttestations(parentUID, tagSchemaUID, 0, 10, false, false);
      expect(before.length).to.equal(1);
      expect(await indexer.isRevoked(tagUID)).to.equal(false);

      await eas.connect(user1).revoke({ schema: tagSchemaUID, data: { uid: tagUID, value: 0n } });

      // After revoke: the DEFAULT getter now excludes revoked (ADR-0051) → 0...
      const after = await indexer.getReferencingAttestations(parentUID, tagSchemaUID, 0, 10, false, false);
      expect(after.length).to.equal(0);

      // ...but the underlying array is still append-only — showRevoked=true surfaces the revoked entry.
      const afterRaw = await indexer.getReferencingAttestations(parentUID, tagSchemaUID, 0, 10, false, true);
      expect(afterRaw.length).to.equal(1);

      // And isRevoked reflects the revocation.
      expect(await indexer.isRevoked(tagUID)).to.equal(true);
    });

    it("getChildrenByAttester showRevoked=true/false filters based on _isRevoked flag", async function () {
      // Anchors are non-revocable, so we use TAG attestations (revocable) indexed via tagSchemaUID.
      // getReferencingAttestations is append-only; showRevoked filtering is the caller's responsibility
      // via isRevoked(). This test verifies the flag is set correctly on revocation.
      const tagTx = await eas.connect(user1).attest({
        schema: tagSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: 0n,
          revocable: true,
          refUID: parentUID,
          data: schemaEncoder.encode(["bytes32", "int256"], [ethers.ZeroHash, 1n]),
          value: 0n,
        },
      });
      const tagUID = getUIDFromReceipt(await tagTx.wait());

      // Before revoke: not revoked
      expect(await indexer.isRevoked(tagUID)).to.equal(false);
      const before = await indexer.getReferencingAttestations(parentUID, tagSchemaUID, 0, 10, false, false);
      expect(before.length).to.equal(1);

      await eas.connect(user1).revoke({ schema: tagSchemaUID, data: { uid: tagUID, value: 0n } });

      // After revoke: isRevoked is true; the default getter excludes revoked (ADR-0051) → 0,
      // while showRevoked=true still surfaces the append-only entry.
      expect(await indexer.isRevoked(tagUID)).to.equal(true);
      const after = await indexer.getReferencingAttestations(parentUID, tagSchemaUID, 0, 10, false, false);
      expect(after.length).to.equal(0);
      const afterRaw = await indexer.getReferencingAttestations(parentUID, tagSchemaUID, 0, 10, false, true);
      expect(afterRaw.length).to.equal(1); // still in array — append-only kernel

      // getChildrenByAttester with showRevoked=true/false also uses _isRevoked internally
      // (child1 and child2 are non-revocable anchors, so showRevoked has no visible effect here)
      const withRevoked = await indexer.getChildrenByAttester(
        parentUID,
        await user1.getAddress(),
        0,
        10,
        false,
        true,
      );
      const withoutRevoked = await indexer.getChildrenByAttester(
        parentUID,
        await user1.getAddress(),
        0,
        10,
        false,
        false,
      );
      expect(withRevoked.length).to.equal(withoutRevoked.length); // no revocable anchors in this set
    });

    it("getChildrenByAttester with showRevoked=true includes all; COUNT is total physical length", async function () {
      // child1 and child2 are both added by user1 under parentUID
      const all = await indexer.getChildrenByAttester(
        parentUID,
        await user1.getAddress(),
        0,
        10,
        true,
        true,
      );
      expect(all.length).to.equal(2);

      const count = await indexer.getChildrenByAttesterCount(parentUID, await user1.getAddress());
      expect(count).to.equal(2);
    });
  });

  describe("Tags (Generic Referencing via tagSchemaUID)", function () {
    // Note: PIN and TAG attestations are now managed by the EdgeResolver contract (ADR-0041:
    // PIN = cardinality 1, TAG = cardinality N — sibling schemas, one shared resolver).
    // The Indexer still generically indexes any schema with refUID, so these tests verify
    // that generic referencing (getAllReferencing, getReferencingAttestations) still works
    // for the tagSchemaUID registered with the Indexer as resolver.
    it("Should generically index tag attestations by refUID", async function () {
      // Create Anchor
      const schemaEncoder = new ethers.AbiCoder();
      const tx = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: schemaEncoder.encode(["string", "bytes32"], ["tagged_file", ZERO_BYTES32]),
          value: 0n,
        },
      });
      const receipt = await tx.wait();
      const anchorUID = getUIDFromReceipt(receipt);

      // Tag 1 — "bytes32 definition, int256 weight" per ADR-0041 (weight > 0 = active)
      await eas.attest({
        schema: tagSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: anchorUID,
          data: schemaEncoder.encode(["bytes32", "int256"], [ethers.ZeroHash, 1n]),
          value: 0n,
        },
      });

      // Tag 2 (different weight; both generically indexed by refUID regardless of weight)
      await eas.attest({
        schema: tagSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: anchorUID,
          data: schemaEncoder.encode(["bytes32", "int256"], [ethers.ZeroHash, 2n]),
          value: 0n,
        },
      });

      // Verify via Generic Index (getReferencingAttestations still works for any schema)
      const referencing = await indexer.getReferencingAttestations(anchorUID, tagSchemaUID, 0, 10, false, false);
      expect(referencing.length).to.equal(2);
    });

    it("Should return the correct count of referencing attestations", async function () {
      const schemaEncoder = new ethers.AbiCoder();
      const tx = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: schemaEncoder.encode(["string", "bytes32"], ["file_for_count", ZERO_BYTES32]),
          value: 0n,
        },
      });
      const receipt = await tx.wait();
      const anchorUID = getUIDFromReceipt(receipt);

      // Create a tag
      const tagTx = await eas.attest({
        schema: tagSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: anchorUID,
          data: schemaEncoder.encode(["bytes32", "int256"], [ethers.ZeroHash, 10n]),
          value: 0n,
        },
      });
      const tagReceipt = await tagTx.wait();
      const tagUID = getUIDFromReceipt(tagReceipt);

      // Verify via Generic Index
      const attestations = await indexer.getReferencingAttestations(anchorUID, tagSchemaUID, 0, 10, false, false);
      expect(attestations.length).to.equal(1);
      expect(attestations[0]).to.equal(tagUID);

      const count = await indexer.getReferencingAttestationCount(anchorUID, tagSchemaUID);
      expect(count).to.equal(1);
    });
    describe("Typed Anchors", function () {
      let parentUID: string;
      const schemaEncoder = new ethers.AbiCoder();

      beforeEach(async function () {
        // Create Parent "typed_root"
        const tx = await eas.attest({
          schema: anchorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: ZERO_BYTES32,
            data: schemaEncoder.encode(["string", "bytes32"], ["typed_root", ZERO_BYTES32]),
            value: 0n,
          },
        });
        const receipt = await tx.wait();
        parentUID = getUIDFromReceipt(receipt);
      });

      it("Should index Anchors by Schema", async function () {
        // 1. Create Property Anchor "color"
        const txProp = await eas.attest({
          schema: anchorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: parentUID,
            data: schemaEncoder.encode(["string", "bytes32"], ["color", propertySchemaUID]),
            value: 0n,
          },
        });
        const receiptProp = await txProp.wait();
        const propUID = getUIDFromReceipt(receiptProp);

        // 2. Create File Anchor "data.json"
        const txFile = await eas.attest({
          schema: anchorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: parentUID,
            data: schemaEncoder.encode(["string", "bytes32"], ["data.json", dataSchemaUID]),
            value: 0n,
          },
        });
        const receiptFile = await txFile.wait();
        const fileUID = getUIDFromReceipt(receiptFile);

        // 3. Verify getAnchorsBySchema(Property)
        const props = await indexer.getAnchorsBySchema(
          parentUID,
          propertySchemaUID,
          0,
          10,
          false,
          false,
        );
        expect(props.length).to.equal(1);
        expect(props[0]).to.equal(propUID);

        // 4. Verify getAnchorsBySchema(Data)
        const files = await indexer.getAnchorsBySchema(
          parentUID,
          dataSchemaUID,
          0,
          10,
          false,
          false,
        );
        expect(files.length).to.equal(1);
        expect(files[0]).to.equal(fileUID);

        // 5. Verify Generic Children contains ALL
        const all = await indexer.getChildren(parentUID, 0, 10, false, false);
        expect(all.length).to.equal(2);
        expect(all).to.include(propUID);
        expect(all).to.include(fileUID);
      });

      it("Should resolve Anchors by Schema", async function () {
        // Create "test_name" as Property
        const txProp = await eas.attest({
          schema: anchorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: parentUID,
            data: schemaEncoder.encode(["string", "bytes32"], ["test_name", propertySchemaUID]),
            value: 0n,
          },
        });
        const receiptProp = await txProp.wait();
        const propUID = getUIDFromReceipt(receiptProp);

        // Create "test_name" as Generic (Different Schema!) - Should succeed (unique by parent+name+schema)
        const txGen = await eas.attest({
          schema: anchorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: parentUID,
            data: schemaEncoder.encode(["string", "bytes32"], ["test_name", ZERO_BYTES32]),
            value: 0n,
          },
        });
        const receiptGen = await txGen.wait();
        const genUID = getUIDFromReceipt(receiptGen);

        // Resolve Property
        const resolvedProp = await indexer.resolveAnchor(parentUID, "test_name", propertySchemaUID);
        expect(resolvedProp).to.equal(propUID);

        // Resolve Generic (resolvePath defaults to 0)
        const resolvedGen = await indexer.resolvePath(parentUID, "test_name");
        expect(resolvedGen).to.equal(genUID);

        // Resolve Generic Explicitly
        const resolvedGenExplicit = await indexer.resolveAnchor(parentUID, "test_name", ZERO_BYTES32);
        expect(resolvedGenExplicit).to.equal(genUID);
      });
    });
  });

  describe("End-to-End Multi-Hop Flows", function () {
    let parentUID: string;
    const schemaEncoder = new ethers.AbiCoder();

    beforeEach(async function () {
      const tx = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: schemaEncoder.encode(["string", "bytes32"], ["multihop_root", ZERO_BYTES32]),
          value: 0n,
        },
      });
      const receipt = await tx.wait();
      parentUID = getUIDFromReceipt(receipt);
    });

    it("Should resolve Property key anchor and accept free-floating PROPERTY value (ADR-0035)", async function () {
      // 1. Create Property key anchor "theme" under parent
      const txAnchor = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: parentUID,
          data: schemaEncoder.encode(["string", "bytes32"], ["theme", propertySchemaUID]),
          value: 0n,
        },
      });
      const receiptAnchor = await txAnchor.wait();
      const anchorUID = getUIDFromReceipt(receiptAnchor);

      // 2. Attest free-floating PROPERTY value "DarkMode" (refUID=0x0, non-revocable)
      const txValue = await eas.attest({
        schema: propertySchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: schemaEncoder.encode(["string"], ["DarkMode"]),
          value: 0n,
        },
      });
      const receiptValue = await txValue.wait();
      const valueUID = getUIDFromReceipt(receiptValue);
      expect(valueUID).to.not.equal(ZERO_BYTES32);

      // 3. Resolve key anchor (the placement binding happens via PIN in the full model
      //    under ADR-0041, which lives in EdgeResolver — this kernel-only test verifies
      //    attestation shape).
      const resolvedAnchor = await indexer.resolveAnchor(parentUID, "theme", propertySchemaUID);
      expect(resolvedAnchor).to.equal(anchorUID);
    });

    it("Should resolve File Data (Anchor -> Data -> Blob)", async function () {
      // 1. Create File Anchor "intro.mp4"
      const txAnchor = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: parentUID,
          data: schemaEncoder.encode(["string", "bytes32"], ["intro.mp4", dataSchemaUID]),
          value: 0n,
        },
      });
      const receiptAnchor = await txAnchor.wait();
      const anchorUID = getUIDFromReceipt(receiptAnchor);

      // 2. Create Blob
      const txBlob = await eas.attest({
        schema: blobSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: ZERO_BYTES32,
          data: schemaEncoder.encode(["string", "uint8", "bytes"], ["video/mp4", 0, "0xFACE"]),
          value: 0n,
        },
      });
      const receiptBlob = await txBlob.wait();
      const _blobUID = getUIDFromReceipt(receiptBlob);

      // 3. Create standalone DATA (empty schema, ADR-0049)
      const txData = await eas.attest({
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
      const receiptData = await txData.wait();
      const dataUID = getUIDFromReceipt(receiptData);

      // 4. Resolve Anchor
      const resolvedAnchor = await indexer.resolveAnchor(parentUID, "intro.mp4", dataSchemaUID);
      expect(resolvedAnchor).to.equal(anchorUID);

      // 5. Verify DATA is indexed (ADR-0049: dataByContentKey is no longer written;
      //    the bare DATA UID is tracked in the global schema index).
      const indexedData = await indexer.getAttestationsBySchema(dataSchemaUID, 0, 50, false, false);
      expect(indexedData).to.include(dataUID);
    });
  });

  describe("Perspectives (Address-Based Namespaces)", function () {
    let parentUID: string;
    let fileAnchorUID: string;
    const schemaEncoder = new ethers.AbiCoder();

    beforeEach(async function () {
      // 1. Create a root directory (parent)
      const txParent = await eas.connect(owner).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: schemaEncoder.encode(["string", "bytes32"], ["perspectives_dir", ZERO_BYTES32]),
          value: 0n,
        },
      });
      const receiptParent = await txParent.wait();
      parentUID = getUIDFromReceipt(receiptParent);

      // 2. Create a file anchor inside the directory
      const txFile = await eas.connect(owner).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: parentUID,
          data: schemaEncoder.encode(["string", "bytes32"], ["shared_file.json", dataSchemaUID]),
          value: 0n,
        },
      });
      const receiptFile = await txFile.wait();
      fileAnchorUID = getUIDFromReceipt(receiptFile);
    });

    it("Should track core Referencing mappings properly (All, Schema, Attester)", async function () {
      // User 1 tags the file
      const tagTx = await eas.connect(user1).attest({
        schema: tagSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: 0n,
          revocable: true,
          refUID: fileAnchorUID,
          data: schemaEncoder.encode(["bytes32", "int256"], [ethers.ZeroHash, 10n]),
          value: 0n,
        },
      });
      const tagReceipt = await tagTx.wait();
      const tagUID = getUIDFromReceipt(tagReceipt);

      // Check _allReferencing
      const allRef = await indexer.getAllReferencing(fileAnchorUID, 0, 10, false, false);
      expect(allRef).to.include(tagUID);

      // Check _referencingByAttester
      const attesterRef = await indexer.getReferencingByAttester(
        fileAnchorUID,
        await user1.getAddress(),
        0,
        10,
        false,
        false,
      );
      expect(attesterRef).to.include(tagUID);

      // Check _referencingBySchemaAndAttester
      const schemaAttesterRef = await indexer.getReferencingBySchemaAndAttester(
        fileAnchorUID,
        tagSchemaUID,
        await user1.getAddress(),
        0,
        10,
        false,
        false,
      );
      expect(schemaAttesterRef).to.include(tagUID);

      // User 1 revokes the tag
      await eas.connect(user1).revoke({
        schema: tagSchemaUID,
        data: { uid: tagUID, value: 0n },
      });

      // After revoke: the default getter excludes revoked (ADR-0051) → empty...
      const allRefAfter = await indexer.getAllReferencing(fileAnchorUID, 0, 10, false, false);
      expect(allRefAfter.length).to.equal(0);
      // ...but the array is still append-only — showRevoked=true surfaces the revoked entry.
      const allRefRaw = await indexer.getAllReferencing(fileAnchorUID, 0, 10, false, true);
      expect(allRefRaw.length).to.equal(1);
    });

    // ──────────────────────────────────────────────────────────────────────────
    // getChildrenByAddressList — deduplicated, global insertion order
    // ──────────────────────────────────────────────────────────────────────────

    it("getChildrenByAddressList: returns unique items in insertion order", async function () {
      const schemaEncoder = new ethers.AbiCoder();
      const createAnchor = async (signer: Signer, name: string) => {
        const tx = await eas.connect(signer).attest({
          schema: anchorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: 0n,
            revocable: false,
            refUID: parentUID,
            data: schemaEncoder.encode(["string", "bytes32"], [name, ZERO_BYTES32]),
            value: 0n,
          },
        });
        return getUIDFromReceipt(await tx.wait());
      };

      const u1Addr = await user1.getAddress();
      const u2Addr = await user2.getAddress();

      const f1 = await createAnchor(user1, "alpha");
      const f2 = await createAnchor(user2, "beta");
      const f3 = await createAnchor(user1, "gamma");

      const [results] = await indexer.getChildrenByAddressList(parentUID, [u1Addr, u2Addr], 0n, 10, false, false);

      // Returns the 3 items created by user1/user2 (beforeEach item was created by owner, not filtered in)
      expect(results.length).to.equal(3);
      expect(results[0]).to.equal(f1);
      expect(results[1]).to.equal(f2);
      expect(results[2]).to.equal(f3);
    });

    it("getChildrenByAddressList: cursor pagination returns all items exactly once", async function () {
      const schemaEncoder = new ethers.AbiCoder();
      const u1Addr = await user1.getAddress();

      for (let i = 0; i < 9; i++) {
        await eas.connect(user1).attest({
          schema: anchorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: 0n,
            revocable: false,
            refUID: parentUID,
            data: schemaEncoder.encode(["string", "bytes32"], [`file_${i}`, ZERO_BYTES32]),
            value: 0n,
          },
        });
      }
      // beforeEach item was created by owner (not user1), so only 9 items match the [u1Addr] filter

      const all: string[] = [];
      let cursor = 0n;
      do {
        const [page, next] = await indexer.getChildrenByAddressList(parentUID, [u1Addr], cursor, 3, false, false);
        all.push(...page);
        cursor = next;
      } while (cursor !== 0n);

      expect(all.length).to.equal(9);
      expect(new Set(all).size).to.equal(9); // no duplicates
    });

    it("getChildrenByAddressList: attester filter — only items ANY attester contributed to", async function () {
      const schemaEncoder = new ethers.AbiCoder();
      const ownerAddr = await owner.getAddress();
      const u1Addr = await user1.getAddress();

      await eas.connect(user1).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: 0n,
          revocable: false,
          refUID: parentUID,
          data: schemaEncoder.encode(["string", "bytes32"], ["user1only", ZERO_BYTES32]),
          value: 0n,
        },
      });

      // Only include user1's item, not owner's (fileAnchorUID from beforeEach)
      const [onlyU1] = await indexer.getChildrenByAddressList(parentUID, [u1Addr], 0n, 10, false, false);
      expect(onlyU1.length).to.equal(1);

      // Include both
      const [both] = await indexer.getChildrenByAddressList(parentUID, [ownerAddr, u1Addr], 0n, 10, false, false);
      expect(both.length).to.equal(2);
    });

    it("getChildrenByAddressList: reverseOrder returns items newest-first", async function () {
      const schemaEncoder = new ethers.AbiCoder();
      const u1Addr = await user1.getAddress();

      const newAnchor = await (async () => {
        const tx = await eas.connect(user1).attest({
          schema: anchorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: 0n,
            revocable: false,
            refUID: parentUID,
            data: schemaEncoder.encode(["string", "bytes32"], ["newest", ZERO_BYTES32]),
            value: 0n,
          },
        });
        return getUIDFromReceipt(await tx.wait());
      })();

      const ownerAddr = await owner.getAddress();
      const [fwd] = await indexer.getChildrenByAddressList(parentUID, [ownerAddr, u1Addr], 0n, 10, false, false);
      const [rev] = await indexer.getChildrenByAddressList(parentUID, [ownerAddr, u1Addr], 0n, 10, true, false);

      expect(fwd[0]).to.equal(fileAnchorUID); // oldest first
      expect(rev[0]).to.equal(newAnchor); // newest first
      expect(fwd.length).to.equal(rev.length);
    });
  });

  describe("Lenses & Recursive Indexing", function () {
    const schemaEncoder = new ethers.AbiCoder();
    let rootUID: string;
    let folder1UID: string;
    let folder2UID: string;
    let _fileUID: string;

    beforeEach(async function () {
      // Create Root (Zero Hash)
      let tx = await eas.connect(owner).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: 0n,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: schemaEncoder.encode(["string", "bytes32"], ["root", ZERO_BYTES32]),
          value: 0n,
        },
      });
      rootUID = getUIDFromReceipt(await tx.wait());

      // Create Folder 1 under Root (by owner)
      tx = await eas.connect(owner).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: 0n,
          revocable: false,
          refUID: rootUID,
          data: schemaEncoder.encode(["string", "bytes32"], ["folder1", ZERO_BYTES32]),
          value: 0n,
        },
      });
      folder1UID = getUIDFromReceipt(await tx.wait());

      // Create Folder 2 under Folder 1 (by owner)
      tx = await eas.connect(owner).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: 0n,
          revocable: false,
          refUID: folder1UID,
          data: schemaEncoder.encode(["string", "bytes32"], ["folder2", ZERO_BYTES32]),
          value: 0n,
        },
      });
      folder2UID = getUIDFromReceipt(await tx.wait());
    });

    it("Should flag containsAttestations for the Anchor creator", async function () {
      // User1 creates a file anchor under folder2
      const tx = await eas.connect(user1).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: 0n,
          revocable: false,
          refUID: folder2UID,
          data: schemaEncoder.encode(["string", "bytes32"], ["user1_file.txt", dataSchemaUID]),
          value: 0n,
        },
      });
      _fileUID = getUIDFromReceipt(await tx.wait());

      // Check direct flag on the folder (since anchor refUID = folder2UID)
      const u1Address = await user1.getAddress();
      expect(await indexer.containsAttestations(folder2UID, u1Address)).to.equal(true);

      // Check schema-specific flag
      expect(await indexer.containsSchemaAttestations(folder2UID, u1Address, anchorSchemaUID)).to.equal(true);
    });

    it("Should recursively flag parent folders up to root", async function () {
      // User2 creates a file directly under folder2
      const tx = await eas.connect(user2).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: 0n,
          revocable: false,
          refUID: folder2UID,
          data: schemaEncoder.encode(["string", "bytes32"], ["user2_file.txt", dataSchemaUID]),
          value: 0n,
        },
      });
      await tx.wait();

      const u2Address = await user2.getAddress();

      // Check all parents up to root
      expect(await indexer.containsAttestations(folder2UID, u2Address)).to.equal(true);
      expect(await indexer.containsAttestations(folder1UID, u2Address)).to.equal(true);
      expect(await indexer.containsAttestations(rootUID, u2Address)).to.equal(true);
    });
  });

  // ============================================================================================
  // KERNEL EVENTS
  // ============================================================================================

  describe("Kernel events", function () {
    const enc = new ethers.AbiCoder();
    let parentUID: string;

    beforeEach(async function () {
      // Each test gets a fresh deployment — create root anchor first
      const tx = await eas.connect(owner).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: enc.encode(["string", "bytes32"], ["root", ZERO_BYTES32]),
          value: 0n,
        },
      });
      parentUID = getUIDFromReceipt(await tx.wait());
    });

    it("emits AnchorCreated when a child Anchor is attested", async function () {
      const ownerAddr = await owner.getAddress();
      const tx = await eas.connect(owner).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: parentUID,
          data: enc.encode(["string", "bytes32"], ["event-anchor", ZERO_BYTES32]),
          value: 0n,
        },
      });
      const childUID = getUIDFromReceipt(await tx.wait());

      await expect(tx)
        .to.emit(indexer, "AnchorCreated")
        .withArgs(parentUID, childUID, ownerAddr, ZERO_BYTES32, "event-anchor");
    });

    it("emits DataCreated when standalone DATA is created", async function () {
      const ownerAddr = await owner.getAddress();

      // DATA is an empty schema (ADR-0049); DataCreated dropped the contentHash arg.
      const dataTx = await eas.connect(owner).attest({
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
      const dataUID = getUIDFromReceipt(await dataTx.wait());

      await expect(dataTx).to.emit(indexer, "DataCreated").withArgs(dataUID, ownerAddr);
    });
  });

  // ============================================================================================
  // getChildrenByAttesterAt
  // ============================================================================================

  describe("getChildrenByAttesterAt", function () {
    const enc = new ethers.AbiCoder();
    let parentUID: string;
    let f1: string, f2: string, f3: string;

    beforeEach(async function () {
      // Each test gets a fresh deployment — create root anchor first
      const rootTx = await eas.connect(owner).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: enc.encode(["string", "bytes32"], ["root", ZERO_BYTES32]),
          value: 0n,
        },
      });
      parentUID = getUIDFromReceipt(await rootTx.wait());

      const attest = async (name: string) => {
        const tx = await eas.connect(owner).attest({
          schema: anchorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: parentUID,
            data: enc.encode(["string", "bytes32"], [name, ZERO_BYTES32]),
            value: 0n,
          },
        });
        return getUIDFromReceipt(await tx.wait());
      };

      f1 = await attest("at-file-1");
      f2 = await attest("at-file-2");
      f3 = await attest("at-file-3");
    });

    it("returns the correct item at each index", async function () {
      const ownerAddr = await owner.getAddress();
      expect(await indexer.getChildrenByAttesterAt(parentUID, ownerAddr, 0)).to.equal(f1);
      expect(await indexer.getChildrenByAttesterAt(parentUID, ownerAddr, 1)).to.equal(f2);
      expect(await indexer.getChildrenByAttesterAt(parentUID, ownerAddr, 2)).to.equal(f3);
    });

    it("reverts on out-of-bounds index", async function () {
      const ownerAddr = await owner.getAddress();
      await expect(indexer.getChildrenByAttesterAt(parentUID, ownerAddr, 99)).to.be.revertedWith(
        "EFSIndexer: index out of bounds",
      );
    });
  });
});
