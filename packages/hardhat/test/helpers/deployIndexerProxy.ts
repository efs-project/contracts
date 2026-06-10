import { ethers } from "hardhat";
import { Signer } from "ethers";
import { EFSIndexer } from "../../typechain-types";

// Deploy EFSIndexer behind an ERC1967 proxy and initialize it.
//
// EFSIndexer is upgradeable (ADR-0048): the implementation runs behind a proxy whose ADDRESS is
// the EAS resolver baked into the schema UIDs. Per-deployment config (schema UIDs + owner) lives in
// ERC-7201 namespaced storage, set once via initialize() through the proxy — not in the
// constructor. This helper performs the two-step deploy (impl, then proxy) the way the tests'
// CREATE-nonce predictions expect.
//
// IMPORTANT for nonce prediction: this runs exactly TWO deployer transactions in order —
//   (1) EFSIndexer implementation
//   (2) TestERC1967Proxy (the resolver address that must match the test's prediction)
// So a test that previously predicted the indexer at `nonce + N` (where it called
// `IndexerFactory.deploy`) must now predict the PROXY at `nonce + N + 1` (the impl takes the
// slot at `nonce + N`), and call this helper at that point in the sequence.
//
// Mirrors the manual-proxy approach in test/Upgradeability.test.ts (the pinned
// @openzeppelin/hardhat-upgrades plugin targets Hardhat 3 and can't load under this Hardhat 2
// toolchain), using contracts/test/TestERC1967Proxy.sol.
export async function deployIndexerProxy(
  easAddress: string,
  anchorSchemaUID: string,
  propertySchemaUID: string,
  dataSchemaUID: string,
  owner: Signer,
): Promise<EFSIndexer> {
  const IndexerFactory = await ethers.getContractFactory("EFSIndexer", owner);

  // (1) Implementation — constructor takes only the EAS now.
  const impl = await IndexerFactory.deploy(easAddress);
  await impl.waitForDeployment();

  // (2) Proxy, initialized atomically with the per-deployment config + owner.
  const initData = impl.interface.encodeFunctionData("initialize", [
    anchorSchemaUID,
    propertySchemaUID,
    dataSchemaUID,
    await owner.getAddress(),
  ]);

  const ProxyFactory = await ethers.getContractFactory("TestERC1967Proxy", owner);
  const proxy = await ProxyFactory.deploy(await impl.getAddress(), initData);
  await proxy.waitForDeployment();

  // Bind the EFSIndexer ABI to the proxy address: all calls now delegatecall into the impl.
  return (await ethers.getContractAt("EFSIndexer", await proxy.getAddress(), owner)) as unknown as EFSIndexer;
}
