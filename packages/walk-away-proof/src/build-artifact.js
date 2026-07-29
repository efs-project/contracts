import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "fflate";
import tar from "tar-stream";
import { canonicalJson } from "./canonical.js";
import { CONTRACTS, SCHEMAS } from "./constants.js";
import { rawFileCid } from "./ipfs-cid.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = resolve(packageRoot, "artifact-config.json");

function git(repoRoot, args, encoding = "utf8") {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function readConfig() {
  return JSON.parse(await readFile(configPath, "utf8"));
}

function findRepoRoot() {
  return git(packageRoot, ["rev-parse", "--show-toplevel"]).trim();
}

function listFiles(repoRoot, commit, sourcePaths) {
  const files = new Map();
  for (const sourcePath of sourcePaths) {
    const output = git(repoRoot, ["ls-tree", "-r", commit, "--", sourcePath]);
    for (const line of output.split("\n")) {
      if (!line) continue;
      const match = line.match(/^\d+ blob ([0-9a-f]{40})\t(.+)$/);
      if (!match) throw new Error(`Unexpected git ls-tree output: ${line}`);
      files.set(match[2], match[1]);
    }
  }
  return [...files].sort(([left], [right]) => left.localeCompare(right));
}

function sourceAt(repoRoot, commit, file) {
  return git(repoRoot, ["show", `${commit}:${file}`], null);
}

function provenance(config, builderCommit) {
  const sourceUrl = `${config.sourceRepository}/tree/${config.sourceCommit}`;
  const etherscan = address => `https://sepolia.etherscan.io/address/${address}#code`;
  return `# EFS Sepolia Deployment Reference v0

This deterministic bundle is the first artifact used by EFS Walk-Away Proof v0.
It contains an exact public repository snapshot of the EFS core source, the
human-readable Sepolia deployment registry, and minified ABIs reconstructed from
the committed real-network deployment records.

Source repository: ${config.sourceRepository}
Source commit: ${config.sourceCommit}
Source snapshot: ${sourceUrl}
Proof builder commit: ${builderCommit}
Network: Sepolia (chain ID 11155111)
EAS: ${CONTRACTS.eas}
EFSIndexer proxy: ${CONTRACTS.indexer}
EdgeResolver proxy: ${CONTRACTS.edgeResolver}
MirrorResolver proxy: ${CONTRACTS.mirrorResolver}

Frozen schemas:

- ANCHOR: ${SCHEMAS.anchor}
- PROPERTY: ${SCHEMAS.property}
- DATA: ${SCHEMAS.data}
- PIN: ${SCHEMAS.pin}
- MIRROR: ${SCHEMAS.mirror}

Verified contract pages:

- EFSIndexer: ${etherscan(CONTRACTS.indexer)}
- EdgeResolver: ${etherscan(CONTRACTS.edgeResolver)}
- MirrorResolver: ${etherscan(CONTRACTS.mirrorResolver)}

The proxy addresses and schema UIDs are live deployment facts. The source tree
is a named repository release snapshot, not an assertion that every later source
edit was installed behind every upgradeable Sepolia proxy. Etherscan's verified
proxy and implementation pages are the bytecode-specific source record.
`;
}

async function packEntries(entries, prefix) {
  const pack = tar.pack();
  const chunks = [];
  const complete = new Promise((resolvePromise, reject) => {
    pack.on("data", chunk => chunks.push(chunk));
    pack.on("end", resolvePromise);
    pack.on("error", reject);
  });

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    await new Promise((resolveEntry, reject) => {
      pack.entry(
        {
          name: `${prefix}${entry.name}`,
          size: entry.body.length,
          mode: 0o644,
          mtime: new Date(0),
          uid: 0,
          gid: 0,
          uname: "root",
          gname: "root",
        },
        entry.body,
        error => (error ? reject(error) : resolveEntry()),
      );
    });
  }
  pack.finalize();
  await complete;
  const tarBytes = Buffer.concat(chunks);
  return {
    tarBytes,
    bytes: Buffer.from(gzipSync(tarBytes, { level: 9, mtime: 0 })),
  };
}

export async function buildArtifactBuffer() {
  const config = await readConfig();
  const repoRoot = findRepoRoot();
  const builderCommit = config.builderCommit ?? git(repoRoot, ["rev-parse", "HEAD"]).trim();
  const sourceFiles = listFiles(repoRoot, config.sourceCommit, config.sourcePaths);
  const entries = sourceFiles.map(([name]) => ({
    name,
    body: sourceAt(repoRoot, config.sourceCommit, name),
  }));

  for (const [contractName, deploymentPath] of Object.entries(config.abiSources)) {
    const deployment = JSON.parse(sourceAt(repoRoot, config.sourceCommit, deploymentPath).toString("utf8"));
    entries.push({
      name: `abi/${contractName}.json`,
      body: Buffer.from(`${JSON.stringify(deployment.abi)}\n`),
    });
  }
  entries.push({ name: "PROVENANCE.md", body: Buffer.from(provenance(config, builderCommit)) });

  return {
    builderCommit,
    config,
    sourceFiles: sourceFiles.map(([path, blob]) => ({ path, blob })),
    repoRoot,
    ...(await packEntries(entries, config.archivePrefix)),
  };
}

export async function buildArtifact() {
  const first = await buildArtifactBuffer();
  const second = await buildArtifactBuffer();
  const firstSha = createHash("sha256").update(first.bytes).digest("hex");
  const secondSha = createHash("sha256").update(second.bytes).digest("hex");
  if (!first.bytes.equals(second.bytes) || firstSha !== secondSha) {
    throw new Error("Deterministic rebuild failed: the two archive byte strings differ");
  }

  const outputDir = resolve(packageRoot, "output");
  const artifactPath = resolve(outputDir, first.config.artifactName);
  await mkdir(outputDir, { recursive: true });
  await writeFile(artifactPath, first.bytes);

  const metadata = {
    artifactName: first.config.artifactName,
    artifactSha256: firstSha,
    artifactByteLength: first.bytes.length,
    builderCommit: first.builderCommit,
    compressor: "fflate@0.8.2",
    configSha256: createHash("sha256").update(await readFile(configPath)).digest("hex"),
    rawIpfsCid: await rawFileCid(first.bytes),
    sourceRepository: first.config.sourceRepository,
    sourceCommit: first.config.sourceCommit,
    deterministicRebuilds: 2,
    sourceFiles: first.sourceFiles,
    tarSha256: createHash("sha256").update(first.tarBytes).digest("hex"),
  };
  await writeFile(resolve(outputDir, "artifact-build.json"), `${canonicalJson(metadata)}\n`);
  return { artifactPath, metadata };
}

async function main() {
  const { artifactPath, metadata } = await buildArtifact();
  console.log(`Built ${artifactPath}`);
  console.log(`SHA-256 ${metadata.artifactSha256}`);
  console.log(`Bytes ${metadata.artifactByteLength}`);
  console.log(`Raw CID ${metadata.rawIpfsCid}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
