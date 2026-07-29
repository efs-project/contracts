import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "./canonical.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(path) {
  return JSON.parse(await readFile(resolve(packageRoot, path), "utf8"));
}

async function main() {
  const [build, pending] = await Promise.all([
    readJson("output/artifact-build.json"),
    readJson("proof/arweave.pending.json"),
  ]);
  const gateway = process.env.ARWEAVE_GATEWAY || "https://ardrive.net/";
  const url = `${gateway}${pending.id}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Arweave returned HTTP ${response.status}: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== build.artifactByteLength || sha256 !== build.artifactSha256) {
    throw new Error(`Arweave bytes differ: ${bytes.length} bytes, SHA-256 ${sha256}`);
  }
  const record = {
    ...pending,
    gatewayVerification: { attempts: 1, byteLength: bytes.length, sha256, url },
  };
  await writeFile(
    resolve(packageRoot, "proof/arweave.upload.json"),
    `${canonicalJson(record)}\n`,
  );
  console.log(`Verified ${url}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
