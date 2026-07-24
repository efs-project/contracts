import { createReadStream, existsSync, readFileSync, statSync } from "fs";
import http from "http";
import https from "https";
import path from "path";
import { AbiCoder, Contract, Signer, ZeroAddress, ZeroHash, keccak256 } from "ethers";
import {
  DatasetManifest,
  DatasetManifestEntry,
  SeedDatasetArgs,
  buildIpfsAddUrl,
  contentTypeForEntry,
  loadDatasetManifest,
  parseKuboAddResponse,
  parseSeedDatasetArgs,
} from "./seed-dataset-lib";

type UID = string;

const EAS_ABI = [
  "event Attested(address indexed recipient,address indexed attester,bytes32 uid,bytes32 indexed schemaUID)",
  "function attest((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value) data) request) payable returns (bytes32)",
  "function multiAttest((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value)[] data)[] multiRequests) payable returns (bytes32[])",
];

const MAX_ANCHOR_DEPTH = 32;
const ABI = AbiCoder.defaultAbiCoder();

interface HardhatEthersRuntime {
  getSigners: () => Promise<Signer[]>;
  getContract: (name: string, signer?: Signer) => Promise<unknown>;
  getContractAt: (name: string, address: string, signer?: Signer) => Promise<unknown>;
}

interface AttestationData {
  recipient: string;
  expirationTime: bigint;
  revocable: boolean;
  refUID: string;
  data: string;
  value: bigint;
}

interface MultiRequest {
  schema: string;
  data: AttestationData[];
}

interface SeedContext {
  signer: Signer;
  signerAddress: string;
  eas: Contract;
  // The generated TypeChain contracts are structurally compatible here, but the
  // script only needs a small dynamic surface and stays simpler without importing
  // every generated type into deploy tooling.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  indexer: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  edgeResolver: any;
  schemas: {
    anchor: UID;
    data: UID;
    mirror: UID;
    pin: UID;
    tag: UID;
    property: UID;
  };
  rootUID: UID;
  ipfsTransportUID: UID;
  tagsRootUID: UID;
  execute: boolean;
}

interface PreparedFile {
  entry: DatasetManifestEntry;
  absolutePath: string;
  relativePath: string;
  size: bigint;
  contentType: string;
  contentHash: string;
}

export async function seedDataset(args: SeedDatasetArgs, ethersRuntime?: HardhatEthersRuntime): Promise<void> {
  const manifestPath = resolveManifestPath(args.manifest);
  const manifest = loadDatasetManifest(manifestPath);
  const datasetDir = path.dirname(manifestPath);
  const selected = prepareFiles(manifest, datasetDir, args.only);

  console.log(`[seed-dataset] dataset=${manifest.dataset} anchor=${manifest.anchorPath} files=${selected.length}`);
  if (!args.execute) {
    for (const file of selected) {
      console.log(`  dry-run ${file.relativePath} ${file.contentType} ${file.size} bytes`);
    }
    console.log("[seed-dataset] dry-run only. Re-run with --execute --pin to pin and write attestations.");
    return;
  }
  if (!args.pin) {
    throw new Error("IPFS seeding requires --pin so local bytes become ipfs:// mirrors.");
  }

  const runtime = ethersRuntime ?? (await import("hardhat")).ethers;
  const ctx = await connectContext(args.execute, runtime);
  const datasetRootUID = await ensureAnchorPath(ctx, manifest.anchorPath);
  const tagCache = new Map<string, UID>();

  for (const file of selected) {
    await seedOneFile({
      ctx,
      file,
      datasetRootUID,
      datasetDir,
      ipfsApiUrl: args.ipfsApiUrl,
      force: args.force,
      tagCache,
    });
  }
}

function resolveManifestPath(input: string): string {
  const candidates = [
    path.resolve(process.cwd(), input),
    path.resolve(__dirname, "../../..", input),
    path.resolve(__dirname, "../../../..", input),
  ];
  return candidates.find(existsSync) ?? candidates[0];
}

