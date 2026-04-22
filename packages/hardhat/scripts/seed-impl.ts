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
 * Each file uses the current model (ADR-0001/0002/0005/0035/0040):
 *   - Anchor (filename with schema=DATA_SCHEMA_UID → "file slot")
 *   - DATA (standalone, refUID=0x0, encodes contentHash + size)
 *   - PROPERTY contentType via the unified bind dance — PIN binds the value:
 *     key-anchor under DATA + free-floating PROPERTY(value) + PIN binding
 *     (cardinality 1 — contentType is exclusive per attester).
 *   - MIRROR (refUID=DATA, refs a /transports/* anchor, carries URI)
 *   - PIN (refUID=DATA, definition=fileAnchorUID → placement)
 *     Per ADR-0041 file placement is Shape A (one DATA per attester per slot),
 *     so it uses PIN; rebinding to a new DATA supersedes the old in O(1). PIN
 *     carries no per-entry metadata (cardinality 1 has no order to encode).
 *
 * Idempotency: guards are per-file, not per-subtree. Folders are created via
 * `getOrCreateFolder` (ADR-0008 append-only anchors — never rewritten), and
 * each file goes through `makeFileIfMissing`, which checks both that the
 * file-slot anchor exists AND that the attester has an active PIN placement on
 * it (via `EdgeResolver.getActivePinTarget`). Re-running after a successful
 * seed is a no-op (one read per anchor, one read per file for the placement
 * check). Re-running after a **partial** failure — say `/docs/` got created
 * but `readme.txt`'s PIN never landed — fills in only the missing files; the
 * fully-seeded ones are skipped. For the editions demo, the owner and user1
 * placements on `shared/photo.png` are guarded independently, so either
 * edition can be backfilled without touching the other.
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
  // EdgeResolver drives per-file idempotency: we look up whether the current
  // attester has an active PIN placement at a file-slot anchor before redoing
  // the DATA/PROPERTY/MIRROR/PIN work.
  const edgeResolverAddr = await indexer.edgeResolver();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const edgeResolver = (await ethers.getContractAt("EdgeResolver", edgeResolverAddr)) as any;

  const anchorSchemaUID = await indexer.ANCHOR_SCHEMA_UID();
  const dataSchemaUID = await indexer.DATA_SCHEMA_UID();
  const mirrorSchemaUID = await indexer.MIRROR_SCHEMA_UID();
  const pinSchemaUID = await indexer.PIN_SCHEMA_UID();
  const tagSchemaUID = await indexer.TAG_SCHEMA_UID();
  const propertySchemaUID = await indexer.PROPERTY_SCHEMA_UID();
  const rootUID = await indexer.rootAnchorUID();
  const encode = ethers.AbiCoder.defaultAbiCoder();

  // Second fail-soft gate (ADR-0028): Indexer is deployed but rootUID is zero
  // because earlier deploy-step attestations silently reverted (no EAS on this
  // chain — CI vanilla hardhat). Seeding anchors would just hit the same
  // silent-revert wall in `makeAnchor`; skip cleanly so the deploy exits 0.
  if (rootUID === ethers.ZeroHash) {
    console.log("⏭️  Seed skipped — root anchor is zero (earlier deploy steps had no EAS to attest against).");
    console.log("   This is expected when deploy targeted a chain without EAS (e.g. CI without fork).");
    return;
  }

  // Resolve /transports/ anchors for MIRRORs. Registered by deploy script
  // 05_mirrors.ts (names: onchain, ipfs, arweave, magnet, https).
  const transportsUID = await indexer.resolvePath(rootUID, "transports");
  const httpsTransportUID = await indexer.resolvePath(transportsUID, "https");

  console.log(`Indexer:  ${indexer.target}`);
  console.log(`Root:     ${rootUID}`);
  console.log(`/transports/https:  ${httpsTransportUID.slice(0, 14)}…\n`);

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

  /**
   * Create a PIN attestation (ADR-0041: cardinality-1 edge; Shape A — file
   * placement, PROPERTY value bind). Re-attesting at the same (attester,
   * definition, targetSchema) slot supersedes the prior PIN in O(1); revoke
   * clears. PIN carries no per-entry metadata.
   */
  const makePin = async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signer: any,
    targetUID: string,
    definition: string,
  ): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: pinSchemaUID,
      data: {
        recipient: ethers.ZeroAddress,
        expirationTime: 0n,
        revocable: true,
        refUID: targetUID,
        data: encode.encode(["bytes32"], [definition]),
        value: 0n,
      },
    });
    return getUID(tx);
  };

  /**
   * Create a TAG attestation (ADR-0041: cardinality-N edge; Shape B — list
   * semantics). Per-entry `weight` is generic metadata; folder-visibility TAGs
   * pass weight=1 (any value > 0 simply marks the edge as present — the kernel
   * does not maintain a sorted index by weight).
   */
  const makeTag = async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signer: any,
    targetUID: string,
    definition: string,
    weight: bigint = 1n,
  ): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: tagSchemaUID,
      data: {
        recipient: ethers.ZeroAddress,
        expirationTime: 0n,
        revocable: true,
        refUID: targetUID,
        data: encode.encode(["bytes32", "int256"], [definition, weight]),
        value: 0n,
      },
    });
    return getUID(tx);
  };

  /**
   * Attach a PROPERTY(key=value) to a container using the ADR-0035 free-floating
   * model with the ADR-0041 PIN bind. Three attestations: key anchor under
   * container (if not present) + standalone PROPERTY (value) + PIN binding
   * key-anchor↔property. Reserved keys include `contentType` (exclusive per
   * attester — must be PIN, not TAG).
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

    await makePin(signer, propertyUID, keyAnchorUID);
    return propertyUID;
  };

  // Lookup: returns the anchor UID for `(parent, name, schema)` or null.
  const findAnchor = async (
    parentUID: string,
    name: string,
    schema: string = ethers.ZeroHash,
  ): Promise<string | null> => {
    const uid = await indexer.resolveAnchor(parentUID, name, schema);
    return uid === ethers.ZeroHash ? null : uid;
  };

  /**
   * Return the folder anchor UID at `parent/name`, creating it if missing.
   * Folders use `schema=0` per the convention in `specs/02` §Anchor.
   * `created=true` means we wrote a new ANCHOR attestation this call.
   */
  const getOrCreateFolder = async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signer: any,
    parentUID: string,
    name: string,
  ): Promise<{ uid: string; created: boolean }> => {
    const existing = await findAnchor(parentUID, name);
    if (existing) return { uid: existing, created: false };
    const uid = await makeAnchor(signer, name, parentUID);
    return { uid, created: true };
  };

  /**
   * "Has this attester placed any DATA at this file-slot?" — the idempotency
   * primitive. Uses `EdgeResolver.getActivePinTarget`: returns non-zero iff the
   * attester currently has an active PIN where `definition == fileSlotAnchorUID`
   * and the target is a DATA attestation. O(1), single SLOAD.
   */
  const hasActivePlacement = async (fileSlotUID: string, attester: string): Promise<boolean> => {
    const target: string = await edgeResolver.getActivePinTarget(fileSlotUID, attester, dataSchemaUID);
    return target !== ethers.ZeroHash;
  };

  /**
   * Ancestor-walk visibility TAGs (ADR-0038, ADR-0041).
   *
   * After placing a file at a file-slot anchor, every generic folder from the
   * file-slot's parent up to root (exclusive) must have an active TAG
   * (definition=dataSchemaUID, refUID=folder) so EFSFileView phase-0 includes
   * it in edition-scoped directory listings. Walk stops early when an already-
   * tagged ancestor is found — steady-state cost is zero extra writes.
   *
   * Folder visibility is Shape B (list semantics: multiple attesters can tag
   * the same folder under the same definition) so the edge is a TAG, not a
   * PIN. Weight is 1 (arbitrary positive — this is a presence marker).
   */
  const walkAncestorVisibility = async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signer: any,
    fileSlotUID: string,
  ): Promise<void> => {
    const attester = await signer.getAddress();
    let current = fileSlotUID;
    for (let depth = 0; depth < 32; depth++) {
      const parent: string = await indexer.getParent(current);
      if (!parent || parent === ethers.ZeroHash || parent === rootUID) break;
      // Schema-blind — either PIN or TAG from any prior attester would satisfy folder
      // visibility for this edition. In practice folder visibility always lands as TAG,
      // but the kernel treats both schemas uniformly for Shape-B-style reads.
      const alreadyTagged = await edgeResolver.hasActiveEdgeFromAny(parent, dataSchemaUID, [attester]);
      if (alreadyTagged) break;
      console.log(`  Visibility ${parent.slice(0, 10)}… (${attester.slice(0, 10)}…)`);
      await makeTag(signer, parent, dataSchemaUID, 1n);
      current = parent;
    }
  };

  /**
   * Per-file idempotent version of `makeFile`. Skips re-attesting when the
   * file-slot anchor exists AND this attester already has a live placement
   * on it; otherwise fills in whatever is missing (file-slot anchor first,
   * then DATA+PROPERTY+MIRROR+PIN). Safe to re-run after any partial failure.
   */
  const makeFileIfMissing = async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signer: any,
    parentUID: string,
    name: string,
    content: string,
    contentType: string,
    transportUID: string,
    uri: string,
  ): Promise<{ fileUID: string; created: boolean }> => {
    const attester = await signer.getAddress();
    let fileUID = await findAnchor(parentUID, name, dataSchemaUID);
    if (fileUID && (await hasActivePlacement(fileUID, attester))) {
      console.log(`  File      "${name}" (exists, skipping) ${fileUID.slice(0, 10)}…`);
      await walkAncestorVisibility(signer, fileUID);
      return { fileUID, created: false };
    }
    if (!fileUID) {
      fileUID = await makeAnchor(signer, name, parentUID, dataSchemaUID);
    }
    const dataUID = await makeData(signer, content);
    await makeProperty(signer, dataUID, "contentType", contentType);
    await makeMirror(signer, dataUID, transportUID, uri);
    // File placement is Shape A (one DATA per attester per file-slot): PIN.
    await makePin(signer, dataUID, fileUID);
    // Ancestor-walk visibility TAGs are Shape B (list): makeTag, not makePin.
    await walkAncestorVisibility(signer, fileUID);
    return { fileUID, created: true };
  };

  // ── Build tree ────────────────────────────────────────────────────────────────
  //
  // Idempotency is per-file, not per-subtree (see module docstring): each
  // `getOrCreateFolder` / `makeFileIfMissing` call independently decides whether
  // to write, so a partial seed (folder created, file's PIN never landed) is
  // fully backfilled on retry.

  console.log("── /docs/ ──");
  const docs = await getOrCreateFolder(deployerSigner, rootUID, "docs");
  const docsUID = docs.uid;
  await makeFileIfMissing(
    deployerSigner,
    docsUID,
    "readme.txt",
    "Hello from EFS!",
    "text/plain",
    httpsTransportUID,
    "https://example.com/efs/readme.txt",
  );
  await makeFileIfMissing(
    deployerSigner,
    docsUID,
    "notes.txt",
    "Some notes",
    "text/plain",
    httpsTransportUID,
    "https://example.com/efs/notes.txt",
  );

  console.log("\n── /images/ ──");
  const images = await getOrCreateFolder(deployerSigner, rootUID, "images");
  const imagesUID = images.uid;
  await makeFileIfMissing(
    deployerSigner,
    imagesUID,
    "cat.jpg",
    "cat-jpeg-placeholder",
    "image/jpeg",
    httpsTransportUID,
    "https://placecats.com/300/200",
  );
  await makeFileIfMissing(
    deployerSigner,
    imagesUID,
    "dog.jpg",
    "dog-jpeg-placeholder",
    "image/jpeg",
    httpsTransportUID,
    "https://placedog.net/300/200",
  );

  console.log("\n── /shared/ (editions demo) ──");
  const shared = await getOrCreateFolder(deployerSigner, rootUID, "shared");
  const sharedUID = shared.uid;
  // One file-slot anchor, two editions. The file-slot is created by whoever
  // runs first (idempotent via findAnchor); each edition is then guarded by
  // its own `hasActivePlacement` check so either can be backfilled
  // independently after a partial failure.
  let photoUID = await findAnchor(sharedUID, "photo.png", dataSchemaUID);
  if (!photoUID) {
    photoUID = await makeAnchor(deployerSigner, "photo.png", sharedUID, dataSchemaUID);
  }

  const deployerAddr = await deployerSigner.getAddress();
  if (await hasActivePlacement(photoUID, deployerAddr)) {
    console.log(`  Edition   owner (exists, skipping)`);
  } else {
    const ownerPhotoData = await makeData(deployerSigner, "owner-photo-png-bytes");
    await makeProperty(deployerSigner, ownerPhotoData, "contentType", "image/png");
    // Real HTTPS URLs so the editions demo loads in the browser.
    // Two different picsum seeds give visually distinct images for owner vs user1.
    await makeMirror(deployerSigner, ownerPhotoData, httpsTransportUID, "https://picsum.photos/seed/efs-owner/400/300");
    await makePin(deployerSigner, ownerPhotoData, photoUID);
  }
  await walkAncestorVisibility(deployerSigner, photoUID);

  const user1Addr = await user1.getAddress();
  if (await hasActivePlacement(photoUID, user1Addr)) {
    console.log(`  Edition   user1 (exists, skipping)`);
  } else {
    const user1PhotoData = await makeData(user1, "user1-photo-png-bytes");
    await makeProperty(user1, user1PhotoData, "contentType", "image/png");
    await makeMirror(user1, user1PhotoData, httpsTransportUID, "https://picsum.photos/seed/efs-user1/400/300");
    await makePin(user1, user1PhotoData, photoUID);
  }
  await walkAncestorVisibility(user1, photoUID);

  // ── Summary ───────────────────────────────────────────────────────────────────

  console.log("\n═══════════════════════════════════════");
  console.log("  Seeding complete.");
  console.log(`  docs/     ${docsUID.slice(0, 14)}…`);
  console.log(`  images/   ${imagesUID.slice(0, 14)}…`);
  console.log(`  shared/   ${sharedUID.slice(0, 14)}…`);
  console.log("═══════════════════════════════════════\n");
  console.log("Tip: open the explorer at http://localhost:3000/explorer");
  console.log("     to browse the seeded data.\n");
}
