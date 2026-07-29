import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TurboFactory } from "@ardrive/turbo-sdk";
import Arweave from "arweave";
import { canonicalJson } from "./canonical.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FREE_LIMIT = 100 * 1024;

async function waitForPublicGateway(id, build) {
  const attempts = Number(process.env.ARWEAVE_GATEWAY_ATTEMPTS || 60);
  const url = `https://arweave.net/${id}`;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (response.ok) {
        const bytes = Buffer.from(await response.arrayBuffer());
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        if (bytes.length === build.artifactByteLength && sha256 === build.artifactSha256) {
          return { attempts: attempt, byteLength: bytes.length, sha256, url };
        }
      }
    } catch {
      // Propagation can take several minutes; retry the independent gateway.
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10_000));
  }
  throw new Error(`Arweave gateway did not return verified bytes after ${attempts} attempts: ${url}`);
}

async function main() {
  const build = JSON.parse(await readFile(resolve(packageRoot, "output/artifact-build.json"), "utf8"));
  const artifactPath = resolve(packageRoot, "output", build.artifactName);
  const bytes = await readFile(artifactPath);
  if (bytes.length >= FREE_LIMIT) {
    throw new Error(`Artifact is ${bytes.length} bytes; unauthenticated Turbo limit is below ${FREE_LIMIT} bytes`);
  }

  const tags = [
    { name: "Content-Type", value: "application/gzip" },
    { name: "App-Name", value: "EFS-Walk-Away-Proof" },
    { name: "Artifact-Name", value: build.artifactName },
    { name: "SHA-256", value: build.artifactSha256 },
  ];
  let result;
  let method = "unsigned-free-x402";
  try {
    const turbo = TurboFactory.unauthenticated({ token: "base-usdc" });
    result = await turbo.uploadRawX402Data({ data: bytes, tags });
  } catch (error) {
    if (error.status !== 404) throw error;
    const arweave = Arweave.init({ host: "arweave.net", port: 443, protocol: "https" });
    const privateKey = await arweave.wallets.generate();
    const turbo = TurboFactory.authenticated({ privateKey, token: "arweave" });
    result = await turbo.upload({
      data: bytes,
      dataItemOpts: { tags },
      chunkingMode: "disabled",
    });
    method = "ephemeral-arweave-signer-free-tier";
  }
  const id = result.id || result.dataItemId || result.transactionId;
  if (!id) throw new Error(`Turbo returned no retrievable ID: ${JSON.stringify(result)}`);
  const gatewayVerification = await waitForPublicGateway(id, build);

  const proofDir = resolve(packageRoot, "proof");
  await mkdir(proofDir, { recursive: true });
  await writeFile(
    resolve(proofDir, "arweave.upload.json"),
    `${canonicalJson({ gatewayVerification, id, freeUpload: true, method, service: "Turbo", result })}\n`,
  );
  console.log(`Uploaded https://arweave.net/${id}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
