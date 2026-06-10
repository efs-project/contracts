import { expect } from "chai";
import { ethers } from "hardhat";
import { MockUpgradeableResolver } from "../typechain-types";

// NOTE: this suite deploys the proxy by hand via OpenZeppelin's ERC1967Proxy rather
// than the hardhat-upgrades plugin. `@openzeppelin/hardhat-upgrades` is pinned to the
// Hardhat-2 line (3.9.1) and IS wired into hardhat.config — but its `validateUpgrade`
// fights our deliberate pattern (a `SchemaResolver(eas)` immutable constructor arg +
// `_disableInitializers()`), so we deploy proxies manually and gate storage-layout via
// a committed snapshot instead (see test/helpers/storageLayout.ts). Manual ERC1967Proxy
// has no plugin dependency and is the clean choice here. See decisions.md.

// A stand-in EAS address. The base resolver only stores it as an immutable and
// exposes it via getEAS(); no EAS calls are made in these tests, so any non-zero
// address works (SchemaResolver's constructor rejects the zero address).
const FAKE_EAS = "0x000000000000000000000000000000000000EA5E";

describe("EFSUpgradeableResolver", function () {
  async function deployImpl(): Promise<MockUpgradeableResolver> {
    const Factory = await ethers.getContractFactory("MockUpgradeableResolver");
    const impl = (await Factory.deploy(FAKE_EAS)) as unknown as MockUpgradeableResolver;
    await impl.waitForDeployment();
    return impl;
  }

  // Deploy the impl, then an ERC1967Proxy pointed at it with initialize(v) calldata,
  // and return the proxy typed as the resolver (so we call through the proxy).
  async function deployProxy(v: bigint): Promise<MockUpgradeableResolver> {
    const impl = await deployImpl();
    const initData = impl.interface.encodeFunctionData("initialize", [v]);

    const ProxyFactory = await ethers.getContractFactory("TestERC1967Proxy");
    const proxy = await ProxyFactory.deploy(await impl.getAddress(), initData);
    await proxy.waitForDeployment();

    return (await ethers.getContractAt(
      "MockUpgradeableResolver",
      await proxy.getAddress(),
    )) as unknown as MockUpgradeableResolver;
  }

  it("locks the implementation's initializer (constructor ran _disableInitializers)", async function () {
    const impl = await deployImpl();
    await expect(impl.initialize(42n)).to.be.revertedWithCustomError(impl, "InvalidInitialization");
  });

  it("initializes once behind a proxy, then locks", async function () {
    const proxy = await deployProxy(123n);

    expect(await proxy.value()).to.equal(123n);

    await expect(proxy.initialize(456n)).to.be.revertedWithCustomError(proxy, "InvalidInitialization");
    // Value is unchanged by the rejected re-init.
    expect(await proxy.value()).to.equal(123n);
  });

  it("exposes the constructor EAS via getEAS() through the proxy", async function () {
    const proxy = await deployProxy(1n);
    expect(await proxy.getEAS()).to.equal(ethers.getAddress(FAKE_EAS));
  });
});
