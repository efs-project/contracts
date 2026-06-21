import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { Contract } from "ethers";
import { redeployIfArgsChanged } from "../deploy-utils";
import { legacySuperseded } from "../deploy-lib/superseded";

const deployEFSFileView: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  // AGENT-NOTE (Phase D, I-3): EFSFileView is a stateless view (redeployable, in no UID). On the
  // Sepolia freeze path the deploy is driven by `yarn deploy:efs` (EFSCore tag only); this script is
  // not invoked there. But a plain `yarn deploy --network sepolia` would run it and bind via
  // getContract("Indexer") — untested on the proxies. Neutralize wherever CreateX is present
  // (Sepolia/mainnet/pinned fork), matching 01/04/05/09. Local/devnet (no CreateX) still deploys it.
  if (await legacySuperseded(hre, "02_fileview")) return;

  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;
  const ethers = hre.ethers;

  console.log("Deploying EFSFileView with account:", deployer);

  // Get Deployed Indexer and EdgeResolver
  const indexer = await ethers.getContract<Contract>("Indexer", deployer);
  if (!indexer) {
    throw new Error("EFSIndexer not found! Make sure 01_indexer.ts ran.");
  }

  const edgeResolver = await ethers.getContract<Contract>("EdgeResolver", deployer);
  if (!edgeResolver) {
    throw new Error("EdgeResolver not found! Make sure 01_indexer.ts ran.");
  }

  // WhiteoutResolver (ADR-0055) — deployed by 08_whiteout.ts on the local/devnet path. Optional:
  // ZeroAddress disables the cross-lens negative-mask predicate (a partial deploy without 08).
  const whiteoutDep = await hre.deployments.getOrNull("WhiteoutResolver");
  const whiteoutAddr = whiteoutDep?.address ?? ethers.ZeroAddress;

  const fileViewArgs = [indexer.target, edgeResolver.target, whiteoutAddr];
  await redeployIfArgsChanged(hre, "EFSFileView", fileViewArgs);

  await deploy("EFSFileView", {
    from: deployer,
    args: fileViewArgs,
    log: true,
    autoMine: true,
  });

  const fileView = await ethers.getContract<Contract>("EFSFileView", deployer);
  console.log("EFSFileView deployed at:", fileView.target);
};

export default deployEFSFileView;
deployEFSFileView.tags = ["EFSFileView"];
deployEFSFileView.dependencies = ["Indexer"];
