import { expect } from "chai";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { AbiCoder, Interface, ZeroAddress, ZeroHash, getAddress, toUtf8Bytes } from "ethers";
import { seedDataset } from "../scripts/seed-dataset";
import { SeedDatasetArgs, canonicalContentHash } from "../scripts/seed-dataset-lib";

const ABI = AbiCoder.defaultAbiCoder();
const EAS = new Interface([
  "function getAttestation(bytes32 uid) view returns (tuple(bytes32 uid,bytes32 schema,uint64 time,uint64 expirationTime,uint64 revocationTime,bytes32 refUID,address recipient,address attester,bool revocable,bytes data))",
  "function multiRevoke((bytes32 schema,(bytes32 uid,uint256 value)[] data)[] multiRequests) payable",
  "function multiAttest((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value)[] data)[] multiRequests) payable returns (bytes32[])",
]);

function uid(hex: string): string {
  return `0x${hex.padStart(64, "0")}`;
}

interface SeedFixture {
  dir: string;
  manifestPath: string;
  runtime: Parameters<typeof seedDataset>[1];
  counters: { easWrites: number; tagsAnchorLookups: number; lensReads: string[]; sentData: string[] };
  /** UID of the stale file's placement PIN, when `staleFile` was given. */
  stalePinUID: string;
  pinSchema: string;
  tagSchema: string;
  dataUID: string;
  staleDataUID: string;
  tagAnchors: Record<string, string>;
  tagUIDFor: (target: string, tag: string) => string;
}

/**
 * A one-file `/games` dataset whose active placement (under `lensAddress`) already
 * carries `activeHash`. The fake signer is `signerAddress`. `staleFile` adds a second file
 * the lens has placed under `/games` that the manifest no longer lists (for `--prune`).
 * Every EAS write is recorded in `counters.sentData`; unless `allowWrites`, it then throws.
 */
