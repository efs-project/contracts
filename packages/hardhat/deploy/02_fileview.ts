import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { Contract } from "ethers";

const deployEFSFileView: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;
  const ethers = hre.ethers;

  console.log("Deploying EFSFileView with account:", deployer);

  // Get Deployed Indexer
  const indexer = await ethers.getContract<Contract>("Indexer", deployer);
  if (!indexer) {
    throw new Error("EFSIndexer not found! Make sure 01_indexer.ts ran.");
  }

  await deploy("EFSFileView", {
    from: deployer,
    args: [indexer.target],
    log: true,
    autoMine: true,
  });

  const fileView = await ethers.getContract<Contract>("EFSFileView", deployer);
  console.log("EFSFileView deployed at:", fileView.target);
};

export default deployEFSFileView;
deployEFSFileView.tags = ["EFSFileView"];
deployEFSFileView.dependencies = ["Indexer"];
