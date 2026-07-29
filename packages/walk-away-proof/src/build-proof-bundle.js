import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "./canonical.js";
import { packEntries } from "./build-artifact.js";
import { rawFileCid } from "./ipfs-cid.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: packageRoot,
  encoding: "utf8",
}).trim();
const packagePath = "packages/walk-away-proof";
const bundleName = "efs-walk-away-proof-evidence-v0.tar.gz";

const sourcePaths = [
  "README.md",
  "proof/manifest.json",
  "proof/manifest-digest.json",
  "proof/proof.json",
  "src/canonical.js",
  "src/constants.js",
  "src/efs.js",
  "src/ipfs-cid.js",
  "src/manifest.js",
  "src/verifier.js",
  "src/verify-cli.js",
];

function sourceAt(commit, path) {
  return execFileSync("git", ["show", `${commit}:${packagePath}/${path}`], {
    cwd: repoRoot,
    encoding: null,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function instructions(commit) {
  return `# EFS Walk-Away Proof Evidence v0

This bundle contains the signed publication manifest, complete Sepolia receipt,
and the independent verifier at contracts commit ${commit}.

It intentionally does not contain the published artifact. Verification retrieves
the artifact from IPFS or Arweave and compares those bytes with the signed
manifest and live EFS attestations.

Requirements: Node.js 22 or later and internet access.

1. Run \`npm install --omit=dev\`.
2. Verify IPFS:
   \`npm run verify -- --manifest proof/manifest.json --proof proof/proof.json --carrier ipfs\`
3. Verify Arweave:
   \`npm run verify -- --manifest proof/manifest.json --proof proof/proof.json --carrier arweave\`

The expected successful outcome is \`VERIFIED\` for both carriers.
`;
}

async function main() {
  const commit = process.env.PROOF_BUNDLE_COMMIT || execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  const runtimePackage = {
    name: "efs-walk-away-proof-evidence",
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: { verify: "node src/verify-cli.js" },
    dependencies: {
      ethers: "6.17.0",
      "json-canonicalize": "2.0.0",
      multiformats: "13.4.1",
    },
  };
  const entries = sourcePaths.map(name => ({ name, body: sourceAt(commit, name) }));
  entries.push(
    { name: "START-HERE.md", body: Buffer.from(instructions(commit)) },
    { name: "package.json", body: Buffer.from(`${canonicalJson(runtimePackage)}\n`) },
  );
  const first = await packEntries(entries, "efs-walk-away-proof-evidence-v0/");
  const second = await packEntries(entries, "efs-walk-away-proof-evidence-v0/");
  if (!first.bytes.equals(second.bytes)) throw new Error("Evidence bundle rebuild differed");

  const outputDir = resolve(packageRoot, "output");
  const artifactPath = resolve(outputDir, bundleName);
  await mkdir(outputDir, { recursive: true });
  await writeFile(artifactPath, first.bytes);
  const metadata = {
    artifactName: bundleName,
    artifactByteLength: first.bytes.length,
    artifactSha256: createHash("sha256").update(first.bytes).digest("hex"),
    compressor: "fflate@0.8.2",
    sourceCommit: commit,
    rawIpfsCid: await rawFileCid(first.bytes),
    tarSha256: createHash("sha256").update(first.tarBytes).digest("hex"),
  };
  await writeFile(resolve(outputDir, "evidence-build.json"), `${canonicalJson(metadata)}\n`);
  console.log(JSON.stringify(metadata, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
