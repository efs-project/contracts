import { expect } from "chai";
import { ethers } from "hardhat";
import { MockUpgradeableResolver } from "../typechain-types";

// NOTE: this suite deploys the proxy by hand via OpenZeppelin's ERC1967Proxy rather
// than the hardhat-upgrades plugin. The `@openzeppelin/hardhat-upgrades` version
// pinned in this workspace (4.x) targets Hardhat 3 and cannot load under this repo's
// Hardhat 2 toolchain (it imports `hardhat/types/config` ESM that doesn't resolve).
// The manual ERC1967Proxy path is the spec-sanctioned alternative and has no plugin
// dependency, so it's the clean choice here. See report / decisions.md.

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