function prepareFiles(manifest: DatasetManifest, datasetDir: string, only: string[]): PreparedFile[] {
  const onlySet = new Set(only);
  const defaults = manifest.defaults ?? {};
  const files = onlySet.size > 0 ? manifest.files.filter(entry => onlySet.has(entry.path)) : manifest.files;
  if (onlySet.size > 0 && files.length !== onlySet.size) {
    const found = new Set(files.map(file => file.path));
    const missing = [...onlySet].filter(file => !found.has(file));
    throw new Error(`--only path(s) not found in manifest: ${missing.join(", ")}`);
  }

  return files.map(entry => {
    const absolutePath = path.resolve(datasetDir, entry.path);
    const datasetRoot = path.resolve(datasetDir);
    if (!absolutePath.startsWith(`${datasetRoot}${path.sep}`)) {
      throw new Error(`Manifest path escapes dataset directory: ${entry.path}`);
    }
    const bytes = readFileSync(absolutePath);
    return {
      entry,
      absolutePath,
      relativePath: entry.path,
      size: BigInt(statSync(absolutePath).size),
      contentType: contentTypeForEntry(entry, defaults),
      contentHash: keccak256(bytes),
    };
  });
}

async function connectContext(execute: boolean, ethersRuntime: HardhatEthersRuntime): Promise<SeedContext> {
  const [signer] = await ethersRuntime.getSigners();
  const signerAddress = await signer.getAddress();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const indexer = (await ethersRuntime.getContract("Indexer", signer)) as any;
  const easAddr = await indexer.getEAS();
  const eas = new Contract(easAddr, EAS_ABI, signer);
  const edgeResolverAddr = await indexer.edgeResolver();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const edgeResolver = (await ethersRuntime.getContractAt("EdgeResolver", edgeResolverAddr, signer)) as any;
  const rootUID = (await indexer.rootAnchorUID()) as UID;
  if (rootUID === ZeroHash) throw new Error("Indexer rootAnchorUID is zero; EFS scaffolding is not initialized.");

  const schemas = {
    anchor: (await indexer.ANCHOR_SCHEMA_UID()) as UID,
    data: (await indexer.DATA_SCHEMA_UID()) as UID,
    mirror: (await indexer.MIRROR_SCHEMA_UID()) as UID,
    pin: (await indexer.PIN_SCHEMA_UID()) as UID,
    tag: (await indexer.TAG_SCHEMA_UID()) as UID,
    property: (await indexer.PROPERTY_SCHEMA_UID()) as UID,
  };
  const transportsUID = (await indexer.resolvePath(rootUID, "transports")) as UID;
  const ipfsTransportUID = (await indexer.resolvePath(transportsUID, "ipfs")) as UID;
  if (ipfsTransportUID === ZeroHash) throw new Error("Missing /transports/ipfs anchor.");
  const tagsRootUID = await ensureFolder(
    {
      signer,
      signerAddress,
      eas,
      indexer,
      edgeResolver,
      schemas,
      rootUID,
      ipfsTransportUID,
      tagsRootUID: ZeroHash,
      execute,
    },
    rootUID,
    "tags",
  );

  console.log(`[seed-dataset] signer=${signerAddress}`);
  console.log(`[seed-dataset] indexer=${await indexer.getAddress()} eas=${easAddr}`);
  return {
    signer,
    signerAddress,
    eas,
    indexer,
    edgeResolver,
    schemas,
    rootUID,
    ipfsTransportUID,
    tagsRootUID,
    execute,
  };
}