function buildFixture(opts: {
  signerAddress: string;
  lensAddress: string;
  activeHash?: string;
  chainId?: bigint;
  tags?: string[];
  staleFile?: string;
  allowWrites?: boolean;
  /** Licence on the html entry; `null` omits it. */
  license?: string | null;
  /** Tags the lens currently has on snake.html's DATA. Default: the manifest's tags. */
  activeTags?: string[];
  /** Tags the lens currently has on the stale file's DATA. */
  staleActiveTags?: string[];
}): SeedFixture {
  const dir = mkdtempSync(path.join(tmpdir(), "efs-seed-dataset-"));
  const bytes = "<html>same</html>";
  writeFileSync(path.join(dir, "snake.html"), bytes);
  const manifestPath = path.join(dir, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      dataset: "test-games",
      anchorPath: "/games",
      files: [
        {
          path: "snake.html",
          contentType: "text/html",
          tags: opts.tags ?? ["arcade"],
          ...(opts.license === null ? {} : { license: opts.license ?? "MIT" }),
        },
      ],
    }),
  );

  const { signerAddress, lensAddress } = opts;
  const rootUID = uid("01");
  const transportsUID = uid("02");
  const ipfsTransportUID = uid("03");
  const gamesUID = uid("04");
  const fileAnchorUID = uid("05");
  const dataUID = uid("06");
  const contentHashKeyUID = uid("07");
  const propertyUID = uid("08");
  const staleAnchorUID = uid("09");
  const stalePinUID = uid("0a");
  const staleDataUID = uid("0b");
  const activeMirrorUID = uid("0d");
  const staleMirrorUID = uid("0e");
  const anchorSchema = uid("a1");
  const dataSchema = uid("d1");
  const mirrorSchema = uid("b1");
  const pinSchema = uid("c1");
  const tagSchema = uid("e1");
  const propertySchema = uid("f1");
  // `/tags` and its tag anchors (each becomes a TAG definition).
  const tagsRootUID = uid("10");
  const tagAnchors: Record<string, string> = { arcade: uid("11"), oldtag: uid("12"), puzzle: uid("13") };
  const tagNameOf = (anchor: string) => Object.keys(tagAnchors).find(k => tagAnchors[k] === anchor);
  const activeTags = opts.activeTags ?? opts.tags ?? ["arcade"];
  const staleActiveTags = opts.staleActiveTags ?? [];
  /** UID of the lens's active TAG for (target, tag), derived so tests can predict it. */
  const tagUIDFor = (target: string, tag: string) => uid((target === dataUID ? "2" : "3") + tagAnchors[tag].slice(-2));
  // Default: the CANONICAL claim of these bytes (specs/10) — what this seeder now writes,
  // so an active placement carrying it is a genuine match: nothing may be pinned or written.
  const activeHash = opts.activeHash ?? canonicalContentHash(toUtf8Bytes(bytes));
  const children = opts.staleFile ? [fileAnchorUID, staleAnchorUID] : [fileAnchorUID];

  const attestation = (u: string, schema: string, attester: string, data: string) =>
    EAS.encodeFunctionResult("getAttestation", [[u, schema, 0n, 0n, 0n, ZeroHash, ZeroAddress, attester, false, data]]);

  const counters = { easWrites: 0, tagsAnchorLookups: 0, lensReads: [] as string[], sentData: [] as string[] };
  const fakeSigner = {
    provider: {
      call: async (tx: { data: string }) => {
        const parsed = EAS.parseTransaction({ data: tx.data });
        if (parsed?.name !== "getAttestation") throw new Error(`unexpected EAS call ${parsed?.name}`);
        const requestedUID = parsed.args.uid as string;
        if (requestedUID === propertyUID) {
          return attestation(propertyUID, propertySchema, lensAddress, ABI.encode(["string"], [activeHash]));
        }
        if (requestedUID === fileAnchorUID) {
          return attestation(
            fileAnchorUID,
            anchorSchema,
            lensAddress,
            ABI.encode(["string", "bytes32"], ["snake.html", dataSchema]),
          );
        }
        if (requestedUID === activeMirrorUID) {
          return attestation(
            activeMirrorUID,
            mirrorSchema,
            lensAddress,
            ABI.encode(["bytes32", "string"], [ipfsTransportUID, "ipfs://bafyoldsnake"]),
          );
        }
        if (requestedUID === staleMirrorUID) {
          return attestation(
            staleMirrorUID,
            mirrorSchema,
            lensAddress,
            ABI.encode(["bytes32", "string"], [ipfsTransportUID, "ipfs://bafyoldstale"]),
          );
        }
        const tagName = tagNameOf(requestedUID);
        if (tagName) {
          return attestation(
            requestedUID,
            anchorSchema,
            lensAddress,
            ABI.encode(["string", "bytes32"], [tagName, ZeroHash]),
          );
        }
        if (requestedUID === staleAnchorUID && opts.staleFile) {
          return attestation(
            staleAnchorUID,
            anchorSchema,
            lensAddress,
            ABI.encode(["string", "bytes32"], [opts.staleFile, dataSchema]),
          );
        }
        throw new Error(`unexpected getAttestation(${requestedUID})`);
      },
      getNetwork: async () => ({ chainId: opts.chainId ?? 31337n, name: "test" }),
      getTransactionCount: async () => 0,
      estimateGas: async () => 100000n,
      getFeeData: async () => ({ gasPrice: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
    },
    call: async (tx: { data: string }) => fakeSigner.provider.call(tx),
    getAddress: async () => signerAddress,
    resolveName: async (name: string) => name,
    sendTransaction: async (tx: { data: string }) => {
      counters.easWrites += 1;
      counters.sentData.push(tx.data);
      if (!opts.allowWrites) throw new Error("unexpected EAS write");
      return { wait: async () => ({ status: 1, logs: [] }), hash: uid("ff") };
    },
  };

  const fakeIndexer = {
    getAddress: async () => getAddress("0x0000000000000000000000000000000000001000"),
    getEAS: async () => getAddress("0x0000000000000000000000000000000000002000"),
    edgeResolver: async () => getAddress("0x0000000000000000000000000000000000003000"),
    rootAnchorUID: async () => rootUID,
    ANCHOR_SCHEMA_UID: async () => anchorSchema,
    DATA_SCHEMA_UID: async () => dataSchema,
    MIRROR_SCHEMA_UID: async () => mirrorSchema,
    PIN_SCHEMA_UID: async () => pinSchema,
    TAG_SCHEMA_UID: async () => tagSchema,
    PROPERTY_SCHEMA_UID: async () => propertySchema,
    resolvePath: async (parent: string, segment: string) => {
      if (parent === rootUID && segment === "transports") return transportsUID;
      if (parent === transportsUID && segment === "ipfs") return ipfsTransportUID;
      if (parent === rootUID && segment === "games") return gamesUID;
      return ZeroHash;
    },
    resolveAnchor: async (parent: string, name: string, schema: string) => {
      if (parent === rootUID && name === "tags" && schema === ZeroHash) {
        counters.tagsAnchorLookups += 1;
        return tagsRootUID;
      }
      if (parent === tagsRootUID && schema === ZeroHash && tagAnchors[name]) return tagAnchors[name];
      if (parent === rootUID && name === "games" && schema === ZeroHash) return gamesUID;
      if (parent === gamesUID && name === "snake.html" && schema === dataSchema) return fileAnchorUID;
      if (parent === gamesUID && opts.staleFile && name === opts.staleFile && schema === dataSchema)
        return staleAnchorUID;
      if (parent === dataUID && name === "contentHash" && schema === propertySchema) return contentHashKeyUID;
      return ZeroHash;
    },
    getChildrenCount: async (parent: string) => (parent === gamesUID ? BigInt(children.length) : 0n),
    getChildren: async (parent: string, start: bigint, length: bigint) =>
      parent === gamesUID ? children.slice(Number(start), Number(start) + Number(length)) : [],
    getParent: async (anchor: string) => (tagNameOf(anchor) ? tagsRootUID : rootUID),
    getReferencingBySchemaAndAttesterCount: async (target: string, schema: string, attester: string) =>
      attester === lensAddress && schema === mirrorSchema && (target === dataUID || target === staleDataUID) ? 1n : 0n,
    getReferencingBySchemaAndAttester: async (target: string, schema: string, attester: string) => {
      if (attester !== lensAddress || schema !== mirrorSchema) return [];
      if (target === dataUID) return [activeMirrorUID];
      if (target === staleDataUID) return [staleMirrorUID];
      return [];
    },
  };

  const fakeEdgeResolver = {
    getActivePinTarget: async (definition: string, attester: string, schema: string) => {
      counters.lensReads.push(attester);
      // Placements exist only under the lens; reading any other attester finds nothing.
      if (attester !== lensAddress) return ZeroHash;
      if (definition === fileAnchorUID && schema === dataSchema) return dataUID;
      if (definition === contentHashKeyUID && schema === propertySchema) return propertyUID;
      if (definition === staleAnchorUID && schema === dataSchema) return staleDataUID;
      return ZeroHash;
    },
    getActivePin: async (definition: string, attester: string, schema: string) => {
      counters.lensReads.push(attester);
      if (attester !== lensAddress) return ZeroHash;
      if (definition === staleAnchorUID && schema === dataSchema) return stalePinUID;
      if (definition === fileAnchorUID && schema === dataSchema) return uid("0c");
      return ZeroHash;
    },
    isActiveEdge: async () => false,
    // Definitions ever attested against a target: the placement anchor plus its tags.
    getEdgeDefinitionCount: async (target: string) =>
      BigInt(target === dataUID ? 1 + activeTags.length : target === staleDataUID ? 1 + staleActiveTags.length : 0),
    getEdgeDefinitions: async (target: string) => {
      if (target === dataUID) return [fileAnchorUID, ...activeTags.map(t => tagAnchors[t])];
      if (target === staleDataUID) return [staleAnchorUID, ...staleActiveTags.map(t => tagAnchors[t])];
      return [];
    },
    getActiveEdgeUID: async (attester: string, target: string, definition: string, schema: string) => {
      if (attester !== lensAddress || schema !== tagSchema) return ZeroHash;
      const tag = tagNameOf(definition);
      if (!tag) return ZeroHash;
      const active = target === dataUID ? activeTags : target === staleDataUID ? staleActiveTags : [];
      return active.includes(tag) ? tagUIDFor(target, tag) : ZeroHash;
    },
  };

  return {
    dir,
    manifestPath,
    counters,
    stalePinUID,
    pinSchema,
    tagSchema,
    dataUID,
    tagAnchors,
    tagUIDFor,
    staleDataUID,
    runtime: {
      getSigners: async () => [fakeSigner as any],
      getContract: async (name: string) => {
        if (name !== "Indexer") throw new Error(`unexpected getContract(${name})`);
        return fakeIndexer;
      },
      getContractAt: async (name: string) => {
        if (name !== "EdgeResolver") throw new Error(`unexpected getContractAt(${name})`);
        return fakeEdgeResolver;
      },
    },
  };
}

const SIGNER = getAddress("0x0000000000000000000000000000000000000abc");
const CURATOR = getAddress("0x0000000000000000000000000000000000000def");
const HARDHAT_DEV_KEY = getAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");

/** Execute-mode args for a fixture. The temp dataset dir is not a git checkout, so tests
 * that are not about provenance opt out of that check. */
function executeArgs(f: SeedFixture, extra: Partial<SeedDatasetArgs> = {}): SeedDatasetArgs {
  return {
    manifest: f.manifestPath,
    execute: true,
    pin: true,
    plan: false,
    force: false,
    ipfsApiUrl: "http://127.0.0.1:1/api/v0",
    only: [],
    allowUncommitted: true,
    ...extra,
  };
}

function planArgs(f: SeedFixture, extra: Partial<SeedDatasetArgs> = {}): SeedDatasetArgs {
  return { ...executeArgs(f), execute: false, pin: false, plan: true, ...extra };
}

async function captureLogs(run: () => Promise<void>): Promise<{ lines: string[]; error: unknown }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => lines.push(parts.map(String).join(" "));
  let error: unknown;
  try {
    await run();
  } catch (err) {
    error = err;
  } finally {
    console.log = original;
  }
  return { lines, error };
}

