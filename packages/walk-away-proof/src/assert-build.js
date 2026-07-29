import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(path) {
  return JSON.parse(await readFile(resolve(packageRoot, path), "utf8"));
}

async function main() {
  const [build, manifest] = await Promise.all([
    readJson("output/artifact-build.json"),
    readJson("proof/manifest.json"),
  ]);
  for (const field of [
    "artifactName",
    "artifactSha256",
    "artifactByteLength",
    "builderCommit",
    "compressor",
    "configSha256",
    "sourceCommit",
    "sourceRepository",
    "tarSha256",
  ]) {
    assert.deepEqual(build[field], manifest[field], `${field} differs from signed manifest`);
  }
  assert.equal(build.rawIpfsCid, manifest.ipfsCid, "raw IPFS CID differs from signed manifest");
  console.log(`Reproduced ${manifest.artifactSha256} from builder ${manifest.builderCommit}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
