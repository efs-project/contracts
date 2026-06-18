import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { CREATEX_ADDRESS } from "../deploy-lib/addresses";
import { deployViews } from "../deploy-lib/views";

// EFS read-views deploy (Phase D views) — the post-freeze, NON-FROZEN view layer for CreateX
// networks (Sepolia/mainnet/pinned fork). Deploys EFSFileView + EFSRouter + ListReader against the
// proxy addresses that deploy/00_efs_core.ts registered; reads the frozen schema UIDs off the
// proxies. The views are in NO schema UID and are freely redeployable — re-running is safe.
//
// Run ONLY via `yarn deploy:efs-views` (the EFSViews tag → this script), AFTER the freeze ceremony
// (`yarn deploy:efs`). See docs/DEPLOYMENT.md §3 step 9 + §4.
//
// This step is deliberately NOT legacySuperseded — unlike 02/03/09 (which neutralize on CreateX and
// remain the local/devnet view path), this IS the intended view deploy on CreateX. To avoid double-
// deploying the views, this script only runs where CreateX is present; off CreateX it skips (and
// 02/03/09 own the local/devnet views). On a bare hardhat node with no CreateX (so no foundation) it
// skips gracefully (ADR-0028) rather than failing a plain `yarn deploy`.
const deployEfsViews: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const createxCode = await hre.ethers.provider.getCode(CREATEX_ADDRESS);
  if (createxCode === "0x") {
    console.log(
      "[efs-views] CreateX not present — skipping. The EFS core foundation deploys only where CreateX " +
        "exists (Sepolia/mainnet/pinned fork); on local/devnet the views are deployed by 02/03/09.",
    );
    return;
  }

  console.log("[efs-views] deploying stateless read views (EFSFileView, EFSRouter, ListReader) against proxies...");
  const res = await deployViews(hre);
  console.log("[efs-views] views deployed (NON-FROZEN, in no UID):");
  console.log("  EFSFileView:", res.efsFileView);
  console.log("  EFSRouter:  ", res.efsRouter);
  console.log("  ListReader: ", res.listReader);
};

export default deployEfsViews;
deployEfsViews.tags = ["EFSViews"];
// Intentionally NO `dependencies = ["EFSCore"]`. hardhat-deploy runs a selected tag's dependencies
// first, so depending on EFSCore would make `yarn deploy:efs-views` re-enter the core deploy
// (00_efs_core defaults EFS_DEPLOY_MODE=full, no skip guard) — failing on already-used CREATE3 salts
// on a normal post-freeze view redeploy, or unexpectedly running the irreversible register/transfer
// ceremony if the core doesn't exist yet. Instead this binds only to the already-saved core
// deployments: deployViews() in deploy-lib/views.ts fails with a clear "foundation not found" error
// if the proxies aren't present. In a full `yarn deploy`, 00_efs_core still runs before 10 by
// filename order, so the normal one-shot path is unaffected.
