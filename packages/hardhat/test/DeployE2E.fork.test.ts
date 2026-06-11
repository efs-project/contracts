import { expect } from "chai";
import fs from "fs";
import path from "path";
import { Contract, ZeroAddress, ZeroHash } from "ethers";
import hre, { ethers, network, deployments } from "hardhat";
import { CREATEX_ADDRESS, EAS_ADDRESS } from "../deploy-lib/addresses";
import { orchestrate } from "../deploy-lib/orchestrate";
import { ResolverName } from "../deploy-lib/schemas";
import { deployViews } from "../deploy-lib/views";

// Full round-trip end-to-end fork test (the deferred "D2" e2e). Proves the deployed CREATE3 proxies
// (frozen foundation) + the stateless read views (EFSRouter / EFSFileView / ListReader) actually work
// together: WRITE a real anchor + DATA + PIN placement + ancestor TAG + LIST + LIST_ENTRY, then READ
// it all back THROUGH the views and assert the returned data matches what was written.
//
// Requires the pinned Sepolia fork (CreateX + EAS present). Run with:
//   MAINNET_FORKING_ENABLED=true npx hardhat test test/DeployE2E.fork.test.ts --network hardhat
//
// When not forking (CreateX absent), the suite skips itself so the default `yarn hardhat test` unit
// suite stays unaffected and does NOT require forking.
describe("DeployE2E.fork — frozen foundation + views round-trip", function () {
  this.timeout(240_000);

  let forked = false;

  // EAS minimal iface for the test writes/reads.
  const EAS_IFACE = [
    "function attest((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value) data)) payable returns (bytes32)",
    "event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)",
  ];

  before(async function () {
    const code = await ethers.provider.getCode(CREATEX_ADDRESS);
    forked = code !== "0x";
    if (!forked) {
      console.log("    (skipping DeployE2E.fork — CreateX not present; run with MAINNET_FORKING_ENABLED=true)");
      this.skip();
      return;
    }
    // The in-memory fork is fresh every run, but hardhat-deploy persists deployment records to
    // deployments/hardhat/*.json. A prior run's records point at txs that don't exist on this fresh
    // fork, which makes hardhat-deploy throw ("cannot get the transaction for ... previous
    // deployment"). Wipe the records this rehearsal owns so each run deploys clean. (Test-only: the
    // real deploy:efs-views on a persistent network keeps its records.)
    const dir = path.join(hre.config.paths.deployments, hre.network.name);
    for (const name of [
      "EFSFileView",
      "EFSRouter",
      "ListReader",
      "Indexer",
      "EdgeResolver",
      "MirrorResolver",
      "ListResolver",
      "ListEntryResolver",
      "AliasResolver",
    ]) {
      const f = path.join(dir, `${name}.json`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it("writes anchor+DATA+PIN+TAG+LIST+LIST_ENTRY, reads it all back through EFSRouter/EFSFileView/ListReader", async function () {
    const [deployer, safeSigner] = await ethers.getSigners();
    const deployerAddr = await deployer.getAddress();
    process.env.EFS_SAFE_ADDRESS = await safeSigner.getAddress();

    // ── 1. Frozen foundation (deploy + register-last + transfer-to-Safe + per-schema smoke) ──────
    const result = await orchestrate(deployer, "full", false);
    expect(result.registered, "9 schemas registered").to.equal(true);
    expect(result.ownershipTransferred, "ownership transferred to Safe").to.equal(true);
    const { proxies, schemaUIDs } = result;

    // Save the proxies as hardhat-deploy named deployments exactly as deploy/00_efs_core.ts does, so
    // deployViews() resolves them by the same handles the real post-freeze deploy uses.
    const saveAs: Record<string, ResolverName> = {
      Indexer: "EFSIndexer",
      EdgeResolver: "EdgeResolver",
      MirrorResolver: "MirrorResolver",
      ListResolver: "ListResolver",
      ListEntryResolver: "ListEntryResolver",
      AliasResolver: "AliasResolver",
    };
    for (const [name, resolver] of Object.entries(saveAs)) {
      const artifact = await deployments.getArtifact(resolver);
      await deployments.save(name, {
        address: (proxies as Record<string, string>)[resolver],
        abi: artifact.abi,
      });
    }
    // Save SystemAccount (ADR-0053) as 00_efs_core.ts does, so deployViews() wires the router's
    // default-lens fallback to it.
    {
      const artifact = await deployments.getArtifact("SystemAccount");
      await deployments.save("SystemAccount", { address: result.systemAccount, abi: artifact.abi });
    }

    // ── 2. Deploy the 3 stateless views against the proxies (the post-freeze view deploy) ────────
    const views = await deployViews(hre);
    const fileView = (await ethers.getContractAt("EFSFileView", views.efsFileView, deployer)) as unknown as Contract;
    const router = (await ethers.getContractAt("EFSRouter", views.efsRouter, deployer)) as unknown as Contract;
    const listReader = (await ethers.getContractAt("ListReader", views.listReader, deployer)) as unknown as Contract;

    // Views must bind to the FROZEN UIDs read off the proxies — guard against a view that silently
    // reads a different UID than the one registered (would be freeze-relevant).
    expect((await router.dataSchemaUID()).toLowerCase(), "router bound to frozen DATA UID").to.equal(
      schemaUIDs.DATA.toLowerCase(),
    );
    // ADR-0053: the router's default-lens fallback points at SystemAccount (the `system` lens),
    // not the deployer EOA.
    expect((await router.systemAccount()).toLowerCase(), "router default-lens fallback == SystemAccount").to.equal(
      result.systemAccount.toLowerCase(),
    );

    // Bootstrap scaffolding (root) is authored by the SystemAccount address (attester check).
    const easRead = new ethers.Contract(
      EAS_ADDRESS,
      [
        ...EAS_IFACE,
        "function getAttestation(bytes32) view returns (tuple(bytes32 uid,bytes32 schema,uint64 time,uint64 expirationTime,uint64 revocationTime,bytes32 refUID,address recipient,address attester,bool revocable,bytes data))",
      ],
      deployer,
    );
    const rootForAttester: string = await (
      await ethers.getContractAt("EFSIndexer", proxies.EFSIndexer, deployer)
    ).rootAnchorUID();
    const rootAtt = await easRead.getAttestation(rootForAttester);
    expect(rootAtt.attester.toLowerCase(), "root anchor authored by SystemAccount").to.equal(
      result.systemAccount.toLowerCase(),
    );
    expect(rootAtt.attester.toLowerCase(), "root anchor NOT authored by deployer EOA").to.not.equal(
      deployerAddr.toLowerCase(),
    );

    // ── 3. WRITE a real round-trip via EAS against the registered schemas ────────────────────────
    const indexer = (await ethers.getContractAt("EFSIndexer", proxies.EFSIndexer, deployer)) as unknown as Contract;
    const eas = new ethers.Contract(EAS_ADDRESS, EAS_IFACE, deployer);
    const abi = ethers.AbiCoder.defaultAbiCoder();

    const attestedUID = (receipt: any): string => {
      for (const log of receipt?.logs ?? []) {
        try {
          const parsed = eas.interface.parseLog({ topics: log.topics, data: log.data });
          if (parsed?.name === "Attested") return parsed.args.uid;
        } catch {
          /* not Attested */
        }
      }
      return ZeroHash;
    };
    const attest = async (
      schema: string,
      data: string,
      refUID = ZeroHash,
      revocable = true,
      recipient = ZeroAddress,
    ) => {
      const tx = await eas.attest({
        schema,
        data: { recipient, expirationTime: 0, revocable, refUID, data, value: 0 },
      });
      return attestedUID(await tx.wait());
    };

    const rootUID: string = await indexer.rootAnchorUID();
    expect(rootUID, "root anchor exists from core").to.not.equal(ZeroHash);

    // (a) ANCHOR — a file node "e2e-report.txt" under root.
    const fileName = "e2e-report.txt";
    const fileAnchor = await attest(
      schemaUIDs.ANCHOR,
      abi.encode(["string", "bytes32"], [fileName, ZeroHash]),
      rootUID,
      false,
    );
    expect(fileAnchor, "file anchor created").to.not.equal(ZeroHash);

    // (b) DATA — empty attestation, pure file identity (ADR-0049).
    const dataUID = await attest(schemaUIDs.DATA, "0x", ZeroHash, false);
    expect(dataUID, "DATA created").to.not.equal(ZeroHash);

    // (c) PIN — place DATA at the file anchor (cardinality 1 file placement).
    await attest(schemaUIDs.PIN, abi.encode(["bytes32"], [fileAnchor]), dataUID, true);

    // (c2) MIRROR — a retrieval URI on the DATA so the router can serve it (else 404 "no mirror").
    //      transportDefinition must be a descendant of /transports/ (the core created /transports/ipfs).
    const ipfsTransport: string = await indexer.resolvePath(result.transportsAnchorUID, "ipfs");
    expect(ipfsTransport, "/transports/ipfs anchor present from core").to.not.equal(ZeroHash);
    const mirrorURI = "ipfs://bafye2eround-trip";
    await attest(schemaUIDs.MIRROR, abi.encode(["bytes32", "string"], [ipfsTransport, mirrorURI]), dataUID, true);

    // (d) TAG — DATA-schema visibility on root so the deployer's lens listing surfaces the file.
    await attest(schemaUIDs.TAG, abi.encode(["bytes32", "int256"], [schemaUIDs.DATA, 1]), rootUID, true);

    // (e) LIST — a SCHEMA-typed (targetType=2) curated collection of DATA UIDs. revocable:false.
    const listUID = await attest(
      schemaUIDs.LIST,
      abi.encode(["bool", "bool", "uint8", "bytes32", "uint256"], [false, false, 2 /* SCHEMA */, schemaUIDs.DATA, 0]),
      ZeroHash,
      false,
    );
    expect(listUID, "LIST created").to.not.equal(ZeroHash);

    // (f) LIST_ENTRY — add our DATA UID as a member of the list.
    const listEntryUID = await attest(
      schemaUIDs.LIST_ENTRY,
      abi.encode(["bytes32", "bytes32"], [listUID, dataUID]),
      ZeroHash,
      true,
    );
    expect(listEntryUID, "LIST_ENTRY created").to.not.equal(ZeroHash);

    // ── 4. READ IT ALL BACK THROUGH THE VIEWS — real assertions, no false-greens ──────────────────

    // (i) EFSRouter path resolution (ERC-5219): walk root → file anchor → PIN → DATA → MIRROR.
    //     The kernel's resolvePath drives the walk; assert the file anchor resolves under root, then
    //     exercise request() and assert it returns 200 with the ipfs:// mirror as a message/external-
    //     body redirect (the real served read for a non-web3 transport).
    expect((await indexer.resolvePath(rootUID, fileName)).toLowerCase(), "router-walk resolves file anchor").to.equal(
      fileAnchor.toLowerCase(),
    );
    const [statusCode, body, headers] = await router.request([fileName], []);
    expect(Number(statusCode), "EFSRouter.request served the file (200)").to.equal(200);
    const ctHeader = headers.find((h: any) => h.key.toLowerCase() === "content-type");
    expect(ctHeader, "router returned a Content-Type header").to.not.equal(undefined);
    expect(ctHeader.value, "router external-body points at the written ipfs mirror").to.contain(mirrorURI);
    void body;

    // (ii) EFSFileView listing: read the DATA placed (PINned) at our file anchor through the view,
    //      scoped to the deployer's lens. The returned item's UID must be the exact DATA we wrote.
    const page = await fileView.getFilesAtPath(fileAnchor, [deployerAddr], schemaUIDs.DATA, "0x", 50);
    const listedUIDs: string[] = page.items.map((i: any) => i.uid.toLowerCase());
    expect(listedUIDs, "EFSFileView returns the placed DATA at the file anchor").to.include(dataUID.toLowerCase());

    // (iii) ListReader: mode, length, and the entry's target read back as the DATA UID we added.
    const mode = await listReader.getMode(listUID);
    expect(mode.exists, "ListReader sees the list").to.equal(true);
    expect(mode.curator.toLowerCase(), "list curator == deployer").to.equal(deployerAddr.toLowerCase());
    expect(Number(mode.targetType), "SCHEMA-typed list").to.equal(2);

    expect(Number(await listReader.length(listUID, deployerAddr)), "list length == 1").to.equal(1);
    const entries = await listReader.entries(listUID, deployerAddr, 0, 10);
    expect(entries.length, "one entry").to.equal(1);
    expect(entries[0].entryUID.toLowerCase(), "entry UID matches written LIST_ENTRY").to.equal(
      listEntryUID.toLowerCase(),
    );
    const target = await listReader.targetAsUID(listUID, deployerAddr, listEntryUID);
    expect(target.toLowerCase(), "ListReader returns the DATA UID written into the list").to.equal(
      dataUID.toLowerCase(),
    );

    console.log("    [e2e] anchor created:", fileAnchor);
    console.log("    [e2e] DATA placed (PIN) at anchor:", dataUID);
    console.log("    [e2e] EFSRouter.request status:", Number(statusCode), "(non-404 = resolved)");
    console.log("    [e2e] EFSFileView listed DATA at root:", listedUIDs.includes(dataUID.toLowerCase()));
    console.log("    [e2e] ListReader read entry target back:", target, "== DATA", dataUID);
  });

  after(function () {
    delete process.env.EFS_SAFE_ADDRESS;
    void network;
  });
});
