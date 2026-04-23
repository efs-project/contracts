import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { Contract } from "ethers";
import { redeployIfArgsChanged } from "../deploy-utils";

const deployEFSFileView: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
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

  await redeployIfArgsChanged(hre, "EFSFileView", [indexer.target, edgeResolver.target]);

  await deploy("EFSFileView", {
    from: deployer,
    args: [indexer.target, edgeResolver.target],
    log: true,
    autoMine: true,
  });

  const fileView = await ethers.getContract<Contract>("EFSFileView", deployer);
  console.log("EFSFileView deployed at:", fileView.target);
};

export default deployEFSFileView;
deployEFSFileView.tags = ["EFSFileView"];
deployEFSFileView.dependencies = ["Indexer"];
