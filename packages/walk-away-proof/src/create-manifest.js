import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "./canonical.js";
import { EXPECTED_SIGNER } from "./constants.js";
import { manifestDigest, validateManifest } from "./manifest.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function uploadId(upload, candidates) {
  for (const key of candidates) {
    if (typeof upload[key] === "string" && upload[key]) return upload[key];
  }
  throw new Error(`Upload record lacks an identifier (${candidates.join(", ")})`);
}

export async function createManifest() {
  const outputDir = resolve(packageRoot, "output");
  const proofDir = resolve(packageRoot, "proof");
  const artifact = await readJson(resolve(outputDir, "artifact-build.json"));
  const ipfs = await readJson(resolve(proofDir, "ipfs.upload.json"));
  const arweave = await readJson(resolve(proofDir, "arweave.upload.json"));

  const manifest = {
    format: "efs-walk-away-proof/v0",
    artifactName: artifact.artifactName,
    artifactSha256: artifact.artifactSha256,
    artifactByteLength: artifact.artifactByteLength,
    builderCommit: artifact.builderCommit,
    compressor: artifact.compressor,
    configSha256: artifact.configSha256,
    sourceRepository: artifact.sourceRepository,
    sourceCommit: artifact.sourceCommit,
    tarSha256: artifact.tarSha256,
    signer: EXPECTED_SIGNER,
    ipfsCid: uploadId(ipfs, ["cid"]),
    arweaveId: uploadId(arweave, ["id", "dataItemId", "transactionId"]),
  };
  validateManifest(manifest);
  await mkdir(proofDir, { recursive: true });
  await writeFile(resolve(proofDir, "manifest.json"), `${canonicalJson(manifest)}\n`);
  await mkdir(resolve(packageRoot, "public/proof"), { recursive: true });
  await writeFile(resolve(packageRoot, "public/proof/manifest.json"), `${canonicalJson(manifest)}\n`);
  await writeFile(
    resolve(proofDir, "manifest-digest.json"),
    `${canonicalJson({ manifestDigest: manifestDigest(manifest) })}\n`,
  );
  return manifest;
}

createManifest()
  .then(manifest => {
    console.log(`Created manifest for ${manifest.artifactName}`);
    console.log(`Digest ${manifestDigest(manifest)}`);
  })
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
