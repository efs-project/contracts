// One-off helper for the ADR-0056 MirrorResolver upgrade (remove the URI scheme gate).
//
// Run AFTER `mirror: remove URI scheme gate` (commit c4b24af) is on this checkout:
//   SEPOLIA_RPC_URL=<your Infura> npx hardhat run scripts/upgrade-mirror-impl.ts --network sepolia
// (prompts for your keystore password to deploy the new impl from the gas EOA — no Safe needed for that).
//
// It (1) deploys the new MirrorResolver implementation, (2) reads the live MirrorResolver proxy's
// ProxyAdmin (Safe-owned), and (3) prints the exact Safe transaction to propose in Safe{Wallet}:
// ProxyAdmin.upgradeAndCall(proxy, newImpl, 0x). The proxy address — and thus the MIRROR schema UID and
// the 9-schema freeze — is unchanged; this only swaps the logic. Verify gate: after it lands, attesting a
// `data:`/`javascript:` MIRROR should succeed and an empty URI should still revert.
import { ethers } from "hardhat";
import { EAS_ADDRESS } from "../deploy-lib/addresses";

const MIRROR_PROXY = "0xd4991Ced6D460A3794E9120dC6C19975092982b9"; // Sepolia, see docs/CHAINS.md
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"; // EIP-1967 admin

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("deployer:", await deployer.getAddress());

  // (1) Deploy the new MirrorResolver impl (EAS is the single constructor arg).
  const Factory = await ethers.getContractFactory("MirrorResolver", deployer);
  const impl = await Factory.deploy(EAS_ADDRESS);
  await impl.waitForDeployment();
  const newImpl = await impl.getAddress();
  console.log("new MirrorResolver impl:", newImpl);

  // (2) Read the proxy's ProxyAdmin (the contract the Safe owns + calls to upgrade).
  const adminSlot = await ethers.provider.getStorage(MIRROR_PROXY, ADMIN_SLOT);
  const proxyAdmin = ethers.getAddress("0x" + adminSlot.slice(26));
  console.log("ProxyAdmin (Safe-owned):", proxyAdmin);

  // (3) Build the upgradeAndCall calldata for the Safe to execute.
  const adminIface = new ethers.Interface([
    "function upgradeAndCall(address proxy, address implementation, bytes data) payable",
  ]);
  const data = adminIface.encodeFunctionData("upgradeAndCall", [MIRROR_PROXY, newImpl, "0x"]);

  console.log("\n── Propose this in Safe{Wallet} (Transaction Builder → raw tx) ──");
  console.log("  to:       ", proxyAdmin);
  console.log("  value:    ", "0");
  console.log("  operation:", "0 (CALL — single tx, NOT a delegatecall MultiSend)");
  console.log("  data:     ", data);
  console.log("\nNo freeze impact: MIRROR proxy", MIRROR_PROXY, "and its schema UID are unchanged.");
}
main().catch(e => {
  console.error(e);
  process.exit(1);
});
