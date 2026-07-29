import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyProof } from "./verifier.js";

function parseArgs(argv) {
  const options = {
    manifest: "proof/manifest.json",
    proof: "proof/proof.json",
    carrier: "ipfs",
  };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || !["--manifest", "--proof", "--carrier", "--rpc", "--ipfs-gateway", "--arweave-gateway"].includes(flag)) {
      throw new Error(`Unknown or incomplete argument: ${flag}`);
    }
    options[flag.slice(2)] = value;
  }
  return options;
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await verifyProof(await readJson(args.manifest), await readJson(args.proof), {
    carrier: args.carrier,
    endpoints: {
      ...(args.rpc ? { sepoliaRpc: args.rpc } : {}),
      ...(args["ipfs-gateway"] ? { ipfsGateway: args["ipfs-gateway"] } : {}),
      ...(args["arweave-gateway"] ? { arweaveGateway: args["arweave-gateway"] } : {}),
    },
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.outcome === "INVALID") process.exitCode = 2;
  if (result.outcome === "UNAVAILABLE") process.exitCode = 3;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 2;
});