function cleanup(f: SeedFixture) {
  if (existsSync(f.dir)) rmSync(f.dir, { recursive: true, force: true });
}

describe("seedDataset execution boundaries", function () {
  it("does not create tags, pin to IPFS, or write EAS txs when active contentHash matches", async function () {
    const f = buildFixture({ signerAddress: SIGNER, lensAddress: SIGNER });
    try {
      await seedDataset(executeArgs(f), f.runtime);
      expect(f.counters.easWrites).to.equal(0);
    } finally {
      cleanup(f);
    }
  });

  it("--plan with --attester reads that lens, so planning needs no curator key", async function () {
    // The loaded key is NOT the curator. Without --attester the plan would read the
    // wrong lens and report every live file as missing.
    const f = buildFixture({ signerAddress: SIGNER, lensAddress: CURATOR });
    try {
      await seedDataset(planArgs(f, { attester: CURATOR }), f.runtime);
      expect(f.counters.lensReads.length).to.be.greaterThan(0);
      expect(f.counters.lensReads.every(a => a === CURATOR)).to.equal(true);
      expect(f.counters.easWrites).to.equal(0);
    } finally {
      cleanup(f);
    }
  });

  it("--execute refuses to write when the loaded key is not the expected --attester", async function () {
    // Seeding under the wrong key would publish a second copy under a lens the app
    // doesn't read. It must stop before any chain read, IPFS pin or write.
    const f = buildFixture({ signerAddress: SIGNER, lensAddress: CURATOR });
    try {
      const { error } = await captureLogs(() => seedDataset(executeArgs(f, { attester: CURATOR }), f.runtime));
      expect(String(error)).to.match(/is not the expected attester/);
      expect(f.counters.lensReads).to.deep.equal([]);
      expect(f.counters.easWrites).to.equal(0);
    } finally {
      cleanup(f);
    }
  });
});

