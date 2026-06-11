import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { CREATEX_ADDRESS } from "../deploy-lib/addresses";
import { orchestrate, OrchestrationResult, RunMode } from "../deploy-lib/orchestrate";
import { orchestrateViaSafe } from "../deploy-lib/orchestrateSafe";
import { SAFE_PROXY_FACTORY_141, deployTestSafe } from "../deploy-lib/safe";

// EFS orchestrated CREATE3 deploy (Phase D core) — the single source of truth for standing up the
// upgradeable EFS system per docs/DEPLOYMENT.md §3. Replaces the nonce-prediction + TestERC1967Proxy
// path that lived across 01_indexer/04_sortoverlay/05_mirrors/09_lists (those registration paths are
// now neutralized; see the AGENT-NOTE at the top of each).
//
// Modes (env EFS_DEPLOY_MODE, default "full"):
//   full              — deploy + verify + wire + register-last + transfer-to-Safe + per-schema smoke
//   until-freeze-gate — deploy + verify + wire, then STOP before any schema is registered (the human
//                       reviews + signs docs/SEPOLIA_FREEZE_TABLE.md). For the real Sepolia run.
//   after-freeze-gate — re-predict (idempotent) then register + transfer-to-Safe + smoke.
//
// Runs only where the CreateX factory is present (Sepolia, mainnet, or the pinned Sepolia fork). On a
// vanilla hardhat node with no fork it skips gracefully (ADR-0028 graceful degradation) so plain
// `yarn deploy` against a bare node doesn't fail.
const deployEfsCore: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const signer = await hre.ethers.getSigner(deployer);

  const createxCode = await hre.ethers.provider.getCode(CREATEX_ADDRESS);
  if (createxCode === "0x") {
    console.log(
      `[efs-core] CreateX not present at ${CREATEX_ADDRESS} on this network — skipping orchestrated ` +
        `deploy (run against a Sepolia fork: MAINNET_FORKING_ENABLED=true, or real Sepolia/mainnet).`,
    );
    return;
  }

  // Safe-native path (docs/DEPLOYMENT.md §1/§3, ADR-0048/0053): deploy the whole system FROM the
  // EFS.eth Safe (the team multisig) as two owner-signed MultiSend batches, BORN owned by the Safe (no
  // ownership-transfer phase — no hot key ever holds the nascent system). The CREATE3 addresses become
  // Safe-keyed (the Safe is the CreateX caller). The EOA path below stays intact as the simpler
  // fallback. Toggle with EFS_DEPLOY_VIA_SAFE=1 + EFS_SAFE_ADDRESS=<Safe>.
  const viaSafe = process.env.EFS_DEPLOY_VIA_SAFE === "1" || process.env.EFS_DEPLOY_VIA_SAFE === "true";
  let result: OrchestrationResult;
  if (viaSafe) {
    const onFork = (await hre.ethers.provider.getCode(SAFE_PROXY_FACTORY_141)) !== "0x";
    const isHardhat = hre.network.name === "hardhat";
    // Fork rehearsal: stand up a real 1-of-1 test Safe owned by a co-signer (no real Safe on the fork).
    // Real network: EFS_SAFE_ADDRESS must be the real EFS.eth Safe; the owner signers are not available
    // to this process — the batches are proposed/signed via Safe{Wallet}/Safe Tx Service. The fork path
    // is the in-process rehearsal that proves the batches + born-owned init are correct.
    const signers = await hre.ethers.getSigners();
    const owner = signers[1] ?? signers[0];
    let safe = process.env.EFS_SAFE_ADDRESS;
    if (!safe) {
      if (!(isHardhat && onFork)) {
        throw new Error(
          "[efs-core] EFS_DEPLOY_VIA_SAFE=1 requires EFS_SAFE_ADDRESS on a real network. " +
            "On the hardhat fork, a 1-of-1 test Safe is deployed automatically.",
        );
      }
      safe = await deployTestSafe(signer, [await owner.getAddress()], 1);
      console.log(`[efs-core] Safe-native rehearsal — deployed 1-of-1 test Safe ${safe}`);
    }
    console.log(`[efs-core] Safe-native CREATE3 deploy — safe=${safe}, deployer=${deployer} (born Safe-owned)`);
    result = await orchestrateViaSafe(signer, safe, [owner]);
  } else {
    const mode = (process.env.EFS_DEPLOY_MODE as RunMode) ?? "full";
    console.log(`[efs-core] orchestrated CREATE3 deploy — mode=${mode}, deployer=${deployer}`);
    result = await orchestrate(signer, mode);
  }

  // Save the CREATE3 proxies as hardhat-deploy named deployments so the legacy downstream consumer
  // scripts (02/03/06/07/08, rebind deferred to D2) and external tooling can resolve them by name.
  // hardhat-deploy keys EFSIndexer as "Indexer" historically; preserve that alias.
  const saveAs: Record<string, string> = {
    Indexer: "EFSIndexer",
    EdgeResolver: "EdgeResolver",
    MirrorResolver: "MirrorResolver",
    ListResolver: "ListResolver",
    ListEntryResolver: "ListEntryResolver",
    AliasResolver: "AliasResolver",
  };
  for (const [name, resolver] of Object.entries(saveAs)) {
    const artifact = await hre.deployments.getArtifact(resolver);
    await hre.deployments.save(name, {
      address: (result.proxies as Record<string, string>)[resolver],
      abi: artifact.abi,
    });
  }

  // SystemAccount (ADR-0053): save as a named deployment too. NOT a resolver (in no schema UID),
  // but a deterministic CREATE3 proxy whose address is Etched at first canonical write — downstream
  // tooling + the views resolve it by name.
  {
    const artifact = await hre.deployments.getArtifact("SystemAccount");
    await hre.deployments.save("SystemAccount", { address: result.systemAccount, abi: artifact.abi });
  }

  console.log("[efs-core] summary:");
  console.log("  proxies:", result.proxies);
  console.log("  systemAccount:", result.systemAccount);
  console.log("  registered:", result.registered, "ownershipTransferred:", result.ownershipTransferred);
  if (result.registered) console.log("  safe:", result.safe);
};

export default deployEfsCore;
deployEfsCore.tags = ["EFSCore"];
// Run before the legacy/downstream scripts. The downstream consumer scripts (02/03/06/07/08) still
// bind via getContract("Indexer") etc. — rebinding them to the CREATE3 proxies is deferred to D2.
deployEfsCore.runAtTheEnd = false;
