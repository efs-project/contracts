import { ethers } from "hardhat";
import { Signer } from "ethers";

// Deploy an EFS resolver implementation behind a TransparentUpgradeableProxy and initialize it,
// returning the proxy (typed as the resolver), its address, and the ProxyAdmin address.
//
// This is the UPGRADEABLE counterpart to deployResolverProxy/deployIndexerProxy (which use a plain,
// non-upgradeable ERC1967Proxy). The EFS resolvers carry NO UUPS `upgradeToAndCall` hook in their
// own bytecode, so a plain ERC1967Proxy has no on-chain upgrade entrypoint at all. The Transparent
// pattern puts the upgrade logic in the proxy (dispatched through its ProxyAdmin), so it can upgrade
// a no-UUPS implementation — the ProxyAdmin/ERC1967 path the storage-corruption guard exercises
// (test/UpgradeWithState.test.ts).
//
// NOTE on proxy ADDRESS prediction: the resolver address baked into the EAS schema UIDs is the
// PROXY's address. TransparentUpgradeableProxy's constructor ALSO deploys a ProxyAdmin (a CREATE
// from the proxy's own address, NOT the deployer), so the deployer-nonce sequence is unchanged
// vs. the plain-proxy helpers: one deployer tx for the impl, one for the proxy. The ProxyAdmin
// address is read back from the proxy's ERC-1967 admin slot.

const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

export interface UpgradeableDeployment<T> {
  proxy: T;
  proxyAddress: string;
  proxyAdmin: string;
  implAddress: string;
}

export async function deployUpgradeableProxy<T>(
  contractName: string,
  constructorArgs: unknown[],
  initializeArgs: unknown[],
  deployer: Signer,
): Promise<UpgradeableDeployment<T>> {
  const Factory = await ethers.getContractFactory(contractName, deployer);

  // (1) Implementation.
  const impl = await Factory.deploy(...constructorArgs);
  await impl.waitForDeployment();

  // (2) Transparent proxy, initialized atomically; constructor spins up an owned ProxyAdmin.
  const initData = impl.interface.encodeFunctionData("initialize", initializeArgs);
  const ProxyFactory = await ethers.getContractFactory("TestTransparentProxy", deployer);
  const proxy = await ProxyFactory.deploy(await impl.getAddress(), await deployer.getAddress(), initData);
  await proxy.waitForDeployment();

  const proxyAddress = await proxy.getAddress();

  // Read the ProxyAdmin address from the proxy's ERC-1967 admin slot.
  const adminRaw = await ethers.provider.getStorage(proxyAddress, ADMIN_SLOT);
  const proxyAdmin = ethers.getAddress("0x" + adminRaw.slice(-40));

  const bound = (await ethers.getContractAt(contractName, proxyAddress, deployer)) as unknown as T;
  return { proxy: bound, proxyAddress, proxyAdmin, implAddress: await impl.getAddress() };
}

// Perform a V1→V2 implementation upgrade through the ProxyAdmin (ERC1967 upgradeAndCall path).
// `newImplFactoryName` is deployed fresh, then ProxyAdmin.upgradeAndCall(proxy, newImpl, "") swaps
// the implementation pointer. No re-initialization (empty calldata) — proxy storage is preserved.
export async function upgradeProxy(
  proxyAddress: string,
  proxyAdmin: string,
  newImplFactoryName: string,
  constructorArgs: unknown[],
  deployer: Signer,
): Promise<string> {
  const NewFactory = await ethers.getContractFactory(newImplFactoryName, deployer);
  const newImpl = await NewFactory.deploy(...constructorArgs);
  await newImpl.waitForDeployment();

  const admin = await ethers.getContractAt("TestProxyAdmin", proxyAdmin, deployer);
  const tx = await admin.upgradeAndCall(proxyAddress, await newImpl.getAddress(), "0x");
  await tx.wait();
  return await newImpl.getAddress();
}
