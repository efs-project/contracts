import * as dotenv from "dotenv";
dotenv.config();
import { Wallet } from "ethers";
import password from "@inquirer/password";
import { spawn } from "child_process";
import { config } from "hardhat";

/**
 * Unencrypts the private key and runs the hardhat deploy command
 */
async function main() {
  const networkIndex = process.argv.indexOf("--network");
  const networkName = networkIndex !== -1 ? process.argv[networkIndex + 1] : config.defaultNetwork;
  // The hardhat task to run (e.g. "deploy" or "deploy:efs"). Set by the package.json script so the
  // same encrypted-key decryption flow works for the EFS core ceremony as for a plain deploy.
  const hardhatTask = process.env.HARDHAT_DEPLOY_TASK ?? "deploy";

  const isLocalNetwork = networkName === "localhost" || networkName === "hardhat";
  const useNodeAccount = isLocalNetwork && process.env.EFS_USE_DEPLOYER_KEY_ON_LOCALHOST !== "1";

  if (useNodeAccount) {
    // Local/fork commands normally use the node's unlocked accounts. Set
    // EFS_USE_DEPLOYER_KEY_ON_LOCALHOST=1 when `localhost` points at a remote
    // devnet and provenance should come from the encrypted deployer/curator key.
    const hardhat = spawn("hardhat", [hardhatTask, ...process.argv.slice(2)], {
      stdio: "inherit",
      env: process.env,
      shell: process.platform === "win32",
    });

    hardhat.on("exit", code => {
      process.exit(code || 0);
    });
    return;
  }

  const encryptedKey = process.env.DEPLOYER_PRIVATE_KEY_ENCRYPTED;

  if (!encryptedKey) {
    console.error("🚫️ You don't have a deployer account. Run `yarn generate` or `yarn account:import` first");
    process.exit(1);
  }

  const pass = await password({ message: "Enter password to decrypt private key:" });

  try {
    const wallet = await Wallet.fromEncryptedJson(encryptedKey, pass);
    process.env.__RUNTIME_DEPLOYER_PRIVATE_KEY = wallet.privateKey;

    const hardhat = spawn("hardhat", [hardhatTask, ...process.argv.slice(2)], {
      stdio: "inherit",
      env: process.env,
      shell: process.platform === "win32",
    });

    hardhat.on("exit", code => {
      process.exit(code || 0);
    });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (e) {
    console.error("Failed to decrypt private key. Wrong password?");
    process.exit(1);
  }
}

main().catch(console.error);
