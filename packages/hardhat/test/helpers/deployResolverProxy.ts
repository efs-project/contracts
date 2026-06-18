import { ethers } from "hardhat";
import { Signer } from "ethers";

// Deploy an EFS upgradeable resolver behind an ERC1967 proxy and initialize it.
//
// EFS resolvers are upgradeable (ADR-0048): the implementation runs behind a proxy whose ADDRESS
// is the EAS resolver baked into the schema UID. Per-deployment config (partner refs + owner, if
// any) lives in ERC-7201 namespaced storage, set once via initialize() through the proxy — not in
// the constructor. This helper performs the two-step deploy (impl, then proxy).
//
// IMPORTANT for nonce prediction: each call runs exactly TWO deployer transactions in order —
//   (1) <contractName> implementation
//   (2) TestERC1967Proxy (the resolver address that must match the test's prediction)
// So a test that previously predicted the resolver at `nonce + N` (a single constructor deploy)
// must now predict the PROXY at `nonce + N + 1` (the impl takes the slot at `nonce + N`).
//
// Mirrors the manual-proxy approach in test/Upgradeability.test.ts (the pinned
// @openzeppelin/hardhat-upgrades plugin targets Hardhat 3 and can't load under this Hardhat 2
// toolchain), using contracts/test/TestERC1967Proxy.sol.
//
// `constructorArgs` are passed to the implementation constructor (e.g. the EAS address — an
// immutable on the base, see EFSUpgradeableResolver). `initializeArgs` are abi-encoded into the
// proxy's initialize() call (empty array for a no-arg initialize()).
export async function deployResolverProxy<T>(
  contractName: string,
  constructorArgs: unknown[],
  initializeArgs: unknown[],
  deployer: Signer,
): Promise<T> {
  const Factory = await ethers.getContractFactory(contractName, deployer);

  // (1) Implementation.
  const impl = await Factory.deploy(...constructorArgs);
  await impl.waitForDeployment();

  // (2) Proxy, initialized atomically with the per-deployment config.
  const initData = impl.interface.encodeFunctionData("initialize", initializeArgs);

  const ProxyFactory = await ethers.getContractFactory("TestERC1967Proxy", deployer);
  const proxy = await ProxyFactory.deploy(await impl.getAddress(), initData);
  await proxy.waitForDeployment();

  // Bind the resolver ABI to the proxy address: all calls now delegatecall into the impl.
  return (await ethers.getContractAt(contractName, await proxy.getAddress(), deployer)) as unknown as T;
}
