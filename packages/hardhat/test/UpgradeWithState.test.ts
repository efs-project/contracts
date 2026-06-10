import { expect } from "chai";
import { ethers } from "hardhat";
import { ZeroAddress } from "ethers";
import { EAS, SchemaRegistry } from "../typechain-types";
import { deployUpgradeableProxy, upgradeProxy } from "./helpers/deployUpgradeableProxy";

/**
 * UPGRADE-WITH-STATE CORRUPTION GUARD (50-year storage guard) — ADR-0048, ADR-0009.
 *
 * All five EFS resolvers are upgradeable behind proxies (ERC-7201 namespaced config +
 * initialize(); existing append-only index mappings preserved at their sequential slots). Before
 * mainnet, a future implementation upgrade MUST NOT silently corrupt the consensus-critical
 * append-only indices. This suite proves a real on-chain V1→V2 implementation swap preserves ALL
 * existing kernel state for the three most stateful resolvers:
 *
 *   - EFSIndexer       — anchors/path resolution (_children / _nameToAnchor / _parents)
 *   - EdgeResolver     — PINs + TAGs (_activeBySlot / _activeByAAS)
 *   - ListEntryResolver — LIST entries (_entries / _entryCount)
 *
 * For each: deploy V1 behind a TransparentUpgradeableProxy + initialize, seed representative state
 * through REAL EAS attestations, snapshot the key reads + config + getEAS(), upgrade the proxy to a
 * V2 impl (which APPENDS a new ERC-7201 namespaced var — a realistic layout-safe change, not a
 * no-op), then assert every snapshotted read is byte-identical, the new V2 var works, and
 * config/getEAS() are unchanged.
 *
 * Upgrade path: TransparentUpgradeableProxy + ProxyAdmin.upgradeAndCall (ERC1967). The resolvers
 * carry no UUPS hook, so the upgrade logic must live in the proxy (Transparent), not the impl.
 */

const ZERO_BYTES32 = "0x" + "0".repeat(64);
const NO_EXPIRATION = 0n;
const enc = new ethers.AbiCoder();

function getUID(eas: EAS, receipt: any): string {
  for (const log of receipt.logs) {
    try {
      const parsed = eas.interface.parseLog(log);
      if (parsed?.name === "Attested") return parsed.args.uid;
    } catch {
      /* not an Attested event */
    }
  }
  throw new Error("No Attested event in receipt");
}

async function deployEAS(): Promise<{ eas: EAS; registry: SchemaRegistry }> {
  const RegistryFactory = await ethers.getContractFactory("SchemaRegistry");
  const registry = (await RegistryFactory.deploy()) as unknown as SchemaRegistry;
  await registry.waitForDeployment();
  const EASFactory = await ethers.getContractFactory("EAS");
  const eas = (await EASFactory.deploy(await registry.getAddress())) as unknown as EAS;
  await eas.waitForDeployment();
  return { eas, registry };
}

