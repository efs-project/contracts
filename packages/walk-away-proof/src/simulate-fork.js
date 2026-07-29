import { JsonRpcProvider, parseEther } from "ethers";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CHAIN_ID, EXPECTED_SIGNER } from "./constants.js";
import {
  buildStage1,
  buildStage2,
  buildStage3,
  easContract,
  interpretStage1,
  interpretStage2,
  interpretStage3,
} from "./efs.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rpc = "http://127.0.0.1:8546";

async function submit(contract, requests, interpret) {
  const transaction = await contract.multiAttest(requests, { value: 0n, gasLimit: 10_000_000n });
  const receipt = await transaction.wait();
  if (receipt.status !== 1) throw new Error(`Fork transaction failed: ${transaction.hash}`);
  return interpret(receipt);
}

async function main() {
  const manifest = JSON.parse(await readFile(resolve(packageRoot, "proof/manifest.json"), "utf8"));
  const provider = new JsonRpcProvider(rpc, CHAIN_ID, { staticNetwork: true });
  await provider.send("anvil_impersonateAccount", [EXPECTED_SIGNER]);
  await provider.send("anvil_setBalance", [EXPECTED_SIGNER, `0x${parseEther("10").toString(16)}`]);
  const signer = await provider.getSigner(EXPECTED_SIGNER);
  const eas = easContract(signer);

  const stage1 = await submit(eas, buildStage1(manifest), interpretStage1);
  const stage2 = await submit(
    eas,
    buildStage2(manifest, EXPECTED_SIGNER, stage1),
    interpretStage2,
  );
  const stage3 = await submit(eas, buildStage3(stage1, stage2), interpretStage3);

  console.log(
    JSON.stringify(
      {
        rpc,
        chainId: CHAIN_ID,
        signer: EXPECTED_SIGNER,
        transactions: [
          stage1.transactionHash,
          stage2.transactionHash,
          stage3.transactionHash,
        ],
        attestations: 14,
        result: "SIMULATED",
      },
      null,
      2,
    ),
  );
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
