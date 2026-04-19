/**
 * EFS Seed — implementation module.
 *
 * Creates a small realistic file tree for manual UI testing:
 *
 *   /docs/
 *     readme.txt   (owner edition)
 *     notes.txt    (owner edition)
 *   /images/
 *     cat.jpg      (owner edition, https mirror)
 *     dog.jpg      (owner edition, https mirror)
 *   /shared/
 *     photo.png    (owner edition + user1 edition — editions demo)
 *
 * This file exports `seedDemoTree` as a pure function — no auto-invocation at
 * module load — so it can be imported safely from both:
 *   - `scripts/seed.ts` (the `yarn hardhat:seed` CLI wrapper)
 *   - `deploy/08_seed_demo_tree.ts` (the hardhat-deploy step)
 * Two callers can coexist without double-running; only whoever explicitly
 * invokes `seedDemoTree()` triggers execution.
 *
 * Each file uses the current three-layer model (ADR-0001/0002/0005/0035):
 *   - Anchor (filename with schema=DATA_SCHEMA_UID → "file slot")
 *   - DATA (standalone, refUID=0x0, encodes contentHash + size)
 *   - PROPERTY contentType via ADR-0035 three-attestation dance
 *     (key-anchor under DATA + free-floating PROPERTY(value) + TAG binding)
 *   - MIRROR (refUID=DATA, refs a /transports/* anchor, carries URI)
 *   - TAG (refUID=DATA, definition=fileAnchorUID, applies=true → placement)
 *
 * Idempotency: each top-level seed subtree (/docs/, /images/, /shared/) is
 * independently guarded via `resolveAnchor(rootUID, name, 0)`. Re-running after
 * a successful seed is a no-op (three read calls, zero writes). Re-running
 * after a partial failure mid-subtree will skip that whole subtree on retry.
 *
 * Fail-soft at the top: if the Indexer contract isn't registered (e.g. CI
 * against vanilla hardhat without EAS), log a skip and return cleanly — don't
 * break the deploy flow for environments that don't have EAS state.
 */

import { ethers, getNamedAccounts } from "hardhat";
import { EFSIndexer } from "../typechain-types";

