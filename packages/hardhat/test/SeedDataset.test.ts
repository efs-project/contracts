import { expect } from "chai";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { AbiCoder, Interface, ZeroAddress, ZeroHash, getAddress, toUtf8Bytes } from "ethers";
import { seedDataset } from "../scripts/seed-dataset";
import { canonicalContentHash } from "../scripts/seed-dataset-lib";

const ABI = AbiCoder.defaultAbiCoder();
const EAS = new Interface([
  "function getAttestation(bytes32 uid) view returns (tuple(bytes32 uid,bytes32 schema,uint64 time,uint64 expirationTime,uint64 revocationTime,bytes32 refUID,address recipient,address attester,bool revocable,bytes data))",
]);

function uid(hex: string): string {
  return `0x${hex.padStart(64, "0")}`;
}

interface SeedFixture {
  dir: string;
  manifestPath: string;
  runtime: Parameters<typeof seedDataset>[1];
  counters: { easWrites: number; tagsAnchorLookups: number; lensReads: string[] };
}

/**
 * A one-file `/games` dataset whose active placement (under `lensAddress`) already
 * carries `activeHash`. The fake signer is `signerAddress`; every EAS write throws.
 */
function buildFixture(opts: { signerAddress: string; lensAddress: string; activeHash?: string }): SeedFixture {
  const dir = mkdtempSync(path.join(tmpdir(), "efs-seed-dataset-"));
  const bytes = "<html>same</html>";
  writeFileSync(path.join(dir, "snake.html"), bytes);
  const manifestPath = path.join(dir, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      dataset: "test-games",
      anchorPath: "/games",
      files: [{ path: "snake.html", contentType: "text/html", tags: ["arcade"] }],
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
  const anchorSchema = uid("a1");
  const dataSchema = uid("d1");
  const mirrorSchema = uid("b1");
  const pinSchema = uid("c1");
  const tagSchema = uid("e1");
  const propertySchema = uid("f1");
  // Default: the CANONICAL claim of these bytes (specs/10) — what this seeder now writes,
  // so an active placement carrying it is a genuine match: nothing may be pinned or written.
  const activeHash = opts.activeHash ?? canonicalContentHash(toUtf8Bytes(bytes));

  const counters = { easWrites: 0, tagsAnchorLookups: 0, lensReads: [] as string[] };
  const fakeSigner = {
    provider: {
      call: async (tx: { data: string }) => {
        const parsed = EAS.parseTransaction({ data: tx.data });
        if (parsed?.name !== "getAttestation") throw new Error(`unexpected EAS call ${parsed?.name}`);
        const requestedUID = parsed.args.uid as string;
        if (requestedUID !== propertyUID) throw new Error(`unexpected getAttestation(${requestedUID})`);
        return EAS.encodeFunctionResult("getAttestation", [
          [
            propertyUID,
            propertySchema,
            0n,
            0n,
            0n,
            ZeroHash,
            ZeroAddress,
            lensAddress,
            false,
            ABI.encode(["string"], [activeHash]),
          ],
        ]);
      },
      getNetwork: async () => ({ chainId: 31337n, name: "hardhat" }),
    },
    call: async (tx: { data: string }) => fakeSigner.provider.call(tx),
    getAddress: async () => signerAddress,
    resolveName: async (name: string) => name,
    sendTransaction: async () => {
      counters.easWrites += 1;
      throw new Error("unexpected EAS write");
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
        return ZeroHash;
      }
      if (parent === rootUID && name === "games" && schema === ZeroHash) return gamesUID;
      if (parent === gamesUID && name === "snake.html" && schema === dataSchema) return fileAnchorUID;
      if (parent === dataUID && name === "contentHash" && schema === propertySchema) return contentHashKeyUID;
      return ZeroHash;
    },
    getParent: async () => rootUID,
  };

  const fakeEdgeResolver = {
    getActivePinTarget: async (definition: string, attester: string, schema: string) => {
      counters.lensReads.push(attester);
      // Placements exist only under the lens; reading any other attester finds nothing.
      if (attester !== lensAddress) return ZeroHash;
      if (definition === fileAnchorUID && schema === dataSchema) return dataUID;
      if (definition === contentHashKeyUID && schema === propertySchema) return propertyUID;
      return ZeroHash;
    },
    isActiveEdge: async () => false,
  };

  return {
    dir,
    manifestPath,
    counters,
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

describe("seedDataset execution boundaries", function () {
  it("does not create tags, pin to IPFS, or write EAS txs when active contentHash matches", async function () {
    const f = buildFixture({ signerAddress: SIGNER, lensAddress: SIGNER });
    try {
      await seedDataset(
        {
          manifest: f.manifestPath,
          execute: true,
          pin: true,
          plan: false,
          force: false,
          ipfsApiUrl: "http://127.0.0.1:1/api/v0",
          only: [],
        },
        f.runtime,
      );

      expect(f.counters.easWrites).to.equal(0);
      expect(f.counters.tagsAnchorLookups).to.equal(0);
    } finally {
      if (existsSync(f.dir)) rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("--plan with --attester reads that lens, so planning needs no curator key", async function () {
    // The loaded key is NOT the curator. Without --attester the plan would read the
    // wrong lens and report every live file as missing.
    const f = buildFixture({ signerAddress: SIGNER, lensAddress: CURATOR });
    try {
      await seedDataset(
        {
          manifest: f.manifestPath,
          execute: false,
          pin: false,
          plan: true,
          force: false,
          ipfsApiUrl: "http://127.0.0.1:1/api/v0",
          only: [],
          attester: CURATOR,
        },
        f.runtime,
      );

      expect(f.counters.lensReads.length).to.be.greaterThan(0);
      expect(f.counters.lensReads.every(a => a === CURATOR)).to.equal(true);
      expect(f.counters.easWrites).to.equal(0);
    } finally {
      if (existsSync(f.dir)) rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("--execute refuses to write when the loaded key is not the expected --attester", async function () {
    // Seeding under the wrong key would publish a second copy under a lens the app
    // doesn't read. It must stop before any chain read, IPFS pin or write.
    const f = buildFixture({ signerAddress: SIGNER, lensAddress: CURATOR });
    try {
      let error: unknown;
      try {
        await seedDataset(
          {
            manifest: f.manifestPath,
            execute: true,
            pin: true,
            plan: false,
            force: false,
            ipfsApiUrl: "http://127.0.0.1:1/api/v0",
            only: [],
            attester: CURATOR,
          },
          f.runtime,
        );
      } catch (err) {
        error = err;
      }
      expect(String(error)).to.match(/is not the expected attester/);
      expect(f.counters.lensReads).to.deep.equal([]);
      expect(f.counters.easWrites).to.equal(0);
    } finally {
      if (existsSync(f.dir)) rmSync(f.dir, { recursive: true, force: true });
    }
  });
});