async function seedOneFile(args: {
  ctx: SeedContext;
  file: PreparedFile;
  datasetRootUID: UID;
  datasetDir: string;
  ipfsApiUrl: string;
  force: boolean;
  tagCache: Map<string, UID>;
}): Promise<void> {
  const { ctx, file, datasetRootUID, ipfsApiUrl, force, tagCache } = args;
  const parentUID = await ensureEntryParent(ctx, datasetRootUID, file.relativePath);
  const fileName = path.posix.basename(file.relativePath);
  let fileAnchorUID = await findAnchor(ctx, parentUID, fileName, ctx.schemas.data);

  if (fileAnchorUID && !force && (await hasActivePlacement(ctx, fileAnchorUID))) {
    console.log(`  skip ${file.relativePath} (active placement already exists for signer)`);
    return;
  }

  console.log(`  pin  ${file.relativePath}`);
  const cid = await pinFileToIpfs(ipfsApiUrl, file.absolutePath, fileName);
  const mirrorUri = `ipfs://${cid}`;
  console.log(`  cid  ${cid}`);

  const dataUID = await attestOne(ctx, ctx.schemas.data, {
    recipient: ZeroAddress,
    expirationTime: 0n,
    revocable: false,
    refUID: ZeroHash,
    data: "0x",
    value: 0n,
  });

  const reserved = [
    { key: "contentType", value: file.contentType },
    { key: "contentHash", value: file.contentHash },
    { key: "size", value: file.size.toString() },
  ];
  const stageLabels: string[] = ["mirror"];
  const stageRequests: MultiRequest[] = [
    {
      schema: ctx.schemas.mirror,
      data: [
        {
          recipient: ZeroAddress,
          expirationTime: 0n,
          revocable: true,
          refUID: dataUID,
          data: ABI.encode(["bytes32", "string"], [ctx.ipfsTransportUID, mirrorUri]),
          value: 0n,
        },
      ],
    },
    {
      schema: ctx.schemas.anchor,
      data: reserved.map(({ key }) => {
        stageLabels.push(`key:${key}`);
        return {
          recipient: ZeroAddress,
          expirationTime: 0n,
          revocable: false,
          refUID: dataUID,
          data: ABI.encode(["string", "bytes32"], [key, ctx.schemas.property]),
          value: 0n,
        };
      }),
    },
    {
      schema: ctx.schemas.property,
      data: reserved.map(({ key, value }) => {
        stageLabels.push(`prop:${key}`);
        return {
          recipient: ZeroAddress,
          expirationTime: 0n,
          revocable: false,
          refUID: ZeroHash,
          data: ABI.encode(["string"], [value]),
          value: 0n,
        };
      }),
    },
  ];
  const stageUIDs = await attestMany(ctx, stageRequests);
  const byLabel = new Map<string, UID>();
  stageLabels.forEach((label, index) => byLabel.set(label, stageUIDs[index]));

  if (!fileAnchorUID) {
    fileAnchorUID = await makeAnchor(ctx, fileName, parentUID, ctx.schemas.data);
  }

  const tagDefinitions: UID[] = [];
  for (const tag of file.entry.tags ?? []) {
    tagDefinitions.push(await ensureTagDefinition(ctx, tagCache, tag));
  }
  const visibilityTags = await collectMissingVisibilityTags(ctx, parentUID);
  const pinData: AttestationData[] = [
    pinRequest(dataUID, fileAnchorUID),
    ...reserved.map(({ key }) => pinRequest(byLabel.get(`prop:${key}`)!, byLabel.get(`key:${key}`)!)),
  ];
  const tagData: AttestationData[] = [
    ...tagDefinitions.map(tagUID => tagRequest(dataUID, tagUID)),
    ...visibilityTags.map(folderUID => tagRequest(folderUID, ctx.schemas.data)),
  ];
  const commitRequests: MultiRequest[] = [{ schema: ctx.schemas.pin, data: pinData }];
  if (tagData.length > 0) commitRequests.push({ schema: ctx.schemas.tag, data: tagData });
  await attestMany(ctx, commitRequests);
  console.log(`  wrote ${file.relativePath} data=${dataUID.slice(0, 10)}... mirror=${mirrorUri}`);
}

async function ensureEntryParent(ctx: SeedContext, datasetRootUID: UID, relativePath: string): Promise<UID> {
  const dir = path.posix.dirname(relativePath.replace(/\\/g, "/"));
  if (dir === ".") return datasetRootUID;
  let parent = datasetRootUID;
  for (const segment of dir.split("/").filter(Boolean)) {
    parent = await ensureFolder(ctx, parent, segment);
  }
  return parent;
}

async function ensureAnchorPath(ctx: SeedContext, anchorPath: string): Promise<UID> {
  let parent = ctx.rootUID;
  for (const segment of anchorPath.split("/").filter(Boolean)) {
    parent = await ensureFolder(ctx, parent, segment);
  }
  return parent;
}

async function ensureFolder(ctx: SeedContext, parentUID: UID, name: string): Promise<UID> {
  const existing = await findAnchor(ctx, parentUID, name, ZeroHash);
  if (existing) return existing;
  return makeAnchor(ctx, name, parentUID, ZeroHash);
}

async function ensureTagDefinition(ctx: SeedContext, cache: Map<string, UID>, tag: string): Promise<UID> {
  if (!tag || tag.includes("/") || tag.includes("..")) throw new Error(`Invalid tag name: ${tag}`);
  const cached = cache.get(tag);
  if (cached) return cached;
  const uid = await ensureFolder(ctx, ctx.tagsRootUID, tag);
  cache.set(tag, uid);
  return uid;
}

async function makeAnchor(ctx: SeedContext, name: string, parentUID: UID, schemaUID: UID): Promise<UID> {
  const uid = await attestOne(ctx, ctx.schemas.anchor, {
    recipient: ZeroAddress,
    expirationTime: 0n,
    revocable: false,
    refUID: parentUID,
    data: ABI.encode(["string", "bytes32"], [name, schemaUID]),
    value: 0n,
  });
  console.log(`  anchor ${name} ${uid.slice(0, 10)}...`);
  return uid;
}