export async function seedDemoTree() {
  const { deployer } = await getNamedAccounts();
  const deployerSigner = await ethers.getSigner(deployer);
  const [, user1] = await ethers.getSigners();

  console.log("═══════════════════════════════════════");
  console.log("  EFS Seed Script");
  console.log("═══════════════════════════════════════\n");
  console.log(`Deployer: ${deployer}`);
  console.log(`User1:    ${await user1.getAddress()}\n`);

  // ── Connect to contracts ─────────────────────────────────────────────────────

  // Fail-soft lookup: if deploy didn't register `Indexer` (e.g. CI running against
  // a vanilla hardhat node with no Sepolia EAS), exit cleanly so that chaining
  // seed into `hardhat deploy` doesn't break environments where the deploy
  // itself is expected to be partial. Real deploys (local fork, devnet,
  // mainnet) always register the Indexer → this branch never triggers there.
  let indexer: EFSIndexer;
  try {
    indexer = (await ethers.getContract("Indexer", deployerSigner)) as unknown as EFSIndexer;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`⏭️  Seed skipped — Indexer contract not found (${msg.split("\n")[0]}).`);
    console.log("   This is expected when deploy targeted a chain without EAS (e.g. CI without fork).");
    return;
  }
  const easAddr = await indexer.getEAS();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const eas = (await ethers.getContractAt(
    "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol:IEAS",
    easAddr,
  )) as any;

  const anchorSchemaUID = await indexer.ANCHOR_SCHEMA_UID();
  const dataSchemaUID = await indexer.DATA_SCHEMA_UID();
  const mirrorSchemaUID = await indexer.MIRROR_SCHEMA_UID();
  const tagSchemaUID = await indexer.TAG_SCHEMA_UID();
  const propertySchemaUID = await indexer.PROPERTY_SCHEMA_UID();
  const rootUID = await indexer.rootAnchorUID();
  const encode = ethers.AbiCoder.defaultAbiCoder();

  // Resolve /transports/ anchors for MIRRORs. Registered by deploy script
  // 05_mirrors.ts (names: onchain, ipfs, arweave, magnet, https).
  const transportsUID = await indexer.resolvePath(rootUID, "transports");
  const httpsTransportUID = await indexer.resolvePath(transportsUID, "https");
  const ipfsTransportUID = await indexer.resolvePath(transportsUID, "ipfs");

  console.log(`Indexer:  ${indexer.target}`);
  console.log(`Root:     ${rootUID}`);
  console.log(`/transports/https:  ${httpsTransportUID.slice(0, 14)}…`);
  console.log(`/transports/ipfs:   ${ipfsTransportUID.slice(0, 14)}…\n`);

  // ── Helpers ──────────────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getUID = async (tx: any): Promise<string> => {
    const receipt = await tx.wait();
    for (const log of receipt.logs) {
      try {
        const parsed = eas.interface.parseLog(log);
        if (parsed?.name === "Attested") return parsed.args.uid as string;
      } catch {}
    }
    throw new Error("Attested event not found in receipt");
  };

  /** Create an ANCHOR attestation. schema=ZeroHash → generic folder; schema=DATA_SCHEMA_UID → file slot. */
  const makeAnchor = async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signer: any,
    name: string,
    parentUID: string,
    schema: string = ethers.ZeroHash,
  ): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ethers.ZeroAddress,
        expirationTime: 0n,
        revocable: false,
        refUID: parentUID,
        data: encode.encode(["string", "bytes32"], [name, schema]),
        value: 0n,
      },
    });
    const uid = await getUID(tx);
    console.log(`  Anchor    "${name}"  ${uid.slice(0, 10)}…`);
    return uid;
  };

  /** Create a standalone DATA attestation (ADR-0002: refUID=0x0, non-revocable, (contentHash, size)). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makeData = async (signer: any, content: string): Promise<string> => {
    const contentBytes = ethers.toUtf8Bytes(content);
    const contentHash = ethers.keccak256(contentBytes);
    const size = contentBytes.length;
    const tx = await eas.connect(signer).attest({
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
    const uid = await getUID(tx);
    console.log(`  Data      ${uid.slice(0, 10)}…  (hash=${contentHash.slice(0, 10)}…, size=${size})`);
    return uid;
  };

  /** Create a MIRROR attestation on a DATA (ADR-0011: transport is a /transports/* anchor UID). */
  const makeMirror = async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signer: any,
    dataUID: string,
    transportUID: string,
    uri: string,
  ): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: mirrorSchemaUID,
      data: {
        recipient: ethers.ZeroAddress,
        expirationTime: 0n,
        revocable: true,
        refUID: dataUID,
        data: encode.encode(["bytes32", "string"], [transportUID, uri]),
        value: 0n,
      },
    });
    const uid = await getUID(tx);
    console.log(`  Mirror    ${uid.slice(0, 10)}…  →  ${uri}`);
    return uid;
  };

  /** Create a TAG attestation (ADR-0003: TAG-based placement; applies=true activates). */
  const makeTag = async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signer: any,
    targetUID: string,
    definition: string,
    applies: boolean = true,
  ): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: tagSchemaUID,
      data: {
        recipient: ethers.ZeroAddress,
        expirationTime: 0n,
        revocable: true,
        refUID: targetUID,
        data: encode.encode(["bytes32", "bool"], [definition, applies]),
        value: 0n,
      },
    });
    return getUID(tx);
  };

  /**
   * Attach a PROPERTY(key=value) to a container using the ADR-0035 free-floating model.
   * Three attestations: key anchor under container (if not present) + standalone PROPERTY
   * (value) + TAG binding key-anchor↔property. Reserved keys include `contentType`.
   */
  const makeProperty = async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signer: any,
    containerUID: string,
    key: string,
    value: string,
  ): Promise<string> => {
    let keyAnchorUID: string = await indexer.resolveAnchor(containerUID, key, propertySchemaUID);
    if (keyAnchorUID === ethers.ZeroHash) {
      const tx = await eas.connect(signer).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ethers.ZeroAddress,
          expirationTime: 0n,
          revocable: false,
          refUID: containerUID,
          data: encode.encode(["string", "bytes32"], [key, propertySchemaUID]),
          value: 0n,
        },
      });
      keyAnchorUID = await getUID(tx);
    }

    const propTx = await eas.connect(signer).attest({
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
    const propertyUID = await getUID(propTx);

    await makeTag(signer, propertyUID, keyAnchorUID, true);
    return propertyUID;
  };

  /**
   * Full file creation: file-slot anchor + DATA + contentType + mirror + placement TAG.
   * The "file slot" is an ANCHOR whose `schema` field is DATA_SCHEMA_UID (convention
   * per `specs/02` §Anchor — marks the anchor as a placement target for DATA).
   */
  const makeFile = async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signer: any,
    parentUID: string,
    name: string,
    content: string,
    contentType: string,
    transportUID: string,
    uri: string,
  ): Promise<{ fileUID: string; dataUID: string }> => {
    const fileUID = await makeAnchor(signer, name, parentUID, dataSchemaUID);
    const dataUID = await makeData(signer, content);
    await makeProperty(signer, dataUID, "contentType", contentType);
    await makeMirror(signer, dataUID, transportUID, uri);
    await makeTag(signer, dataUID, fileUID, true);
    return { fileUID, dataUID };
  };

  // Per-subtree idempotency guard. Returns the existing UID (if any) or null.
  const findAnchor = async (
    parentUID: string,
    name: string,
    schema: string = ethers.ZeroHash,
  ): Promise<string | null> => {
    const uid = await indexer.resolveAnchor(parentUID, name, schema);
    return uid === ethers.ZeroHash ? null : uid;
  };

  // ── Build tree ────────────────────────────────────────────────────────────────

  let skipped = 0;
  let docsUID: string;
  let imagesUID: string;
  let sharedUID: string;

  const existingDocs = await findAnchor(rootUID, "docs");
  if (existingDocs) {
    docsUID = existingDocs;
    console.log(`── /docs/ (exists, skipping) ── ${docsUID.slice(0, 14)}…`);
    skipped++;
  } else {
    console.log("── /docs/ ──");
    docsUID = await makeAnchor(deployerSigner, "docs", rootUID);
    await makeFile(
      deployerSigner,
      docsUID,
      "readme.txt",
      "Hello from EFS!",
      "text/plain",
      httpsTransportUID,
      "https://example.com/efs/readme.txt",
    );
    await makeFile(
      deployerSigner,
      docsUID,
      "notes.txt",
      "Some notes",
      "text/plain",
      httpsTransportUID,
      "https://example.com/efs/notes.txt",
    );
  }

  const existingImages = await findAnchor(rootUID, "images");
  if (existingImages) {
    imagesUID = existingImages;
    console.log(`\n── /images/ (exists, skipping) ── ${imagesUID.slice(0, 14)}…`);
    skipped++;
  } else {
    console.log("\n── /images/ ──");
    imagesUID = await makeAnchor(deployerSigner, "images", rootUID);
    await makeFile(
      deployerSigner,
      imagesUID,
      "cat.jpg",
      "cat-jpeg-placeholder",
      "image/jpeg",
      httpsTransportUID,
      "https://placecats.com/300/200",
    );
    await makeFile(
      deployerSigner,
      imagesUID,
      "dog.jpg",
      "dog-jpeg-placeholder",
      "image/jpeg",
      httpsTransportUID,
      "https://placedog.net/300/200",
    );
  }

  const existingShared = await findAnchor(rootUID, "shared");
  if (existingShared) {
    sharedUID = existingShared;
    console.log(`\n── /shared/ (exists, skipping) ── ${sharedUID.slice(0, 14)}…`);
    skipped++;
  } else {
    console.log("\n── /shared/ (editions demo) ──");
    sharedUID = await makeAnchor(deployerSigner, "shared", rootUID);
    // Single file-slot anchor, two editions — deployer and user1 each attest their own
    // DATA+PROPERTY+MIRROR+TAG triple. Router fallback (ADR-0031) picks whichever edition
    // is first in the `?editions=` list.
    const photoUID = await makeAnchor(deployerSigner, "photo.png", sharedUID, dataSchemaUID);

    // Owner edition
    const ownerPhotoData = await makeData(deployerSigner, "owner-photo-png-bytes");
    await makeProperty(deployerSigner, ownerPhotoData, "contentType", "image/png");
    await makeMirror(deployerSigner, ownerPhotoData, ipfsTransportUID, "ipfs://owner-version-of-photo");
    await makeTag(deployerSigner, ownerPhotoData, photoUID, true);

    // User1 edition
    const user1PhotoData = await makeData(user1, "user1-photo-png-bytes");
    await makeProperty(user1, user1PhotoData, "contentType", "image/png");
    await makeMirror(user1, user1PhotoData, ipfsTransportUID, "ipfs://user1-version-of-photo");
    await makeTag(user1, user1PhotoData, photoUID, true);
  }

  // ── Summary ───────────────────────────────────────────────────────────────────

  console.log("\n═══════════════════════════════════════");
  if (skipped === 3) {
    console.log("  Seed already applied — no writes needed.");
  } else if (skipped > 0) {
    console.log(`  Seeding complete (${skipped}/3 subtrees already existed).`);
  } else {
    console.log("  Seeding complete!");
  }
  console.log(`  docs/     ${docsUID.slice(0, 14)}…`);
  console.log(`  images/   ${imagesUID.slice(0, 14)}…`);
  console.log(`  shared/   ${sharedUID.slice(0, 14)}…`);
  console.log("═══════════════════════════════════════\n");
  console.log("Tip: open the explorer at http://localhost:3000/explorer");
  console.log("     to browse the seeded data.\n");
}
