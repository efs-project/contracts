import { expect } from "chai";
import { ethers } from "hardhat";
import { AliasResolver, EAS, SchemaRegistry } from "../typechain-types";
import { Signer, ZeroAddress } from "ethers";
import { deployResolverProxy } from "./helpers/deployResolverProxy";

// REDIRECT schema is FROZEN (ADR-0050): "bytes32 target, uint16 kind", revocable true.
const REDIRECT_SCHEMA = "bytes32 target, uint16 kind";
// Minimal stand-in schemas for DATA (empty, ADR-0049) and ANCHOR (one string field). The
// AliasResolver only type-checks by schema UID — the field shapes here just need to be the
// UIDs it was initialized with.
const DATA_SCHEMA = ""; // DATA is an empty attestation (pure identity, ADR-0049)
const ANCHOR_SCHEMA = "string name";

const ZERO_BYTES32 = "0x" + "0".repeat(64);
const NO_EXPIRATION = 0n;

describe("AliasResolver — REDIRECT (ADR-0050)", function () {
  let aliasResolver: AliasResolver;
  let eas: EAS;
  let registry: SchemaRegistry;
  let alice: Signer;
  let dataSchemaUID: string;
  let anchorSchemaUID: string;
  let otherSchemaUID: string; // a non-DATA, non-ANCHOR schema (for negative typing tests)
  let redirectSchemaUID: string;

  const enc = new ethers.AbiCoder();
  const encodeRedirect = (target: string, kind: number) => enc.encode(["bytes32", "uint16"], [target, kind]);

  const getUID = (receipt: any): string => {
    for (const log of receipt.logs) {
      try {
        const p = eas.interface.parseLog(log);
        if (p?.name === "Attested") return p.args.uid;
      } catch {
        /* ignore */
      }
    }
    throw new Error("No Attested event");
  };

  const getRegisteredUID = (receipt: any): string => {
    for (const log of receipt.logs) {
      try {
        const p = registry.interface.parseLog(log);
        if (p?.name === "Registered") return p.args.uid;
      } catch {
        /* ignore */
      }
    }
    throw new Error("No Registered event");
  };

  // Mint a DATA attestation (empty payload).
  const mintData = async (signer: Signer): Promise<string> => {
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

  // Mint an ANCHOR attestation.
  const mintAnchor = async (signer: Signer, name: string): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: ZERO_BYTES32,
        data: enc.encode(["string"], [name]),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  // Mint an attestation under the "other" (non-DATA, non-ANCHOR) schema.
  const mintOther = async (signer: Signer): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: otherSchemaUID,
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

  // Attest a REDIRECT: refUID = source, payload = (target, kind).
  const attestRedirect = async (signer: Signer, source: string, target: string, kind: number) => {
    const tx = await eas.connect(signer).attest({
      schema: redirectSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: source,
        data: encodeRedirect(target, kind),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  beforeEach(async function () {
    [alice] = await ethers.getSigners();
    const aliceAddr = await alice.getAddress();

    const RegistryFactory = await ethers.getContractFactory("SchemaRegistry");
    registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();

    const EASFactory = await ethers.getContractFactory("EAS");
    eas = await EASFactory.deploy(await registry.getAddress());
    await eas.waitForDeployment();

    // Register DATA / ANCHOR / other helper schemas (no resolver — they just supply UIDs the
    // AliasResolver types against).
    dataSchemaUID = getRegisteredUID(await (await registry.register(DATA_SCHEMA, ZeroAddress, false)).wait());
    anchorSchemaUID = getRegisteredUID(await (await registry.register(ANCHOR_SCHEMA, ZeroAddress, false)).wait());
    otherSchemaUID = getRegisteredUID(await (await registry.register("string misc", ZeroAddress, false)).wait());

    // deployResolverProxy runs TWO deployer txs (impl, then proxy). The PROXY is the resolver
    // baked into REDIRECT's schema UID. Predict the proxy address to register REDIRECT against it.
    const n = await ethers.provider.getTransactionCount(aliceAddr);
    // impl = n+0, proxy = n+1.
    const futureProxyAddr = ethers.getCreateAddress({ from: aliceAddr, nonce: n + 1 });
    redirectSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      [REDIRECT_SCHEMA, futureProxyAddr, true],
    );

    aliasResolver = await deployResolverProxy<AliasResolver>(
      "AliasResolver",
      [await eas.getAddress()],
      [dataSchemaUID, anchorSchemaUID],
      alice,
    );
    expect(await aliasResolver.getAddress()).to.equal(futureProxyAddr);

    // Register REDIRECT against the PROXY (the resolver in the schema UID), revocable = true.
    await registry.register(REDIRECT_SCHEMA, futureProxyAddr, true);
  });

  // ── Self-UID + lifecycle (the ListEntry lesson) ──────────────────────────────

  describe("self-UID + upgradeable lifecycle (ADR-0048)", function () {
    it("on-chain redirectSchemaUID() == off-chain proxy-derived == registered EAS schema UID", async function () {
      const onChain = await aliasResolver.redirectSchemaUID();
      expect(onChain).to.equal(redirectSchemaUID);
      const proxyAddr = await aliasResolver.getAddress();
      const offChain = ethers.solidityPackedKeccak256(
        ["string", "address", "bool"],
        [REDIRECT_SCHEMA, proxyAddr, true],
      );
      expect(onChain).to.equal(offChain);
      // It is a real EAS-registered schema with this proxy as resolver and revocable=true.
      const rec = await registry.getSchema(onChain);
      expect(rec.uid).to.equal(redirectSchemaUID);
      expect(rec.resolver).to.equal(proxyAddr);
      expect(rec.revocable).to.equal(true);
    });

    it("self-UID does NOT equal an impl-derived (non-proxy) UID — the bug the pattern fixes", async function () {
      const onChain = await aliasResolver.redirectSchemaUID();
      const aliceAddr = await alice.getAddress();
      const wrong = ethers.solidityPackedKeccak256(["string", "address", "bool"], [REDIRECT_SCHEMA, aliceAddr, true]);
      expect(onChain).to.not.equal(wrong);
      expect(await aliasResolver.getAddress()).to.not.equal(aliceAddr);
    });

    it("initialize is one-shot — re-initializing through the proxy reverts", async function () {
      await expect(aliasResolver.initialize(dataSchemaUID, anchorSchemaUID)).to.be.revertedWithCustomError(
        aliasResolver,
        "InvalidInitialization",
      );
    });

    it("exposes the constructor EAS via getEAS() through the proxy", async function () {
      expect(await aliasResolver.getEAS()).to.equal(await eas.getAddress());
    });

    it("config getters return the values set in initialize()", async function () {
      expect(await aliasResolver.dataSchemaUID()).to.equal(dataSchemaUID);
      expect(await aliasResolver.anchorSchemaUID()).to.equal(anchorSchemaUID);
    });
  });

  // ── Write-time guards via REAL EAS attestations (so onAttest fires) ──────────

  describe("write-time guards", function () {
    it("sameAs (DATA→DATA) is accepted end-to-end and does NOT revert WrongSchema", async function () {
      // False-green guard: this asserts the full register-against-proxy + self-UID-in-initialize
      // path. Against an impl-derived UID this would revert WrongSchema before any typing check.
      const src = await mintData(alice);
      const dst = await mintData(alice);
      const uid = await attestRedirect(alice, src, dst, 0 /* sameAs */);
      expect(uid).to.not.equal(ZERO_BYTES32);
    });

    it("supersededBy (DATA→DATA) is accepted", async function () {
      const src = await mintData(alice);
      const dst = await mintData(alice);
      const uid = await attestRedirect(alice, src, dst, 1 /* supersededBy */);
      expect(uid).to.not.equal(ZERO_BYTES32);
    });

    it("target == 0 reverts (ZeroTarget)", async function () {
      const src = await mintData(alice);
      await expect(attestRedirect(alice, src, ZERO_BYTES32, 0)).to.be.revertedWithCustomError(
        aliasResolver,
        "ZeroTarget",
      );
    });

    it("target == source (trivial self-loop) reverts (SelfLoop)", async function () {
      const src = await mintData(alice);
      await expect(attestRedirect(alice, src, src, 0)).to.be.revertedWithCustomError(aliasResolver, "SelfLoop");
    });

    it("sameAs with a non-DATA source reverts (SourceNotData)", async function () {
      const src = await mintAnchor(alice, "notdata"); // ANCHOR source
      const dst = await mintData(alice);
      await expect(attestRedirect(alice, src, dst, 0)).to.be.revertedWithCustomError(aliasResolver, "SourceNotData");
    });

    it("sameAs with a non-DATA target reverts (TargetNotData)", async function () {
      const src = await mintData(alice);
      const dst = await mintAnchor(alice, "notdata"); // ANCHOR target
      await expect(attestRedirect(alice, src, dst, 0)).to.be.revertedWithCustomError(aliasResolver, "TargetNotData");
    });

    it("symlink (kind=2) with a non-Anchor source reverts (SourceNotAnchor)", async function () {
      const src = await mintData(alice); // DATA source, not an Anchor
      const dst = await mintAnchor(alice, "dest");
      await expect(attestRedirect(alice, src, dst, 2)).to.be.revertedWithCustomError(aliasResolver, "SourceNotAnchor");
    });

    it("symlink (kind=2) with an Anchor source and Anchor target is accepted", async function () {
      const src = await mintAnchor(alice, "link");
      const dst = await mintAnchor(alice, "dest");
      const uid = await attestRedirect(alice, src, dst, 2);
      expect(uid).to.not.equal(ZERO_BYTES32);
    });

    it("symlink (kind=2) with an Anchor source and DATA target is accepted", async function () {
      const src = await mintAnchor(alice, "link");
      const dst = await mintData(alice);
      const uid = await attestRedirect(alice, src, dst, 2);
      expect(uid).to.not.equal(ZERO_BYTES32);
    });

    it("symlink (kind=2) with an Anchor source and a non-Anchor/non-DATA target reverts", async function () {
      const src = await mintAnchor(alice, "link");
      const dst = await mintOther(alice);
      await expect(attestRedirect(alice, src, dst, 2)).to.be.revertedWithCustomError(
        aliasResolver,
        "TargetNotAnchorOrData",
      );
    });

    it("kind >= 3 is recorded with NO type-check (reserved) — any non-zero, non-self target accepted", async function () {
      // Source and target are deliberately non-DATA / non-Anchor; reserved kinds skip typing.
      const src = await mintOther(alice);
      const dst = await mintOther(alice);
      const uid = await attestRedirect(alice, src, dst, 3 /* reserved (e.g. relatedVersion) */);
      expect(uid).to.not.equal(ZERO_BYTES32);
    });

    it("kind >= 3 still enforces target != source", async function () {
      const src = await mintOther(alice);
      await expect(attestRedirect(alice, src, src, 7)).to.be.revertedWithCustomError(aliasResolver, "SelfLoop");
    });

    it("revoking a REDIRECT works (revocable=true)", async function () {
      const src = await mintData(alice);
      const dst = await mintData(alice);
      const uid = await attestRedirect(alice, src, dst, 0);
      await expect(eas.connect(alice).revoke({ schema: redirectSchemaUID, data: { uid, value: 0n } })).to.not.be
        .reverted;
    });
  });
});
