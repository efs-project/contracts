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
    "0x3077c97e5c928458eb188f063814c206b91f1b08fe3d7e35385175b5c9a63958", // topics
    "0x878d2ae321b372963231955f3db9d947fc29174496d8bf41a639c6ae55d12150",
    "0xa055fba02b87c8decc4026fdd03157c2de94bdaf023ea92566f3ea35a49e02d0",
    "0x4051a7a276eff90e805a6314c09d0421367b353d4efe3015ff435dcfdeefd9fc",
    "0x6fe323615001788316bf42db2fc90f51d6bcfb194debb9d2ee3f2fe05eec8fa2",
    "0x2bd0b295c6d92eeb5d6d2ccdf88a4c4d7c606db89fb20aad5c94d2a62dfd43e0",
    "0x795cdd3682bcb03fb184857e5fda768eba8d60db3d489ac36b8d5d6b2234fe01",
    "0x829a700e3f58635a529eeda388abddf1fc9f3a201c0614d1fb44a8002b2cb2f6",
    "0x3a386582f3e1c559f84167be2459fa5f7a219f57200feff36b80dd8c3d0c1b1f",
    "0x96a48e1137c6b821cde02e3e60b44965b1cd824b5ff739a422b51d34c0ff50f2",
    "0xe3e8e2aa230b925767b3b96659645a13f0f626af53bc59e9d384ccc2e9a26a6c",
    "0xc73103baa0bf6b375a1291a2ea40cc8b6dc1c99c1959126fe73f616ef5404161",
    "0x1136f6c90e9f479cb7676fff481daced82165ad808e91114d0ac72c94889e219",
    "0x3d0be150c09d9c58ad8b980476cefb6af76387e166c4018335c1809bb7a3be0d",
    "0x6e4851b1ee4ee826a06a4514895640816b4143bf2408c33e5c1263275daf53ce", // end topics
    "0x0e2d45932bdc6c927364af0e4c1aed6d540e0b134459fe39552cf8b8f1f166b8", // messages
    "0x607ced2acad646e3b49452f6c185d9be5addc1f7790322f5b0a7110845d9c25b",
    "0xee360ca6ff93ce78d5f5d9d5f3f261ac6ab7365d48b6d84c78296538f478fddd",
    "0xf4b5914e76cbf48e27e87341a3805bd3a2da6d0d80078552a96bfee582cb2c9b",
    "0x7e8e69fd270dd4c5c813cebcf583e04c12d29823b7b3f4e3ad11e87a1933bb75",
    "0x743402034be9a1d99c9e771db2896bc1cf0ac786f0bf25a88dd62fc2beab7128",
    "0x60fa620b776eef9e8b763db96500a8c507ffd3c0510b73c76db1af8d09eaa992" // /messages
  ];

  // Helper function to delay execution
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  // Helper function to retry a transaction with exponential backoff
  async function retryTransaction(fn: () => Promise<any>, maxRetries = 2): Promise<any> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn();
      } catch (error) {
        console.log(`Attempt ${i + 1} failed:`, error);
        if (i === maxRetries - 1) throw error;
        
        // Exponential backoff: wait longer between retries
        const waitTime = Math.pow(2, i + 1) * 3000; // Start with 6 seconds
        console.log(`Waiting ${waitTime / 1000} seconds before retry...`);
        await delay(waitTime);
      }
    }
  }

  // Process attestations in smaller batches to avoid timeouts
  const BATCH_SIZE = 5;
  const batches = [];
  
  for (let i = 0; i < attestationUIDs.length; i += BATCH_SIZE) {
    batches.push(attestationUIDs.slice(i, i + BATCH_SIZE));
  }

  console.log(`Processing ${attestationUIDs.length} attestations in ${batches.length} batches of ${BATCH_SIZE}`);

  let totalIndexed = 0;
  
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    console.log(`Processing batch ${batchIndex + 1}/${batches.length} with ${batch.length} attestations...`);
    
    try {
      await retryTransaction(async () => {
        console.log(`Submitting transaction for batch ${batchIndex + 1}...`);
        const tx = await indexer.indexAttestations(batch);
        console.log(`Transaction submitted, waiting for confirmation...`);
        
        // Set a timeout for the transaction wait
        const txPromise = tx.wait();
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Transaction confirmation timeout')), 180000) // 3 minutes
        );
        
        const receipt = await Promise.race([txPromise, timeoutPromise]);
        
        if (!receipt) {
          throw new Error("Transaction receipt is null");
        }
        
        console.log(`Batch ${batchIndex + 1} indexed successfully. Gas used: ${receipt.gasUsed.toString()}`);
        return receipt;
      });
      
      totalIndexed += batch.length;
      
    } catch (error) {
      console.error(`Failed to index batch ${batchIndex + 1}:`, error);
      // Continue with the next batch even if this one fails
      console.log("Continuing with next batch...");
    }
  }

  console.log(`Successfully indexed ${totalIndexed}/${attestationUIDs.length} attestations`);
};

export default deployYourContract;

// Tags are useful if you have multiple deploy files and only want to run one of them.
// e.g. yarn deploy --tags YourContract
deployYourContract.tags = ["Records"];
