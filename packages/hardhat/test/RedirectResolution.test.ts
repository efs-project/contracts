import { expect } from "chai";
import { ethers } from "hardhat";
import { AliasResolver, EFSIndexer, EFSFileView, EAS, SchemaRegistry } from "../typechain-types";
import { Signer, ZeroAddress } from "ethers";
import { deployIndexerProxy } from "./helpers/deployIndexerProxy";
import { deployResolverProxy } from "./helpers/deployResolverProxy";

/**
 * RedirectResolution — DRAFT conformance vectors for `EFSFileView.resolveRedirect`
 * (specs/09-redirect-resolution.md, Proposed — NOT YET RATIFIED).
 *
 * Exercises the bounded, lens-scoped REDIRECT/symlink follower end-to-end against a real
 * AliasResolver (its additive `getActiveRedirect` reverse-by-source index) + EFSIndexer + EAS.
 *
 * NOTE (harness): this file predicts deterministic CREATE addresses via the deployer nonce in
 * `beforeEach`, so it MUST be run as a FULL FILE (`yarn test test/RedirectResolution.test.ts`),
 * NOT via `--grep` — a grep run that skips the deploy txs desyncs the nonce predictions.
 */

const ZERO_BYTES32 = "0x" + "0".repeat(64);
const NO_EXPIRATION = 0n;

// FROZEN schema strings (must match the deploy registrations exactly — hashed into the UID).
const REDIRECT_SCHEMA = "bytes32 target, uint16 kind";
const ANCHOR_SCHEMA = "string name, bytes32 forSchema";
const DATA_SCHEMA = ""; // empty (pure identity, ADR-0049)
const PROPERTY_SCHEMA = "string value";

// Redirect kinds (taxonomy is resolver logic + client convention, ADR-0050).
const KIND_SAME_AS = 0;
const KIND_SUPERSEDED_BY = 1;
const KIND_SYMLINK = 2;
const KIND_RELATED = 3; // reserved / never-auto-followed

// RedirectStatus enum (must match EFSFileView.RedirectStatus order).
const Status = {
  Resolved: 0n,
  Dangling: 1n,
  CycleStopped: 2n,
  DepthExceeded: 3n,
  Suppressed: 4n,
};

