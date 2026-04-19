import fs from "fs";
import path from "path";

import { Contract, ethers } from "ethers";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

const EAS_ADDRESS = "0xC2679fBD37d54388Ce493F1DB75320D236e1815e";
const TARGET_ADDRESS = "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199";
const DEFAULT_MEDIA_BASE_URL =
  "https://raw.githubusercontent.com/efs-project/contracts/user-browsing/reference/devnet-sample-media";

type ManifestEntry = {
  path: string;
  category: string;
  format: string;
};

type Manifest = {
  files: ManifestEntry[];
};

type ParentRef = { kind: "address"; containerUID: string; address: string } | { kind: "anchor"; uid: string };

const MIME_BY_EXT: Record<string, string> = {
  ".avif": "image/avif",
  ".bin": "application/octet-stream",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".html": "text/html",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".ogv": "video/ogg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".rtf": "application/rtf",
  ".svg": "image/svg+xml",
  ".toml": "application/toml",
  ".txt": "text/plain",
  ".wasm": "application/wasm",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".zip": "application/zip",
};

function addressToBytes32(addr: string): string {
  return ethers.zeroPadValue(ethers.getAddress(addr), 32);
}

function buildRawUrl(baseUrl: string, relativePath: string): string {
  return `${baseUrl}/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
}

function contentTypeFor(relPath: string): string {
  const ext = path.extname(relPath).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

const deployUserBrowsingDemo: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  if (hre.network.name !== "localhost" && hre.network.name !== "hardhat") {
    console.log(`Skipping user-browsing demo seeding on network "${hre.network.name}" (localhost/hardhat only).`);
    return;
  }

  const corpusRoot = path.resolve(__dirname, "../../../reference/devnet-sample-media");
  const manifestPath = path.join(corpusRoot, "sample-media-manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing sample media manifest at ${manifestPath}`);
  }

  const mediaBaseUrl = process.env.EFS_DEMO_MEDIA_BASE_URL ?? DEFAULT_MEDIA_BASE_URL;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
  const files = manifest.files
    .map(entry => entry.path)
    .sort((a, b) => a.localeCompare(b))
    .filter(relPath => {
      const absPath = path.join(corpusRoot, relPath);
      return fs.existsSync(absPath) && fs.statSync(absPath).isFile();
    });

  const targetAddr = ethers.getAddress(TARGET_ADDRESS);
  const targetSigner = await hre.ethers.getSigner(targetAddr);
  const { deployer } = await hre.getNamedAccounts();
  const eas = await hre.ethers.getContractAt(
    "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol:IEAS",
    EAS_ADDRESS,
    targetSigner,
  );
  const indexer = await hre.ethers.getContract<Contract>("Indexer", deployer);
  const tagResolver = await hre.ethers.getContract<Contract>("TagResolver", deployer);

  const anchorSchemaUID: string = await indexer.ANCHOR_SCHEMA_UID();
  const dataSchemaUID: string = await indexer.DATA_SCHEMA_UID();
  const propertySchemaUID: string = await indexer.PROPERTY_SCHEMA_UID();
  const mirrorSchemaUID: string = await indexer.MIRROR_SCHEMA_UID();

  // ADR-0028 graceful degradation: bail cleanly when earlier deploy steps
  // couldn't attest (CI vanilla hardhat without EAS → rootUID stays zero →
  // every `createChildAnchor` call here would revert). Matches the
  // skip-with-log pattern in 06_schema_aliases.ts and seed-impl.ts.
  const rootUID: string = await indexer.rootAnchorUID();
  if (rootUID === ethers.ZeroHash) {
    console.log("⏭️  User-browsing demo skipped — root anchor is zero (no EAS on this chain).");
    return;
  }

  const httpsTransportUID: string = await indexer.resolvePath(
    await indexer.resolvePath(rootUID, "transports"),
    "https",
  );
  const tagSchemaUID: string = await tagResolver.TAG_SCHEMA_UID();
  const addressContainerUID = addressToBytes32(targetAddr);
  const encode = ethers.AbiCoder.defaultAbiCoder();

  const extractUID = (receipt: any): string | undefined => {
    for (const log of receipt?.logs ?? []) {
      try {
        const parsed = eas.interface.parseLog(log);
        if (parsed?.name === "Attested") return parsed.args.uid;
      } catch {
        // Not an EAS log.
      }
    }
    return undefined;
  };

  const resolveChild = async (parentUID: string, name: string, schema: string) => {
    const uid = await indexer.resolveAnchor(parentUID, name, schema);
    return uid === ethers.ZeroHash ? null : uid;
  };

  const createChildAnchor = async (parent: ParentRef, name: string, schema: string): Promise<string> => {
    const tx = await eas.attest({
      schema: anchorSchemaUID,
      data: {
        recipient: parent.kind === "address" ? parent.address : ethers.ZeroAddress,
        expirationTime: 0n,
        revocable: false,
        refUID: parent.kind === "address" ? ethers.ZeroHash : parent.uid,
        data: encode.encode(["string", "bytes32"], [name, schema]),
        value: 0n,
      },
    });
    const receipt = await tx.wait();
    const uid = extractUID(receipt);
    if (!uid) throw new Error(`Failed to create anchor for ${name}`);
    return uid;
  };

  const ensureFolderPath = async (relativeDir: string): Promise<ParentRef> => {
    const parts = relativeDir.split("/").filter(Boolean);
    let parent: ParentRef = { kind: "address", containerUID: addressContainerUID, address: targetAddr };

    for (const part of parts) {
      const currentParentUID = parent.kind === "address" ? parent.containerUID : parent.uid;
      let childUID = await resolveChild(currentParentUID, part, ethers.ZeroHash);
      if (!childUID) {
        childUID = await createChildAnchor(parent, part, ethers.ZeroHash);
        console.log(
          `  Folder created: /${relativeDir
            .split("/")
            .slice(0, parts.indexOf(part) + 1)
            .join("/")}`,
        );
      }
      parent = { kind: "anchor", uid: childUID };
    }

    return parent;
  };

  const createContentTypeProperty = async (dataUID: string, value: string) => {
    let keyAnchorUID = await indexer.resolveAnchor(dataUID, "contentType", propertySchemaUID);
    if (keyAnchorUID === ethers.ZeroHash) {
      keyAnchorUID = await createChildAnchor({ kind: "anchor", uid: dataUID }, "contentType", propertySchemaUID);
    }

    const propTx = await eas.attest({
      schema: propertySchemaUID,
      data: {
        recipient: ethers.ZeroAddress,
        expirationTime: 0n,
        revocable: false,
        refUID: ethers.ZeroHash,
        data: encode.encode(["string"], [value]),
        value: 0n,
      },
    });
    const propReceipt = await propTx.wait();
    const propertyUID = extractUID(propReceipt);
    if (!propertyUID) throw new Error(`Failed to create contentType PROPERTY for ${dataUID}`);

    await (
      await eas.attest({
        schema: tagSchemaUID,
        data: {
          recipient: ethers.ZeroAddress,
          expirationTime: 0n,
          revocable: true,
          refUID: propertyUID,
          data: encode.encode(["bytes32", "bool"], [keyAnchorUID, true]),
          value: 0n,
        },
      })
    ).wait();
  };

  const createMirror = async (dataUID: string, uri: string) => {
    await (
      await eas.attest({
        schema: mirrorSchemaUID,
        data: {
          recipient: ethers.ZeroAddress,
          expirationTime: 0n,
          revocable: true,
          refUID: dataUID,
          data: encode.encode(["bytes32", "string"], [httpsTransportUID, uri]),
          value: 0n,
        },
      })
    ).wait();
  };

  const placeAtAnchor = async (dataUID: string, fileAnchorUID: string) => {
    await (
      await eas.attest({
        schema: tagSchemaUID,
        data: {
          recipient: ethers.ZeroAddress,
          expirationTime: 0n,
          revocable: true,
          refUID: dataUID,
          data: encode.encode(["bytes32", "bool"], [fileAnchorUID, true]),
          value: 0n,
        },
      })
    ).wait();
  };

  console.log(`Seeding user-browsing demo corpus for ${targetAddr}`);
  console.log(`Media base URL: ${mediaBaseUrl}`);

  let createdFiles = 0;
  let skippedFiles = 0;

  for (const relPath of files) {
    const folder = path.posix.dirname(relPath) === "." ? "" : path.posix.dirname(relPath);
    const filename = path.posix.basename(relPath);
    const parent = await ensureFolderPath(folder);
    const parentUID = parent.kind === "address" ? parent.containerUID : parent.uid;

    let fileAnchorUID = await resolveChild(parentUID, filename, dataSchemaUID);
    if (!fileAnchorUID) {
      fileAnchorUID = await createChildAnchor(parent, filename, dataSchemaUID);
    }

    const existing = await tagResolver.getActiveTargetsByAttesterAndSchema(
      fileAnchorUID,
      targetAddr,
      dataSchemaUID,
      0,
      1,
    );
    if (existing.length > 0) {
      skippedFiles++;
      continue;
    }

    const absPath = path.join(corpusRoot, relPath);
    const bytes = fs.readFileSync(absPath);
    const contentHash = ethers.keccak256(bytes);
    const size = BigInt(bytes.length);
    let dataUID = await indexer.dataByContentKey(contentHash);

    if (dataUID === ethers.ZeroHash) {
      const dataTx = await eas.attest({
        schema: dataSchemaUID,
        data: {
          recipient: ethers.ZeroAddress,
          expirationTime: 0n,
          revocable: false,
          refUID: ethers.ZeroHash,
          data: encode.encode(["bytes32", "uint64"], [contentHash, size]),
          value: 0n,
        },
      });
      const dataReceipt = await dataTx.wait();
      dataUID = extractUID(dataReceipt) ?? ethers.ZeroHash;
      if (dataUID === ethers.ZeroHash) throw new Error(`Failed to create DATA for ${relPath}`);
    }

    await createContentTypeProperty(dataUID, contentTypeFor(relPath));
    await createMirror(dataUID, buildRawUrl(mediaBaseUrl, relPath));
    await placeAtAnchor(dataUID, fileAnchorUID);

    createdFiles++;
    console.log(`  Seeded: /${relPath}`);
  }

  console.log(
    `User-browsing demo seeding complete. Created ${createdFiles} file placements, skipped ${skippedFiles} existing files.`,
  );
};

export default deployUserBrowsingDemo;
deployUserBrowsingDemo.tags = ["UserBrowsingDemo"];
deployUserBrowsingDemo.dependencies = ["PersonaNames"];
