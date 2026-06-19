import { task } from "hardhat/config";
import { EAS_ADDRESS } from "../deploy-lib/addresses";

// One-off task for the ADR-0056 MirrorResolver upgrade (remove the URI scheme gate).
//
//   yarn mirror:upgrade --network sepolia
//
// Run via the package script (HARDHAT_DEPLOY_TASK=mirror:upgrade … runHardhatDeployWithPK), which
// decrypts your deployer key (password prompt on real networks) so the impl deploys from the REAL
// deployer EOA — not hardhat's default account. It (1) deploys the new MirrorResolver impl, (2) reads
// the live proxy's Safe-owned ProxyAdmin, and (3) prints the exact Safe transaction to propose:
// ProxyAdmin.upgradeAndCall(proxy, newImpl, 0x). The proxy address — and thus the MIRROR schema UID +
// the 9-schema freeze — is UNCHANGED; this only swaps the logic.
task("mirror:upgrade", "Deploy the gate-free MirrorResolver impl + print the Safe upgradeAndCall (ADR-0056)")
  .addOptionalParam("proxy", "MirrorResolver proxy address", "0xd4991Ced6D460A3794E9120dC6C19975092982b9")
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"; // EIP-1967 admin
    const proxy = ethers.getAddress(args.proxy as string);

    const [deployer] = await ethers.getSigners();
    console.log(`[mirror:upgrade] network=${hre.network.name} deployer=${await deployer.getAddress()}`);

    // (1) Deploy the new MirrorResolver impl (EAS is the single constructor arg).
    const Factory = await ethers.getContractFactory("MirrorResolver", deployer);
    const impl = await Factory.deploy(EAS_ADDRESS);
    await impl.waitForDeployment();
    const newImpl = await impl.getAddress();
    console.log(`[mirror:upgrade] new MirrorResolver impl deployed: ${newImpl}`);

    // (2) Read the proxy's ProxyAdmin (the contract the Safe owns + calls to upgrade).
    const adminSlot = await ethers.provider.getStorage(proxy, ADMIN_SLOT);
    const proxyAdmin = ethers.getAddress("0x" + adminSlot.slice(26));

    // (3) Build the upgradeAndCall calldata (empty init data — logic-only swap, storage preserved).
    const adminIface = new ethers.Interface([
      "function upgradeAndCall(address proxy, address implementation, bytes data) payable",
    ]);
    const data = adminIface.encodeFunctionData("upgradeAndCall", [proxy, newImpl, "0x"]);

    console.log("\n┌─────────────────────────────────────────────────────────────────────────────");
    console.log("│ PROPOSE THIS IN Safe{Wallet} (Transaction Builder → New transaction → raw tx)");
    console.log("│   to:        " + proxyAdmin + "   (MirrorResolver ProxyAdmin, Safe-owned)");
    console.log("│   value:     0");
    console.log("│   operation: CALL (a single tx — NOT a delegatecall MultiSend)");
    console.log("│   data:      " + data);
    console.log("│");
    console.log("│ Freeze-safe: MIRROR proxy " + proxy + " and its schema UID are unchanged.");
    console.log("└─────────────────────────────────────────────────────────────────────────────");
  });
