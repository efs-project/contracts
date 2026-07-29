import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "./canonical.js";
import { rawFileCid } from "./ipfs-cid.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const buildPath = process.env.PUBLISH_BUILD || "output/artifact-build.json";
  const artifactFile = process.env.PUBLISH_FILE;
  const recordName = process.env.PUBLISH_RECORD || "ipfs.upload.json";
  const build = JSON.parse(await readFile(resolve(packageRoot, buildPath), "utf8"));
  const artifactPath = resolve(packageRoot, artifactFile || `output/${build.artifactName}`);
  const bytes = await readFile(artifactPath);
  const expectedCid = await rawFileCid(bytes);
  const ipfsBin = process.env.IPFS_BIN || "ipfs";
  const cid = execFileSync(
    ipfsBin,
    ["add", "--cid-version=1", "--raw-leaves=true", "--pin=true", "--quieter", artifactPath],
    { encoding: "utf8" },
  ).trim();
  if (cid !== expectedCid) {
    throw new Error(`Kubo returned ${cid}; expected raw-file CID ${expectedCid}`);
  }
  const record = {
    cid,
    command: "ipfs add --cid-version=1 --raw-leaves=true --pin=true",
    localPin: true,
  };
  const proofDir = resolve(packageRoot, "proof");
  await mkdir(proofDir, { recursive: true });
  await writeFile(resolve(proofDir, recordName), `${canonicalJson(record)}\n`);
  console.log(`Pinned ${cid}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
