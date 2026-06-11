import { expect } from "chai";
import { ethers } from "hardhat";
import { EAS, SchemaRegistry } from "../typechain-types";
import { deployUpgradeableProxy, upgradeProxy } from "./helpers/deployUpgradeableProxy";

/**
 * MIRRORRESOLVER UPGRADE-WITH-STATE GUARD (50-year storage guard) — ADR-0048, ADR-0009.
 *
 * MirrorResolver is upgradeable behind a TransparentUpgradeableProxy (its PROXY address is the EAS
 * resolver baked into the MIRROR schema UID). It carries load-bearing sequential storage —
 * `transportsAnchorUID` at slot 0 — plus the `efs.mirror.config` ERC-7201 namespaced `indexer`
 * reference, both written once at deploy/wire time. A future implementation that moved or retyped the
 * transports anchor slot would silently break MIRROR validation (`_isDescendantOfTransports`) without
 * any state-preservation check catching it. This complements the static StorageLayout.gate snapshot:
 * the gate proves the layout slots don't move; this proves a REAL V1→V2 impl swap preserves the values.
 *
 * Scenario: deploy MirrorResolver V1 behind the proxy + initialize(indexer, owner), set
 * transportsAnchorUID via the one-shot setter, snapshot transportsAnchorUID/indexer()/getEAS(), upgrade
 * the proxy to MockMirrorResolverV2 (a layout-safe append of one ERC-7201 var), then assert every
 * snapshotted read survives byte-identical, the appended V2 var works, and the one-shot setter still
 * rejects a second call after the upgrade (its `already set` guard reads the preserved slot 0).
 *
 * Upgrade path: TransparentUpgradeableProxy + ProxyAdmin.upgradeAndCall (ERC1967), same as
 * test/UpgradeWithState.test.ts — MirrorResolver carries no UUPS hook, so the upgrade logic lives in
 * the proxy.
 */

const ZERO_BYTES32 = "0x" + "0".repeat(64);

async function deployEAS(): Promise<{ eas: EAS; registry: SchemaRegistry }> {
  const RegistryFactory = await ethers.getContractFactory("SchemaRegistry");
  const registry = (await RegistryFactory.deploy()) as unknown as SchemaRegistry;
  await registry.waitForDeployment();
  const EASFactory = await ethers.getContractFactory("EAS");
  const eas = (await EASFactory.deploy(await registry.getAddress())) as unknown as EAS;
  await eas.waitForDeployment();
  return { eas, registry };
}

describe("MirrorResolver V1→V2 — storage-corruption guard (ADR-0048, ADR-0009)", function () {
  it("preserves transportsAnchorUID / indexer() / getEAS() and the one-shot setter across the upgrade", async function () {
    const [owner] = await ethers.getSigners();
    const ownerAddr = await owner.getAddress();
    const { eas } = await deployEAS();

    // The `indexer` partner reference is only read back via indexer() in this test (we exercise the
    // setter + getters + config preservation, not onAttest's path-walk), so a stable placeholder
    // address is sufficient. transportsAnchorUID is the load-bearing sequential slot under test.
    const indexerAddr = ethers.getAddress("0x000000000000000000000000000000000000beef");

    const dep = await deployUpgradeableProxy<any>(
      "MirrorResolver",
      [await eas.getAddress()],
      [indexerAddr, ownerAddr],
      owner,
    );
    const mirror = dep.proxy;

    // ── Set the one-shot transports anchor and snapshot the load-bearing reads BEFORE the upgrade ──
    const transportsUID = ethers.keccak256(ethers.toUtf8Bytes("transports-anchor"));
    await (await mirror.setTransportsAnchor(transportsUID)).wait();

    const before = {
      transportsAnchorUID: await mirror.transportsAnchorUID(),
      indexer: await mirror.indexer(),
      owner: await mirror.owner(),
      getEAS: await mirror.getEAS(),
    };
    expect(before.transportsAnchorUID).to.equal(transportsUID);
    expect(before.indexer).to.equal(indexerAddr);
    // Mutation tripwire: confirm the byte-identical assertion would actually bite.
    expect(() => expect(before.transportsAnchorUID).to.equal(ZERO_BYTES32)).to.throw();

    // The one-shot setter already rejects a second call on V1 (sanity before the upgrade).
    await expect(mirror.setTransportsAnchor(transportsUID)).to.be.revertedWith("already set");

    // ── Upgrade the proxy implementation V1 → V2 (appends an ERC-7201 namespaced var) ──
    await upgradeProxy(dep.proxyAddress, dep.proxyAdmin, "MockMirrorResolverV2", [await eas.getAddress()], owner);
    const v2 = await ethers.getContractAt("MockMirrorResolverV2", dep.proxyAddress, owner);
    expect(await v2.mockVersion()).to.equal(2n); // we're really on V2 now

    // ── Assert every snapshotted read is byte-identical post-upgrade ──
    expect(await v2.transportsAnchorUID()).to.equal(before.transportsAnchorUID);
    expect(await v2.indexer()).to.equal(before.indexer);
    expect(await v2.owner()).to.equal(before.owner);
    expect(await v2.getEAS()).to.equal(before.getEAS);

    // The appended V2 var works and does not disturb the preserved slot 0.
    await (await v2.setEpoch(7n)).wait();
    expect(await v2.epoch()).to.equal(7n);
    expect(await v2.transportsAnchorUID()).to.equal(before.transportsAnchorUID); // still intact

    // ── The one-shot setter still rejects a second call AFTER the upgrade ──
    // Its `already set` guard reads the preserved slot-0 transportsAnchorUID; if the slot had moved or
    // been cleared by the impl swap, this would wrongly succeed (re-opening a frozen one-shot setter).
    await expect(v2.setTransportsAnchor(transportsUID)).to.be.revertedWith("already set");
    // Even a different UID is rejected — the slot is non-zero, so the setter is permanently closed.
    await expect(v2.setTransportsAnchor(ethers.keccak256(ethers.toUtf8Bytes("other")))).to.be.revertedWith(
      "already set",
    );
  });
});