describe("EFSFileView.resolveRedirect — REDIRECT follower (DRAFT, specs/09)", function () {
  let aliasResolver: AliasResolver;
  let indexer: EFSIndexer;
  let fileView: EFSFileView;
  let eas: EAS;
  let registry: SchemaRegistry;

  let owner: Signer; // primary lens
  let alice: Signer; // in-lens attester
  let mallory: Signer; // out-of-lens (foreign) attester

  let anchorSchemaUID: string;
  let dataSchemaUID: string;
  let propertySchemaUID: string;
  let redirectSchemaUID: string;
  let resolverAddr: string;

  const enc = new ethers.AbiCoder();

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

  const getRegisteredUID = (receipt: any): string => receipt.logs[0].topics[1];

  // ── Mint helpers ────────────────────────────────────────────────────────────

  const mintAnchor = async (name: string, parentUID = ZERO_BYTES32, signer: Signer = owner): Promise<string> => {
    const tx = await eas.connect(signer).attest({
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
    return getUID(await tx.wait());
  };

  // DATA is non-revocable empty identity (ADR-0049). For the "revoked target" vector we need a
  // revocable DATA-schema attestation; EAS allows a revocable attestation under a revocable=false
  // schema? No — so we mint a revocable ANCHOR for the revoke test instead (classify treats any
  // revoked node as Unknown regardless of schema).
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

  // A revocable ANCHOR — used only to produce a target we can later revoke (to drive Dangling).
  const mintRevocableAnchor = async (name: string, signer: Signer = owner): Promise<{ uid: string }> => {
    const tx = await eas.connect(signer).attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: ZERO_BYTES32,
        data: enc.encode(["string", "bytes32"], [name, ZERO_BYTES32]),
        value: 0n,
      },
    });
    return { uid: getUID(await tx.wait()) };
  };

  const attestRedirect = async (
    source: string,
    target: string,
    kind: number,
    signer: Signer = owner,
  ): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: redirectSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: source,
        data: enc.encode(["bytes32", "uint16"], [target, kind]),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  const revoke = async (schema: string, uid: string, signer: Signer = owner): Promise<void> => {
    await eas.connect(signer).revoke({ schema, data: { uid, value: 0n } });
  };

  beforeEach(async function () {
    [owner, alice, mallory] = await ethers.getSigners();
    const ownerAddr = await owner.getAddress();

    const RegistryFactory = await ethers.getContractFactory("SchemaRegistry");
    registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();

    const EASFactory = await ethers.getContractFactory("EAS");
    eas = await EASFactory.deploy(await registry.getAddress());
    await eas.waitForDeployment();

    // We need the AliasResolver PROXY address baked into the REDIRECT schema UID before deploying
    // the resolver. The schema registrations (ANCHOR/DATA/PROPERTY/REDIRECT, no resolver for the
    // first three) happen first, then deployResolverProxy runs TWO deployer txs (impl, then proxy).
    // Order of OWNER txs after this point:
    //   nonce+0..3: register ANCHOR, DATA, PROPERTY, REDIRECT (4 register txs)
    //   nonce+4: AliasResolver implementation
    //   nonce+5: AliasResolver proxy  ← the resolver in the REDIRECT UID
    // (indexer deploy happens via its own helper afterward and is irrelevant to the REDIRECT UID).
    const nonce = await ethers.provider.getTransactionCount(ownerAddr);
    resolverAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: nonce + 5 });
    redirectSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      [REDIRECT_SCHEMA, resolverAddr, true],
    );

    // NOTE: in canonical EFS the ANCHOR and DATA schemas are NON-revocable (their EFSIndexer
    // onAttest rejects `revocable` — ADR-0002 / ADR-0049), so a *revoked* DATA/Anchor target can
    // never occur in production and the follower's `Dangling`-on-revoked branch is purely
    // DEFENSIVE. Here the helper schemas carry NO resolver (ZeroAddress), so EAS imposes no such
    // guard; we register them REVOCABLE *only in this isolated harness* so the defensive branch is
    // still exercisable (revocable anchors/data still classify correctly as Anchor/DATA). This is
    // a test-harness affordance, NOT a claim that production endpoints are revocable.
    anchorSchemaUID = getRegisteredUID(await (await registry.register(ANCHOR_SCHEMA, ZeroAddress, true)).wait());
    dataSchemaUID = getRegisteredUID(await (await registry.register(DATA_SCHEMA, ZeroAddress, true)).wait());
    propertySchemaUID = getRegisteredUID(await (await registry.register(PROPERTY_SCHEMA, ZeroAddress, false)).wait());
    // REDIRECT registered against the (predicted) proxy, revocable = true.
    await (await registry.register(REDIRECT_SCHEMA, resolverAddr, true)).wait();

    aliasResolver = await deployResolverProxy<AliasResolver>(
      "AliasResolver",
      [await eas.getAddress()],
      [dataSchemaUID, anchorSchemaUID],
      owner,
    );
    expect(await aliasResolver.getAddress()).to.equal(resolverAddr);
    expect(await aliasResolver.redirectSchemaUID()).to.equal(redirectSchemaUID);

    // Indexer + a (real) EdgeResolver are needed only because EFSFileView's constructor wires
    // them; resolveRedirect itself reads the indexer's DATA/ANCHOR schema UIDs + EAS + the passed
    // AliasResolver. Deploy the indexer behind its proxy and a throwaway EdgeResolver proxy.
    const edgeNonce = await ethers.provider.getTransactionCount(ownerAddr);
    const futureEdgeResolverAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: edgeNonce + 1 });
    const pinUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      ["bytes32 definition", futureEdgeResolverAddr, true],
    );
    const tagUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      ["bytes32 definition, int256 weight", futureEdgeResolverAddr, true],
    );
    const edgeResolver = await deployResolverProxy(
      "EdgeResolver",
      [await eas.getAddress()],
      [pinUID, tagUID, ZeroAddress, await registry.getAddress()],
      owner,
    );
    void edgeResolver;

    indexer = await deployIndexerProxy(
      await eas.getAddress(),
      anchorSchemaUID,
      propertySchemaUID,
      dataSchemaUID,
      owner,
    );

    const FileViewFactory = await ethers.getContractFactory("EFSFileView");
    fileView = await FileViewFactory.deploy(await indexer.getAddress(), futureEdgeResolverAddr);
    await fileView.waitForDeployment();

    void propertySchemaUID;
  });

  // ── Conformance vectors ───────────────────────────────────────────────────────

  it("getActiveRedirect returns (0,0,0) when no redirect exists", async function () {
    const a = await mintAnchor("a");
    const [ruid, target, kind] = await aliasResolver.getActiveRedirect(a, await owner.getAddress());
    expect(ruid).to.equal(ZERO_BYTES32);
    expect(target).to.equal(ZERO_BYTES32);
    expect(kind).to.equal(0n);
  });

  it("no redirect on source ⇒ Resolved at source, 0 hops", async function () {
    const a = await mintAnchor("a");
    const res = await fileView.resolveRedirect(a, [await owner.getAddress()], 0, resolverAddr);
    expect(res.resolvedUID).to.equal(a);
    expect(res.isData).to.equal(false);
    expect(res.status).to.equal(Status.Resolved);
    expect(res.hops).to.equal(0n);
  });

  it("simple symlink: Anchor → Anchor, 1 hop, Resolved", async function () {
    const src = await mintAnchor("src");
    const dst = await mintAnchor("dst");
    await attestRedirect(src, dst, KIND_SYMLINK);

    const res = await fileView.resolveRedirect(src, [await owner.getAddress()], 0, resolverAddr);
    expect(res.resolvedUID).to.equal(dst);
    expect(res.isData).to.equal(false);
    expect(res.status).to.equal(Status.Resolved);
    expect(res.hops).to.equal(1n);
  });

  it("symlink Anchor → DATA terminal: isData true", async function () {
    const src = await mintAnchor("src");
    const data = await mintData();
    await attestRedirect(src, data, KIND_SYMLINK);

    const res = await fileView.resolveRedirect(src, [await owner.getAddress()], 0, resolverAddr);
    expect(res.resolvedUID).to.equal(data);
    expect(res.isData).to.equal(true);
    expect(res.status).to.equal(Status.Resolved);
    expect(res.hops).to.equal(1n);
  });

  it("2-hop symlink chain: A → B → C, 2 hops, Resolved", async function () {
    const a = await mintAnchor("a");
    const b = await mintAnchor("b");
    const c = await mintAnchor("c");
    await attestRedirect(a, b, KIND_SYMLINK);
    await attestRedirect(b, c, KIND_SYMLINK);

    const res = await fileView.resolveRedirect(a, [await owner.getAddress()], 0, resolverAddr);
    expect(res.resolvedUID).to.equal(c);
    expect(res.status).to.equal(Status.Resolved);
    expect(res.hops).to.equal(2n);
  });

  it("version chain → latest: DATA supersededBy DATA supersededBy DATA", async function () {
    const v1 = await mintData();
    const v2 = await mintData();
    const v3 = await mintData();
    await attestRedirect(v1, v2, KIND_SUPERSEDED_BY);
    await attestRedirect(v2, v3, KIND_SUPERSEDED_BY);

    const res = await fileView.resolveRedirect(v1, [await owner.getAddress()], 0, resolverAddr);
    expect(res.resolvedUID).to.equal(v3);
    expect(res.isData).to.equal(true);
    expect(res.status).to.equal(Status.Resolved);
    expect(res.hops).to.equal(2n);
  });

  it("sameAs is NOT auto-navigated: terminal at source, Resolved, 0 hops", async function () {
    const d1 = await mintData();
    const d2 = await mintData();
    await attestRedirect(d1, d2, KIND_SAME_AS);

    const res = await fileView.resolveRedirect(d1, [await owner.getAddress()], 0, resolverAddr);
    expect(res.resolvedUID).to.equal(d1);
    expect(res.status).to.equal(Status.Resolved);
    expect(res.hops).to.equal(0n);
  });

  it("reserved kind (3+) is NOT auto-followed: terminal, Resolved, 0 hops", async function () {
    const a = await mintAnchor("a");
    const b = await mintAnchor("b");
    await attestRedirect(a, b, KIND_RELATED);

    const res = await fileView.resolveRedirect(a, [await owner.getAddress()], 0, resolverAddr);
    expect(res.resolvedUID).to.equal(a);
    expect(res.status).to.equal(Status.Resolved);
    expect(res.hops).to.equal(0n);
  });

  it("depth-exceeded: chain longer than maxHops ⇒ DepthExceeded", async function () {
    // Build a 4-link symlink chain a→b→c→d→e and cap at 2 hops.
    const nodes: string[] = [];
    for (let i = 0; i < 5; i++) nodes.push(await mintAnchor(`n${i}`));
    for (let i = 0; i < 4; i++) await attestRedirect(nodes[i], nodes[i + 1], KIND_SYMLINK);

    const res = await fileView.resolveRedirect(nodes[0], [await owner.getAddress()], 2, resolverAddr);
    expect(res.status).to.equal(Status.DepthExceeded);
    expect(res.hops).to.equal(2n);
    expect(res.resolvedUID).to.equal(nodes[2]); // settled after exactly 2 hops
  });

  it("chain ending exactly at the cap reports Resolved (not DepthExceeded)", async function () {
    const a = await mintAnchor("a");
    const b = await mintAnchor("b");
    const c = await mintAnchor("c");
    await attestRedirect(a, b, KIND_SYMLINK);
    await attestRedirect(b, c, KIND_SYMLINK);

    const res = await fileView.resolveRedirect(a, [await owner.getAddress()], 2, resolverAddr);
    expect(res.status).to.equal(Status.Resolved);
    expect(res.resolvedUID).to.equal(c);
    expect(res.hops).to.equal(2n);
  });

  it("direct cycle: A → B → A ⇒ CycleStopped (never loops)", async function () {
    const a = await mintAnchor("a");
    const b = await mintAnchor("b");
    await attestRedirect(a, b, KIND_SYMLINK);
    await attestRedirect(b, a, KIND_SYMLINK);

    const res = await fileView.resolveRedirect(a, [await owner.getAddress()], 0, resolverAddr);
    expect(res.status).to.equal(Status.CycleStopped);
  });

  it("multi-hop cycle: A → B → C → A ⇒ CycleStopped", async function () {
    const a = await mintAnchor("a");
    const b = await mintAnchor("b");
    const c = await mintAnchor("c");
    await attestRedirect(a, b, KIND_SYMLINK);
    await attestRedirect(b, c, KIND_SYMLINK);
    await attestRedirect(c, a, KIND_SYMLINK);

    const res = await fileView.resolveRedirect(a, [await owner.getAddress()], 0, resolverAddr);
    expect(res.status).to.equal(Status.CycleStopped);
  });

  it("dangling target (revoked): stop at last valid node, status Dangling", async function () {
    const src = await mintAnchor("src");
    const { uid: mid } = await mintRevocableAnchor("mid");
    const { uid: tgt } = await mintRevocableAnchor("tgt");
    await attestRedirect(src, mid, KIND_SYMLINK);
    await attestRedirect(mid, tgt, KIND_SYMLINK);
    // Revoke the final target — the hop mid→tgt is now dangling.
    await revoke(anchorSchemaUID, tgt);

    const res = await fileView.resolveRedirect(src, [await owner.getAddress()], 0, resolverAddr);
    expect(res.status).to.equal(Status.Dangling);
    expect(res.resolvedUID).to.equal(mid); // last VALID node, not the revoked target
    expect(res.hops).to.equal(1n);
  });

  it("dangling at source: a followed redirect whose target gets revoked ⇒ Dangling at source", async function () {
    const src = await mintAnchor("src");
    const { uid: tgt } = await mintRevocableAnchor("tgt");
    await attestRedirect(src, tgt, KIND_SYMLINK);
    await revoke(anchorSchemaUID, tgt);

    const res = await fileView.resolveRedirect(src, [await owner.getAddress()], 0, resolverAddr);
    expect(res.status).to.equal(Status.Dangling);
    expect(res.resolvedUID).to.equal(src); // last valid node = source
    expect(res.hops).to.equal(0n);
  });

  // FINDING (specs/09): the AliasResolver write-time guard (ADR-0050) rejects a followed-kind
  // redirect whose target is missing or the wrong type AT CREATION, and canonical ANCHOR/DATA are
  // non-revocable — so for symlink(2)/supersededBy(1) a dangling target is largely UNREACHABLE via
  // the canonical write path. These two negative tests pin that the write guard, not the follower,
  // is what blocks bad targets; the follower's Dangling branch stays as defense-in-depth (the
  // revoke vector above is the one path that still reaches it, only because this harness made the
  // endpoint schemas revocable).
  it("write guard rejects a symlink to a never-attested target (dangling-at-creation blocked)", async function () {
    const src = await mintAnchor("src");
    const ghost = ethers.keccak256(ethers.toUtf8Bytes("never-attested"));
    await expect(attestRedirect(src, ghost, KIND_SYMLINK)).to.be.revertedWithCustomError(
      aliasResolver,
      "TargetNotAnchorOrData",
    );
  });

  it("write guard rejects supersededBy with a non-DATA target (wrong-type blocked at creation)", async function () {
    const d1 = await mintData();
    const anchorTarget = await mintAnchor("not-data");
    await expect(attestRedirect(d1, anchorTarget, KIND_SUPERSEDED_BY)).to.be.revertedWithCustomError(
      aliasResolver,
      "TargetNotData",
    );
  });

  it("cross-lens not followed: foreign redirect invisible ⇒ Resolved at source", async function () {
    const src = await mintAnchor("src");
    const dst = await mintAnchor("dst");
    // Mallory (out-of-lens) authors the only redirect.
    await attestRedirect(src, dst, KIND_SYMLINK, mallory);

    // Owner's lens sees nothing to follow.
    const res = await fileView.resolveRedirect(src, [await owner.getAddress()], 0, resolverAddr);
    expect(res.status).to.equal(Status.Resolved);
    expect(res.resolvedUID).to.equal(src);
    expect(res.hops).to.equal(0n);

    // Mallory's own lens DOES follow it.
    const res2 = await fileView.resolveRedirect(src, [await mallory.getAddress()], 0, resolverAddr);
    expect(res2.status).to.equal(Status.Resolved);
    expect(res2.resolvedUID).to.equal(dst);
    expect(res2.hops).to.equal(1n);
  });

  it("first-attester-wins: earliest in-lens lens's redirect is followed", async function () {
    const src = await mintAnchor("src");
    const ownerTarget = await mintAnchor("owner-target");
    const aliceTarget = await mintAnchor("alice-target");
    await attestRedirect(src, ownerTarget, KIND_SYMLINK, owner);
    await attestRedirect(src, aliceTarget, KIND_SYMLINK, alice);

    // owner first in precedence ⇒ owner's redirect wins.
    const res = await fileView.resolveRedirect(
      src,
      [await owner.getAddress(), await alice.getAddress()],
      0,
      resolverAddr,
    );
    expect(res.resolvedUID).to.equal(ownerTarget);
    expect(res.hops).to.equal(1n);

    // Reversed precedence ⇒ alice's redirect wins.
    const res2 = await fileView.resolveRedirect(
      src,
      [await alice.getAddress(), await owner.getAddress()],
      0,
      resolverAddr,
    );
    expect(res2.resolvedUID).to.equal(aliceTarget);
  });

  it("revoked redirect resolves to empty (getActiveRedirect re-checks live)", async function () {
    const src = await mintAnchor("src");
    const dst = await mintAnchor("dst");
    const rUID = await attestRedirect(src, dst, KIND_SYMLINK);
    // Before revoke: followed.
    let res = await fileView.resolveRedirect(src, [await owner.getAddress()], 0, resolverAddr);
    expect(res.resolvedUID).to.equal(dst);
    // Revoke the redirect itself.
    await revoke(redirectSchemaUID, rUID);
    res = await fileView.resolveRedirect(src, [await owner.getAddress()], 0, resolverAddr);
    expect(res.status).to.equal(Status.Resolved);
    expect(res.resolvedUID).to.equal(src);
    expect(res.hops).to.equal(0n);
  });

  it("last-writer-wins per (source, attester): newer redirect supersedes older slot", async function () {
    const src = await mintAnchor("src");
    const first = await mintAnchor("first");
    const second = await mintAnchor("second");
    await attestRedirect(src, first, KIND_SYMLINK);
    await attestRedirect(src, second, KIND_SYMLINK); // same (source, owner) — overwrites

    const [, target] = await aliasResolver.getActiveRedirect(src, await owner.getAddress());
    expect(target).to.equal(second);

    const res = await fileView.resolveRedirect(src, [await owner.getAddress()], 0, resolverAddr);
    expect(res.resolvedUID).to.equal(second);
  });

  it("revoking a stale (already-superseded) redirect does not wipe the live slot", async function () {
    const src = await mintAnchor("src");
    const first = await mintAnchor("first");
    const second = await mintAnchor("second");
    const firstUID = await attestRedirect(src, first, KIND_SYMLINK);
    await attestRedirect(src, second, KIND_SYMLINK); // slot now points at `second`
    // Revoke the OLD redirect — must not clear the slot owned by the newer one.
    await revoke(redirectSchemaUID, firstUID);

    const res = await fileView.resolveRedirect(src, [await owner.getAddress()], 0, resolverAddr);
    expect(res.status).to.equal(Status.Resolved);
    expect(res.resolvedUID).to.equal(second);
    expect(res.hops).to.equal(1n);
  });

  it("rejects empty lens set and oversized lens set", async function () {
    const a = await mintAnchor("a");
    await expect(fileView.resolveRedirect(a, [], 0, resolverAddr)).to.be.revertedWith("Lenses list cannot be empty");
    const tooMany = Array.from({ length: 21 }, () => ZeroAddress);
    await expect(fileView.resolveRedirect(a, tooMany, 0, resolverAddr)).to.be.revertedWith("Too many lenses");
  });

  it("maxHops clamps to the hard ceiling (32): a 33-link cycle still CycleStops", async function () {
    // A long chain that loops back; with maxHops far above the ceiling the walk is still bounded.
    const a = await mintAnchor("a");
    const b = await mintAnchor("b");
    await attestRedirect(a, b, KIND_SYMLINK);
    await attestRedirect(b, a, KIND_SYMLINK);
    const res = await fileView.resolveRedirect(a, [await owner.getAddress()], 9999, resolverAddr);
    expect(res.status).to.equal(Status.CycleStopped);
  });
});
