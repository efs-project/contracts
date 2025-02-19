import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { Contract } from "ethers";

/**
 * Deploys a contract named "YourContract" using the deployer account and
 * constructor arguments set to the deployer address
 *
 * @param hre HardhatRuntimeEnvironment object.
 */
const deployYourContract: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  /*
    On localhost, the deployer account is the one that comes with Hardhat, which is already funded.

    When deploying to live networks (e.g `yarn deploy --network sepolia`), the deployer account
    should have sufficient balance to pay for the gas fees for contract creation.

    You can generate a random account with `yarn generate` or `yarn account:import` to import your
    existing PK which will fill DEPLOYER_PRIVATE_KEY_ENCRYPTED in the .env file (then used on hardhat.config.ts)
    You can run the `yarn account` command to check your balance in every network.
  */
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  // Get the deployed Indexer contract
  const indexer = await hre.ethers.getContract<Contract>("Indexer", deployer);
  
  // Example attestation UIDs to index
  const attestationUIDs = [
    "0x1619ed06b56c56063a79c8db41f360f8108f728a37c6e1dbe291c8b7f5c308b7",
    "0x6e4851b1ee4ee826a06a4514895640816b4143bf2408c33e5c1263275daf53ce",
    // Add more UIDs as needed
  ];

  // Call indexAttestations with the array of UIDs
  const tx = await indexer.indexAttestations(attestationUIDs);
  await tx.wait();
  
  console.log(`Indexed ${attestationUIDs.length} attestations`);
};

export default deployYourContract;

// Tags are useful if you have multiple deploy files and only want to run one of them.
// e.g. yarn deploy --tags YourContract
deployYourContract.tags = ["Records"];