describe("seedDataset safety rails", function () {
  const savedRoot = process.env.DATASET_ROOT;
  afterEach(function () {
    if (savedRoot === undefined) delete process.env.DATASET_ROOT;
    else process.env.DATASET_ROOT = savedRoot;
  });

  it("--plan and --execute need an explicit content source, never a guessed sibling folder", async function () {
    // Default discovery once resolved to a stale, untracked copy of the datasets.
    delete process.env.DATASET_ROOT;
    const f = buildFixture({ signerAddress: SIGNER, lensAddress: SIGNER });
    try {
      for (const args of [executeArgs(f, { manifest: "" }), planArgs(f, { manifest: "" })]) {
        const { error } = await captureLogs(() => seedDataset(args, f.runtime));
        expect(String(error)).to.match(/explicit content source/);
      }
      expect(f.counters.lensReads).to.deep.equal([]);
    } finally {
      cleanup(f);
    }
  });

  it("--execute refuses content that is not a clean git checkout", async function () {
    // Publishing is permanent, so the run must be traceable to a commit of the content repo.
    const f = buildFixture({ signerAddress: SIGNER, lensAddress: SIGNER });
    try {
      const { error } = await captureLogs(() => seedDataset(executeArgs(f, { allowUncommitted: false }), f.runtime));
      expect(String(error)).to.match(/not a git checkout|uncommitted/);
      expect(f.counters.lensReads).to.deep.equal([]);
      expect(f.counters.easWrites).to.equal(0);
    } finally {
      cleanup(f);
    }
  });

  it("--execute on a live chain requires --attester", async function () {
    const f = buildFixture({ signerAddress: CURATOR, lensAddress: CURATOR, chainId: 11155111n });
    try {
      const { error } = await captureLogs(() => seedDataset(executeArgs(f), f.runtime));
      expect(String(error)).to.match(/--attester is required/);
      expect(f.counters.easWrites).to.equal(0);
    } finally {
      cleanup(f);
    }
  });

  it("--execute on a live chain refuses the public Hardhat development key", async function () {
    // Anyone holds that key, so anyone could revoke what it publishes.
    const f = buildFixture({ signerAddress: HARDHAT_DEV_KEY, lensAddress: HARDHAT_DEV_KEY, chainId: 11155111n });
    try {
      const { error } = await captureLogs(() => seedDataset(executeArgs(f, { attester: HARDHAT_DEV_KEY }), f.runtime));
      expect(String(error)).to.match(/public Hardhat development key/);
      expect(f.counters.easWrites).to.equal(0);
    } finally {
      cleanup(f);
    }
  });

  it("rejects a tag the chain would reject before any read or write", async function () {
    // A bad tag used to revert mid-file, after DATA and PROPERTYs were already permanent.
    const f = buildFixture({ signerAddress: SIGNER, lensAddress: SIGNER, tags: ["bad tag"] });
    try {
      const { error } = await captureLogs(() => seedDataset(executeArgs(f), f.runtime));
      expect(String(error)).to.match(/tag/i);
      expect(f.counters.lensReads).to.deep.equal([]);
      expect(f.counters.easWrites).to.equal(0);
    } finally {
      cleanup(f);
    }
  });
});