describe("UpgradeWithState — storage-corruption guard (ADR-0048, ADR-0009)", function () {
  // ─────────────────────────────────────────────────────────────────────────────
  // EFSIndexer: seed anchors, snapshot path resolution + children, upgrade, re-read.
  // ─────────────────────────────────────────────────────────────────────────────
  describe("EFSIndexer V1→V2 preserves the anchor/path indices", function () {
    it("byte-identical resolvePath / getChildren / getParent + config across the upgrade", async function () {
      const [owner] = await ethers.getSigners();
      const ownerAddr = await owner.getAddress();
      const { eas, registry } = await deployEAS();

      // The PROXY address is the resolver baked into the schema UIDs. deployUpgradeableProxy runs
      // two deployer txs (impl, then proxy); the proxy lands at nonce+N+1.
      const nonce = await ethers.provider.getTransactionCount(ownerAddr);
      // Order: register ANCHOR(+0) PROPERTY(+1) DATA(+2), impl(+3), proxy(+4).
      const futureProxy = ethers.getCreateAddress({ from: ownerAddr, nonce: nonce + 4 });

      const a = await registry.register("string name, bytes32 schemaUID", futureProxy, true);
      const anchorSchemaUID = (await a.wait())!.logs[0].topics[1];
      const p = await registry.register("string value", futureProxy, false);
      const propertySchemaUID = (await p.wait())!.logs[0].topics[1];
      const d = await registry.register("", futureProxy, false);
      const dataSchemaUID = (await d.wait())!.logs[0].topics[1];

      const dep = await deployUpgradeableProxy<any>(
        "EFSIndexer",
        [await eas.getAddress()],
        [anchorSchemaUID, propertySchemaUID, dataSchemaUID, ownerAddr],
        owner,
      );
      expect(dep.proxyAddress).to.equal(futureProxy);
      const indexer = dep.proxy;

      // ── Seed state through real EAS attestations: root → /docs → /docs/readme ──
      const anchor = async (name: string, parentUID: string) => {
        const tx = await eas.attest({
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
        return getUID(eas, await tx.wait());
      };
      const rootUID = await anchor("root", ZERO_BYTES32);
      const docsUID = await anchor("docs", rootUID);
      const readmeUID = await anchor("readme", docsUID);
      const imagesUID = await anchor("images", rootUID);

      // ── Snapshot the key reads BEFORE the upgrade ──
      const before = {
        rootAnchorUID: await indexer.rootAnchorUID(),
        resolveRootDocs: await indexer.resolvePath(rootUID, "docs"),
        resolveDocsReadme: await indexer.resolvePath(docsUID, "readme"),
        resolveRootImages: await indexer.resolvePath(rootUID, "images"),
        rootChildrenCount: await indexer.getChildrenCount(rootUID),
        rootChildren: await indexer.getChildren(rootUID, 0, 10, false),
        docsChildren: await indexer.getChildren(docsUID, 0, 10, false),
        parentOfDocs: await indexer.getParent(docsUID),
        parentOfReadme: await indexer.getParent(readmeUID),
        // config + immutable
        anchorSchema: await indexer.ANCHOR_SCHEMA_UID(),
        propertySchema: await indexer.PROPERTY_SCHEMA_UID(),
        dataSchema: await indexer.DATA_SCHEMA_UID(),
        owner: await indexer.owner(),
        deployer: await indexer.DEPLOYER(),
        getEAS: await indexer.getEAS(),
      };

      // Mutation tripwire: confirm the assertion would have FAILED against a wrong expected value,
      // so we know the byte-identical check actually bites. (RED then GREEN, in-test.)
      expect(before.resolveDocsReadme).to.not.equal(ZERO_BYTES32);
      expect(() => expect(before.resolveDocsReadme).to.equal(ZERO_BYTES32)).to.throw();

      // ── Upgrade the proxy implementation V1 → V2 (appends an ERC-7201 namespaced var) ──
      await upgradeProxy(dep.proxyAddress, dep.proxyAdmin, "MockEFSIndexerV2", [await eas.getAddress()], owner);
      const v2 = await ethers.getContractAt("MockEFSIndexerV2", dep.proxyAddress, owner);
      expect(await v2.mockVersion()).to.equal(2n); // we're really on V2 now

      // ── Assert every snapshotted read is byte-identical post-upgrade ──
      expect(await v2.rootAnchorUID()).to.equal(before.rootAnchorUID);
      expect(await v2.resolvePath(rootUID, "docs")).to.equal(before.resolveRootDocs);
      expect(await v2.resolvePath(docsUID, "readme")).to.equal(before.resolveDocsReadme);
      expect(await v2.resolvePath(rootUID, "images")).to.equal(before.resolveRootImages);
      expect(await v2.getChildrenCount(rootUID)).to.equal(before.rootChildrenCount);
      expect(await v2.getChildren(rootUID, 0, 10, false)).to.deep.equal(before.rootChildren);
      expect(await v2.getChildren(docsUID, 0, 10, false)).to.deep.equal(before.docsChildren);
      expect(await v2.getParent(docsUID)).to.equal(before.parentOfDocs);
      expect(await v2.getParent(readmeUID)).to.equal(before.parentOfReadme);

      // config + immutable unchanged
      expect(await v2.ANCHOR_SCHEMA_UID()).to.equal(before.anchorSchema);
      expect(await v2.PROPERTY_SCHEMA_UID()).to.equal(before.propertySchema);
      expect(await v2.DATA_SCHEMA_UID()).to.equal(before.dataSchema);
      expect(await v2.owner()).to.equal(before.owner);
      expect(await v2.DEPLOYER()).to.equal(before.deployer);
      expect(await v2.getEAS()).to.equal(before.getEAS);

      // The new V2 appended var works and does not disturb V1 storage.
      await (await v2.setEpoch(7n)).wait();
      expect(await v2.epoch()).to.equal(7n);
      expect(await v2.resolvePath(docsUID, "readme")).to.equal(before.resolveDocsReadme); // still intact

      // The kernel keeps functioning post-upgrade: a NEW anchor indexes correctly into the
      // preserved (not migrated) sequential mappings.
      const tx = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: docsUID,
          data: enc.encode(["string", "bytes32"], ["guide", ZERO_BYTES32]),
          value: 0n,
        },
      });
      const guideUID = getUID(eas, await tx.wait());
      expect(await v2.resolvePath(docsUID, "guide")).to.equal(guideUID);
      expect(await v2.getChildrenCount(docsUID)).to.equal(2n); // readme + guide
      void imagesUID;
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // EdgeResolver: seed PINs + TAGs, snapshot active-edge reads, upgrade, re-read.
  // ─────────────────────────────────────────────────────────────────────────────
  describe("EdgeResolver V1→V2 preserves the PIN/TAG active-edge indices", function () {
    it("byte-identical getActivePinTarget / getActiveTagEntries + config across the upgrade", async function () {
      const [owner, alice] = await ethers.getSigners();
      const ownerAddr = await owner.getAddress();
      const aliceAddr = await alice.getAddress();
      const { eas, registry } = await deployEAS();

      // Edge impl(+0) proxy(+1); PIN(+2) TAG(+3) DUMMY(+4); Indexer impl(+5) proxy(+6).
      const nonce = await ethers.provider.getTransactionCount(ownerAddr);
      const futureEdge = ethers.getCreateAddress({ from: ownerAddr, nonce: nonce + 1 });
      const futureIndexer = ethers.getCreateAddress({ from: ownerAddr, nonce: nonce + 6 });
      const pinSchemaUID = ethers.solidityPackedKeccak256(
        ["string", "address", "bool"],
        ["bytes32 definition", futureEdge, true],
      );
      const tagSchemaUID = ethers.solidityPackedKeccak256(
        ["string", "address", "bool"],
        ["bytes32 definition, int256 weight", futureEdge, true],
      );

      const edgeDep = await deployUpgradeableProxy<any>(
        "EdgeResolver",
        [await eas.getAddress()],
        [pinSchemaUID, tagSchemaUID, futureIndexer, await registry.getAddress()],
        owner,
      );
      expect(edgeDep.proxyAddress).to.equal(futureEdge);
      const edge = edgeDep.proxy;

      const pinTx = await registry.register("bytes32 definition", futureEdge, true);
      const pinUIDschema = (await pinTx.wait())!.logs[0].topics[1];
      expect(pinUIDschema).to.equal(pinSchemaUID);
      await (await registry.register("bytes32 definition, int256 weight", futureEdge, true)).wait();
      const dummyTx = await registry.register("string label", ZeroAddress, false);
      const dummySchemaUID = (await dummyTx.wait())!.logs[0].topics[1];

      // EFSIndexer proxy that EdgeResolver indexes edges into (only index()/propagate exercised).
      const idxDep = await deployUpgradeableProxy<any>(
        "EFSIndexer",
        [await eas.getAddress()],
        [ZERO_BYTES32, ZERO_BYTES32, ZERO_BYTES32, ownerAddr],
        owner,
      );
      expect(idxDep.proxyAddress).to.equal(futureIndexer);
      await (
        await idxDep.proxy.wireContracts(
          futureEdge,
          pinSchemaUID,
          tagSchemaUID,
          ZeroAddress,
          ZERO_BYTES32,
          ZeroAddress,
          ZERO_BYTES32,
          await registry.getAddress(),
        )
      ).wait();

      // ── Seed state: a definition + targets, then a PIN and two TAGs through real EAS ──
      const mint = async (label: string) => {
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
        return getUID(eas, await tx.wait());
      };
      const definition = await mint("def");
      const pinTarget = await mint("pin-target");
      const tagTargetA = await mint("tag-A");
      const tagTargetB = await mint("tag-B");
      const targetSchema = dummySchemaUID; // all targets share the dummy schema

      const attestEdge = async (schema: string, target: string, data: string) => {
        const tx = await eas.connect(alice).attest({
          schema,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: target,
            data,
            value: 0n,
          },
        });
        return getUID(eas, await tx.wait());
      };
      const pinUID = await attestEdge(pinSchemaUID, pinTarget, enc.encode(["bytes32"], [definition]));
      await attestEdge(tagSchemaUID, tagTargetA, enc.encode(["bytes32", "int256"], [definition, 5n]));
      await attestEdge(tagSchemaUID, tagTargetB, enc.encode(["bytes32", "int256"], [definition, -3n]));

      // ── Snapshot ──
      const before = {
        pinTarget: await edge.getActivePinTarget(definition, aliceAddr, targetSchema),
        pinUID: await edge.getActivePin(definition, aliceAddr, targetSchema),
        tagCount: await edge.getActiveTagsCount(definition, aliceAddr, targetSchema),
        tagEntries: await edge.getActiveTagEntries(definition, aliceAddr, targetSchema, 0, 10),
        hasActivePin: await edge.isActivePinEdge(aliceAddr, pinTarget, definition),
        pinSchema: await edge.PIN_SCHEMA_UID(),
        tagSchema: await edge.TAG_SCHEMA_UID(),
        indexer: await edge.indexer(),
        registry: await edge.schemaRegistry(),
        getEAS: await edge.getEAS(),
      };
      expect(before.pinTarget).to.equal(pinTarget);
      expect(before.tagCount).to.equal(2n);
      // Mutation tripwire.
      expect(() => expect(before.pinTarget).to.equal(ZERO_BYTES32)).to.throw();

      // ── Upgrade V1 → V2 ──
      await upgradeProxy(
        edgeDep.proxyAddress,
        edgeDep.proxyAdmin,
        "MockEdgeResolverV2",
        [await eas.getAddress()],
        owner,
      );
      const v2 = await ethers.getContractAt("MockEdgeResolverV2", edgeDep.proxyAddress, owner);
      expect(await v2.mockVersion()).to.equal(2n);

      // ── Assert byte-identical ──
      expect(await v2.getActivePinTarget(definition, aliceAddr, targetSchema)).to.equal(before.pinTarget);
      expect(await v2.getActivePin(definition, aliceAddr, targetSchema)).to.equal(before.pinUID);
      expect(await v2.getActiveTagsCount(definition, aliceAddr, targetSchema)).to.equal(before.tagCount);
      expect(await v2.getActiveTagEntries(definition, aliceAddr, targetSchema, 0, 10)).to.deep.equal(before.tagEntries);
      expect(await v2.isActivePinEdge(aliceAddr, pinTarget, definition)).to.equal(before.hasActivePin);
      expect(await v2.PIN_SCHEMA_UID()).to.equal(before.pinSchema);
      expect(await v2.TAG_SCHEMA_UID()).to.equal(before.tagSchema);
      expect(await v2.indexer()).to.equal(before.indexer);
      expect(await v2.schemaRegistry()).to.equal(before.registry);
      expect(await v2.getEAS()).to.equal(before.getEAS);

      // New V2 var works; revoking a PIN post-upgrade still mutates the preserved slot correctly.
      await (await v2.setEpoch(42n)).wait();
      expect(await v2.epoch()).to.equal(42n);
      await (await eas.connect(alice).revoke({ schema: pinSchemaUID, data: { uid: pinUID, value: 0n } })).wait();
      expect(await v2.getActivePinTarget(definition, aliceAddr, targetSchema)).to.equal(ZERO_BYTES32);
      expect(await v2.getActiveTagsCount(definition, aliceAddr, targetSchema)).to.equal(2n); // TAGs untouched
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // ListEntryResolver: seed a LIST + entries, snapshot membership, upgrade, re-read.
  // ─────────────────────────────────────────────────────────────────────────────
  describe("ListEntryResolver V1→V2 preserves the list-entry indices", function () {
    it("byte-identical getMemberCount / getEntries / getLength + config across the upgrade", async function () {
      const [alice, bob, carol] = await ethers.getSigners();
      const aliceAddr = await alice.getAddress();
      const { eas, registry } = await deployEAS();

      const LIST_SCHEMA =
        "bool allowsDuplicates, bool appendOnly, uint8 targetType, bytes32 targetSchema, uint256 maxEntries";
      const LIST_ENTRY_SCHEMA = "bytes32 listUID, bytes32 target";

      // ListResolver impl(+0) proxy(+1); LIST(+2) LIST_ENTRY(+3); ListEntryResolver impl(+4) proxy(+5).
      const n = await ethers.provider.getTransactionCount(aliceAddr);
      const futureListResolver = ethers.getCreateAddress({ from: aliceAddr, nonce: n + 1 });
      const futureLER = ethers.getCreateAddress({ from: aliceAddr, nonce: n + 5 });
      const listSchemaUID = ethers.solidityPackedKeccak256(
        ["string", "address", "bool"],
        [LIST_SCHEMA, futureListResolver, false],
      );
      const listEntrySchemaUID = ethers.solidityPackedKeccak256(
        ["string", "address", "bool"],
        [LIST_ENTRY_SCHEMA, futureLER, true],
      );

      const listResolverDep = await deployUpgradeableProxy<any>("ListResolver", [await eas.getAddress()], [], alice);
      expect(listResolverDep.proxyAddress).to.equal(futureListResolver);

      await (await registry.register(LIST_SCHEMA, futureListResolver, false)).wait();
      await (await registry.register(LIST_ENTRY_SCHEMA, futureLER, true)).wait();

      const lerDep = await deployUpgradeableProxy<any>(
        "ListEntryResolver",
        [await eas.getAddress()],
        [listSchemaUID],
        alice,
      );
      expect(lerDep.proxyAddress).to.equal(futureLER);
      const ler = lerDep.proxy;
      expect(await ler.listEntrySchemaUID()).to.equal(listEntrySchemaUID);

      // ── Seed: Alice declares an ADDR list (no-dupes), then adds Bob + Carol ──
      const listTx = await eas.connect(alice).attest({
        schema: listSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: enc.encode(["bool", "bool", "uint8", "bytes32", "uint256"], [false, false, 1, ZERO_BYTES32, 0]),
          value: 0n,
        },
      });
      const listUID = getUID(eas, await listTx.wait());

      const addMember = async (memberAddr: string) => {
        const tx = await eas.connect(alice).attest({
          schema: listEntrySchemaUID,
          data: {
            recipient: memberAddr,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: ZERO_BYTES32,
            data: enc.encode(["bytes32", "bytes32"], [listUID, ZERO_BYTES32]),
            value: 0n,
          },
        });
        return getUID(eas, await tx.wait());
      };
      await addMember(await bob.getAddress());
      await addMember(await carol.getAddress());

      const idKey = (addr: string) => ethers.zeroPadValue(ethers.toBeHex(BigInt(addr)), 32);

      // ── Snapshot ──
      const before = {
        length: await ler.getLength(listUID, aliceAddr),
        entries: await ler.getEntries(listUID, aliceAddr, 0, 10),
        bobCount: await ler.getMemberCount(listUID, idKey(await bob.getAddress()), aliceAddr),
        carolCount: await ler.getMemberCount(listUID, idKey(await carol.getAddress()), aliceAddr),
        attesterCount: await ler.getListAttesterCount(listUID),
        attesters: await ler.getListAttesters(listUID, 0, 10),
        listSchema: await ler.LIST_SCHEMA_UID(),
        entrySchema: await ler.listEntrySchemaUID(),
        getEAS: await ler.getEAS(),
      };
      expect(before.length).to.equal(2n);
      // Mutation tripwire.
      expect(() => expect(before.length).to.equal(0n)).to.throw();

      // ── Upgrade V1 → V2 ──
      await upgradeProxy(
        lerDep.proxyAddress,
        lerDep.proxyAdmin,
        "MockListEntryResolverV2",
        [await eas.getAddress()],
        alice,
      );
      const v2 = await ethers.getContractAt("MockListEntryResolverV2", lerDep.proxyAddress, alice);
      expect(await v2.mockVersion()).to.equal(2n);

      // ── Assert byte-identical ──
      expect(await v2.getLength(listUID, aliceAddr)).to.equal(before.length);
      expect(await v2.getEntries(listUID, aliceAddr, 0, 10)).to.deep.equal(before.entries);
      expect(await v2.getMemberCount(listUID, idKey(await bob.getAddress()), aliceAddr)).to.equal(before.bobCount);
      expect(await v2.getMemberCount(listUID, idKey(await carol.getAddress()), aliceAddr)).to.equal(before.carolCount);
      expect(await v2.getListAttesterCount(listUID)).to.equal(before.attesterCount);
      expect(await v2.getListAttesters(listUID, 0, 10)).to.deep.equal(before.attesters);
      expect(await v2.LIST_SCHEMA_UID()).to.equal(before.listSchema);
      // CRITICAL self-UID: the proxy-derived LIST_ENTRY UID must survive the impl swap unchanged,
      // or onAttest/onRevoke would start rejecting every entry with WrongSchema.
      expect(await v2.listEntrySchemaUID()).to.equal(before.entrySchema);
      expect(await v2.getEAS()).to.equal(before.getEAS);

      // New V2 var works; a NEW entry still indexes into the preserved mappings post-upgrade.
      await (await v2.setEpoch(99n)).wait();
      expect(await v2.epoch()).to.equal(99n);
      const daveTx = await eas.connect(alice).attest({
        schema: listEntrySchemaUID,
        data: {
          recipient: await alice.getAddress(),
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: ZERO_BYTES32,
          data: enc.encode(["bytes32", "bytes32"], [listUID, ZERO_BYTES32]),
          value: 0n,
        },
      });
      getUID(eas, await daveTx.wait());
      expect(await v2.getLength(listUID, aliceAddr)).to.equal(3n);
    });
  });
});