async function findAnchor(ctx: SeedContext, parentUID: UID, name: string, schemaUID: UID): Promise<UID | null> {
  const uid = (await ctx.indexer.resolveAnchor(parentUID, name, schemaUID)) as UID;
  return uid === ZeroHash ? null : uid;
}

async function hasActivePlacement(ctx: SeedContext, fileAnchorUID: UID): Promise<boolean> {
  const target = (await ctx.edgeResolver.getActivePinTarget(fileAnchorUID, ctx.signerAddress, ctx.schemas.data)) as UID;
  return target !== ZeroHash;
}

async function collectMissingVisibilityTags(ctx: SeedContext, parentUID: UID): Promise<UID[]> {
  const missing: UID[] = [];
  let current = parentUID;
  let walked = 0;
  while (walked < MAX_ANCHOR_DEPTH && current !== ZeroHash && current.toLowerCase() !== ctx.rootUID.toLowerCase()) {
    const tagged = (await ctx.edgeResolver.isActiveEdge(
      ctx.signerAddress,
      current,
      ctx.schemas.data,
      ctx.schemas.tag,
    )) as boolean;
    if (!tagged) missing.push(current);
    const parent = (await ctx.indexer.getParent(current)) as UID;
    if (/^0x0{24}[0-9a-fA-F]{40}$/.test(parent) && parent !== ZeroHash) break;
    current = parent;
    walked += 1;
  }
  return missing;
}

function pinRequest(targetUID: UID, definitionUID: UID): AttestationData {
  return {
    recipient: ZeroAddress,
    expirationTime: 0n,
    revocable: true,
    refUID: targetUID,
    data: ABI.encode(["bytes32"], [definitionUID]),
    value: 0n,
  };
}

function tagRequest(targetUID: UID, definitionUID: UID): AttestationData {
  return {
    recipient: ZeroAddress,
    expirationTime: 0n,
    revocable: true,
    refUID: targetUID,
    data: ABI.encode(["bytes32", "int256"], [definitionUID, 1n]),
    value: 0n,
  };
}

async function attestOne(ctx: SeedContext, schema: UID, data: AttestationData): Promise<UID> {
  const tx = await ctx.eas.attest({ schema, data });
  const uids = await uidsFromTx(ctx.eas, tx);
  if (uids.length !== 1) throw new Error(`Expected 1 Attested event, got ${uids.length}`);
  return uids[0];
}

async function attestMany(ctx: SeedContext, requests: MultiRequest[]): Promise<UID[]> {
  const tx = await ctx.eas.multiAttest(requests.filter(req => req.data.length > 0));
  return uidsFromTx(ctx.eas, tx);
}

async function uidsFromTx(eas: Contract, tx: { wait: () => Promise<{ logs: unknown[] }> }): Promise<UID[]> {
  const receipt = await tx.wait();
  const uids: UID[] = [];
  for (const log of receipt.logs) {
    try {
      const parsed = eas.interface.parseLog(log as { topics: readonly string[]; data: string });
      if (parsed?.name === "Attested") uids.push(parsed.args.uid as string);
    } catch {
      /* not an EAS Attested event */
    }
  }
  return uids;
}

async function pinFileToIpfs(apiBase: string, filePath: string, filename: string): Promise<string> {
  const url = buildIpfsAddUrl(apiBase);
  const stat = statSync(filePath);
  const boundary = `efs-seed-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  const safeFilename = filename.replace(/"/g, "");
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${safeFilename}"\r\n` +
      "Content-Type: application/octet-stream\r\n\r\n",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const contentLength = head.length + stat.size + tail.length;
  const client = url.protocol === "https:" ? https : http;

  const body = await new Promise<string>((resolve, reject) => {
    const req = client.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": contentLength,
        },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on("data", chunk => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const response = Buffer.concat(chunks).toString("utf8");
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`IPFS add failed with HTTP ${res.statusCode}: ${response.slice(0, 300)}`));
            return;
          }
          resolve(response);
        });
      },
    );
    req.on("error", reject);
    req.write(head);
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("end", () => req.end(tail));
    stream.pipe(req, { end: false });
  });

  return parseKuboAddResponse(body);
}

if (require.main === module) {
  seedDataset(parseSeedDatasetArgs(process.argv.slice(2))).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