describe("seedDataset --prune", function () {
  it("--plan --prune lists files the lens placed that the manifest no longer has", async function () {
    const f = buildFixture({ signerAddress: SIGNER, lensAddress: CURATOR, staleFile: "old.html" });
    try {
      const { lines, error } = await captureLogs(() =>
        seedDataset(planArgs(f, { attester: CURATOR, prune: true }), f.runtime),
      );
      expect(error).to.equal(undefined);
      expect(lines.some(l => /plan remove\s+old\.html/.test(l))).to.equal(true);
      expect(lines.some(l => /plan remove\s+snake\.html/.test(l))).to.equal(false);
      expect(lines.some(l => /removals=1/.test(l))).to.equal(true);
      expect(f.counters.easWrites).to.equal(0);
    } finally {
      cleanup(f);
    }
  });

  it("--plan without --prune still reports unlisted files, as a warning", async function () {
    const f = buildFixture({ signerAddress: SIGNER, lensAddress: CURATOR, staleFile: "old.html" });
    try {
      const { lines } = await captureLogs(() => seedDataset(planArgs(f, { attester: CURATOR }), f.runtime));
      expect(lines.some(l => /not in manifest/.test(l) && /old\.html/.test(l))).to.equal(true);
      expect(lines.some(l => /plan remove/.test(l))).to.equal(false);
    } finally {
      cleanup(f);
    }
  });

  it("--execute --prune revokes only the unlisted file's placement PIN, in one multiRevoke", async function () {
    const f = buildFixture({ signerAddress: SIGNER, lensAddress: SIGNER, staleFile: "old.html", allowWrites: true });
    try {
      const { error } = await captureLogs(() => seedDataset(executeArgs(f, { prune: true }), f.runtime));
      expect(error).to.equal(undefined);
      expect(f.counters.sentData.length).to.equal(1);
      const parsed = EAS.parseTransaction({ data: f.counters.sentData[0] });
      expect(parsed?.name).to.equal("multiRevoke");
      const requests = parsed!.args[0];
      const pinRequest = requests.find((r: { schema: string }) => r.schema === f.pinSchema);
      expect(pinRequest.data.map((d: { uid: string }) => d.uid)).to.deep.equal([f.stalePinUID]);
    } finally {
      cleanup(f);
    }
  });

  it("refuses --prune with --only, which would remove every file it wasn't told about", async function () {
    const f = buildFixture({ signerAddress: SIGNER, lensAddress: SIGNER, staleFile: "old.html" });
    try {
      const { error } = await captureLogs(() =>
        seedDataset(planArgs(f, { prune: true, only: ["snake.html"] }), f.runtime),
      );
      expect(String(error)).to.match(/--prune.*--only|--only.*--prune/);
    } finally {
      cleanup(f);
    }
  });
});

describe("seedDataset licences and unpin list", function () {
  it("refuses a media file (games, images, audio, video) with no licence, before any read", async function () {
    const f = buildFixture({ signerAddress: SIGNER, lensAddress: SIGNER, license: null });
    try {
      const { error } = await captureLogs(() => seedDataset(planArgs(f), f.runtime));
      expect(String(error)).to.match(/licen[cs]e/i);
      expect(String(error)).to.match(/snake\.html/);
      expect(f.counters.lensReads).to.deep.equal([]);
    } finally {
      cleanup(f);
    }
  });

  it("does not require a licence on text documents", async function () {
    const dir = mkdtempSync(path.join(tmpdir(), "efs-seed-doc-"));
    try {
      writeFileSync(path.join(dir, "paper.md"), "# Paper");
      writeFileSync(
        path.join(dir, "manifest.json"),
        JSON.stringify({
          dataset: "docs",
          anchorPath: "/docs",
          files: [{ path: "paper.md", contentType: "text/markdown" }],
        }),
      );
      const { error } = await captureLogs(() =>
        seedDataset(
          {
            manifest: path.join(dir, "manifest.json"),
            execute: false,
            plan: false,
            pin: false,
            force: false,
            ipfsApiUrl: "",
            only: [],
          },
          undefined,
        ),
      );
      expect(error).to.equal(undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--plan lists the IPFS CIDs a run would make obsolete (changed and removed files)", async function () {
    // A changed file gets a new DATA and a new CID; its old CID is no longer needed.
    // A pruned file's CID likewise. Heals keep the same bytes, so they retire nothing.
    const f = buildFixture({
      signerAddress: SIGNER,
      lensAddress: CURATOR,
      activeHash: "f1220" + "00".repeat(32),
      staleFile: "old.html",
    });
    try {
      const { lines, error } = await captureLogs(() =>
        seedDataset(planArgs(f, { attester: CURATOR, prune: true }), f.runtime),
      );
      expect(error).to.equal(undefined);
      const block = lines.join("\n");
      expect(block).to.match(/unpin/i);
      expect(block).to.match(/bafyoldsnake\s+\/games\/snake\.html/);
      expect(block).to.match(/bafyoldstale\s+\/games\/old\.html/);
    } finally {
      cleanup(f);
    }
  });
});

describe("seedDataset tag reconciliation", function () {
  const decodeTagTarget = (data: string) => ABI.decode(["bytes32", "int256"], data)[0] as string;

  it("--plan reports tag drift on a file whose bytes are unchanged", async function () {
    // Heal and skip used to return before tags were looked at, so stale tags lived on.
    const f = buildFixture({
      signerAddress: SIGNER,
      lensAddress: CURATOR,
      tags: ["arcade", "puzzle"],
      activeTags: ["arcade", "oldtag"],
    });
    try {
      const { lines, error } = await captureLogs(() => seedDataset(planArgs(f, { attester: CURATOR }), f.runtime));
      expect(error).to.equal(undefined);
      const tagLine = lines.find(l => /plan tags\s+snake\.html/.test(l));
      expect(tagLine, lines.join("\n")).to.match(/\+puzzle/);
      expect(tagLine).to.match(/-oldtag/);
      expect(lines.some(l => /tagChanges=1/.test(l))).to.equal(true);
      expect(f.counters.easWrites).to.equal(0);
    } finally {
      cleanup(f);
    }
  });

  it("--execute adds missing tags and revokes stale ones on an unchanged file", async function () {
    const f = buildFixture({
      signerAddress: SIGNER,
      lensAddress: SIGNER,
      tags: ["arcade", "puzzle"],
      activeTags: ["arcade", "oldtag"],
      allowWrites: true,
    });
    try {
      const { error } = await captureLogs(() => seedDataset(executeArgs(f), f.runtime));
      expect(error).to.equal(undefined);
      const calls = f.counters.sentData.map(d => EAS.parseTransaction({ data: d }));
      const attest = calls.find(c => c?.name === "multiAttest");
      const revoke = calls.find(c => c?.name === "multiRevoke");
      expect(attest, "missing tag attested").to.not.equal(undefined);
      const [attestReq] = attest!.args[0];
      expect(attestReq.schema).to.equal(f.tagSchema);
      expect(attestReq.data.map((d: { refUID: string }) => d.refUID)).to.deep.equal([f.dataUID]);
      expect(attestReq.data.map((d: { data: string }) => decodeTagTarget(d.data))).to.deep.equal([f.tagAnchors.puzzle]);
      expect(revoke, "stale tag revoked").to.not.equal(undefined);
      const [revokeReq] = revoke!.args[0];
      expect(revokeReq.schema).to.equal(f.tagSchema);
      expect(revokeReq.data.map((d: { uid: string }) => d.uid)).to.deep.equal([f.tagUIDFor(f.dataUID, "oldtag")]);
    } finally {
      cleanup(f);
    }
  });

  it("is a no-op when the tags already match", async function () {
    const f = buildFixture({ signerAddress: SIGNER, lensAddress: SIGNER, tags: ["arcade"], activeTags: ["arcade"] });
    try {
      const { error } = await captureLogs(() => seedDataset(executeArgs(f), f.runtime));
      expect(error).to.equal(undefined);
      expect(f.counters.easWrites).to.equal(0);
    } finally {
      cleanup(f);
    }
  });

  it("--plan lists the tags a republished file leaves behind on its old copy", async function () {
    // A write mints a new DATA; the old DATA's tags would keep it listed under /tags.
    const f = buildFixture({
      signerAddress: SIGNER,
      lensAddress: CURATOR,
      activeHash: "f1220" + "00".repeat(32),
      tags: ["arcade"],
      activeTags: ["arcade", "oldtag"],
    });
    try {
      const { lines, error } = await captureLogs(() => seedDataset(planArgs(f, { attester: CURATOR }), f.runtime));
      expect(error).to.equal(undefined);
      const untag = lines.find(l => /plan untag\s+snake\.html/.test(l));
      expect(untag, lines.join("\n")).to.match(/arcade/);
      expect(untag).to.match(/oldtag/);
    } finally {
      cleanup(f);
    }
  });

  it("--execute --prune also revokes the removed file's tags", async function () {
    const f = buildFixture({
      signerAddress: SIGNER,
      lensAddress: SIGNER,
      staleFile: "old.html",
      staleActiveTags: ["arcade"],
      allowWrites: true,
    });
    try {
      const { error } = await captureLogs(() => seedDataset(executeArgs(f, { prune: true }), f.runtime));
      expect(error).to.equal(undefined);
      const revoke = f.counters.sentData
        .map(d => EAS.parseTransaction({ data: d }))
        .find(c => c?.name === "multiRevoke");
      const tagReq = revoke!.args[0].find((r: { schema: string }) => r.schema === f.tagSchema);
      expect(tagReq.data.map((d: { uid: string }) => d.uid)).to.deep.equal([f.tagUIDFor(f.staleDataUID, "arcade")]);
    } finally {
      cleanup(f);
    }
  });
});

describe("seedDataset run record", function () {
  it("--execute writes an append-only record: header, actions, unpin list, summary", async function () {
    // Written as the run goes, so a crash mid-run still leaves the unpin list behind.
    const f = buildFixture({ signerAddress: SIGNER, lensAddress: SIGNER, staleFile: "old.html", allowWrites: true });
    const recordDir = mkdtempSync(path.join(tmpdir(), "efs-seed-record-"));
    try {
      const { error } = await captureLogs(() => seedDataset(executeArgs(f, { prune: true, recordDir }), f.runtime));
      expect(error).to.equal(undefined);
      const chainDir = path.join(recordDir, "31337");
      const [file] = readdirSync(chainDir);
      expect(file).to.match(/^seed-.*\.ndjson$/);
      const events = readFileSync(path.join(chainDir, file), "utf8")
        .trim()
        .split("\n")
        .map(line => JSON.parse(line));
      expect(events[0].type).to.equal("run");
      expect(events[0].signer).to.equal(SIGNER);
      expect(events.some(e => e.type === "file" && e.action === "skip" && e.path === "/games/snake.html")).to.equal(
        true,
      );
      expect(events.some(e => e.type === "remove" && e.path === "/games/old.html")).to.equal(true);
      expect(events.some(e => e.type === "unpin" && e.cid === "bafyoldstale")).to.equal(true);
      expect(events.some(e => e.type === "tx")).to.equal(true);
      expect(events[events.length - 1].type).to.equal("summary");
    } finally {
      cleanup(f);
      rmSync(recordDir, { recursive: true, force: true });
    }
  });
});
