/**
 * EFS Seed — implementation module.
 *
 * Creates a small realistic file tree for manual UI testing:
 *
 *   /docs/
 *     readme.txt   (owner lens)
 *     notes.txt    (owner lens)
 *   /images/
 *     cat.jpg      (owner lens, https mirror)
 *     dog.jpg      (owner lens, https mirror)
 *   /shared/
 *     photo.png    (owner lens + user1 lens — lenses demo)
 *
 * This file exports `seedDemoTree` as a pure function — no auto-invocation at
 * module load — so it can be imported safely from both:
 *   - `scripts/seed.ts` (the `yarn hardhat:seed` CLI wrapper)
 *   - `deploy/10_seed_demo_tree.ts` (the hardhat-deploy step)
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
 * fully-seeded ones are skipped. For the lenses demo, the owner and user1
 * placements on `shared/photo.png` are guarded independently, so either
 * lens can be backfilled without touching the other.
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
  // READMEs use the on-chain transport so the Overview pane can actually fetch
  // and render their bytes back through the router's web3:// SSTORE2 branch.
  const onchainTransportUID = await indexer.resolvePath(transportsUID, "onchain");

  console.log(`Indexer:  ${indexer.target}`);
  console.log(`Root:     ${rootUID}`);
  console.log(`/transports/https:  ${httpsTransportUID.slice(0, 14)}…`);
  console.log(`/transports/onchain: ${onchainTransportUID.slice(0, 14)}…\n`);

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
   * semantics). Per-entry `weight` is generic, opaque metadata — the kernel
   * stores it but does not interpret it. A TAG is active iff it exists and
   * is not EAS-revoked; weight does NOT determine activity (ADR-0041 §4).
   * Folder-visibility TAGs pass weight=1 by convention.
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

  /**
   * Deploy the bytes of `content` as an on-chain SSTORE2-style body and wrap it
   * in a `MockChunkedFile` so the EFSRouter's `web3://` branch can read it back
   * via `chunkCount()` / `chunkAddress()` + `extcodecopy`.
   *
   * The router skips the first runtime byte (the SSTORE2 STOP-opcode convention,
   * `EFSRouter.sol` §"Normal SSTORE2 skips first byte 0x00"), so the data
   * contract's runtime must be `0x00 || content`. We deploy it with the minimal
   * SSTORE2 init code: `PUSH(len) DUP1 PUSH(offset) PUSH0 CODECOPY PUSH0 RETURN`
   * followed by the runtime payload. Returns the `MockChunkedFile` address as a
   * `web3://0x…` URI string ready to hand to `makeMirror`.
   *
   * This is the one place the seed puts *real, retrievable* bytes on-chain (the
   * other demo files use HTTPS mirrors to placeholder hosts). READMEs must
   * actually render in the Overview pane, so their bytes have to come back
   * through the router — an unreachable HTTPS mirror would render nothing.
   */
  const deployOnchainMirrorURI = async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signer: any,
    content: string,
  ): Promise<string> => {
    // Runtime = 0x00 (STOP) || content bytes — matches the router's SSTORE2 read.
    const runtime = ethers.concat(["0x00", ethers.toUtf8Bytes(content)]);
    const runtimeLen = ethers.dataLength(runtime);
    // SSTORE2 deploy stub (EVM): copy `runtimeLen` bytes from code offset 0x0c
    // to memory and RETURN them. 0x0c = length of this 12-byte init prefix
    // (PUSH2+imm = 3 bytes, then the 9-byte DUP1…RETURN sequence below).
    //   61 LLLL  PUSH2 runtimeLen   (3 bytes)
    //   80       DUP1
    //   60 0c    PUSH1 0x0c         (runtime starts right after this 12-byte prefix)
    //   60 00    PUSH1 0x00
    //   39       CODECOPY
    //   60 00    PUSH1 0x00
    //   f3       RETURN
    const initCode = ethers.concat([
      "0x61",
      ethers.zeroPadValue(ethers.toBeHex(runtimeLen), 2),
      "0x80600c6000396000f3",
      runtime,
    ]);
    // Deploy the raw-bytecode data contract via a bare tx with no `to`.
    const dataTx = await signer.sendTransaction({ data: initCode });
    const dataReceipt = await dataTx.wait();
    const dataContract = dataReceipt.contractAddress as string;

    // Wrap the single data chunk in a MockChunkedFile (chunkCount/chunkAddress).
    const MockChunkedFile = await ethers.getContractFactory("MockChunkedFile", signer);
    const chunked = await MockChunkedFile.deploy([dataContract]);
    await chunked.waitForDeployment();
    const chunkedAddr = await chunked.getAddress();
    console.log(`  Onchain   ${chunkedAddr}  (${runtimeLen - 1} bytes)`);
    return `web3://${chunkedAddr}`;
  };

  /**
   * Idempotent on-chain README at `(parentUID, name)` with real retrievable
   * bytes. Mirrors `makeFileIfMissing` (anchor + DATA + contentType PROPERTY +
   * MIRROR + PIN + ancestor visibility) but uses an on-chain `web3://` mirror so
   * the Overview pane can fetch and render the markdown. `parentUID` may be a
   * folder anchor, a file anchor, or an address container (`bytes32(uint160)`).
   *
   * For address containers the file-slot anchor can't use `refUID=parent` (the
   * address bytes32 isn't a real attestation UID EAS would accept), so callers
   * pass `recipient` to take the ANCHOR recipient-fallback path (ADR-0033,
   * EFSIndexer §"Resolve Parent … else recipient cast to bytes32"); the anchor
   * is then attested with `recipient=addr, refUID=0x0` and parents itself.
   */
  const makeOnchainReadmeIfMissing = async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signer: any,
    parentUID: string,
    name: string,
    content: string,
    recipient: string = ethers.ZeroAddress,
    // When provided, the DATA is system-tagged BEFORE the placement PIN below, so
    // the README is hidden the instant it becomes reachable — an interrupted seed
    // can't leave a visible, untagged system file (Codex P2; mirrors the UI's
    // beforePlacement ordering). Callers still re-apply tagSystemIfMissing after,
    // which idempotently repairs an already-placed-but-untagged README.
    systemDefUID?: string,
  ): Promise<{ fileUID: string; dataUID: string; created: boolean }> => {
    const attester = await signer.getAddress();
    let fileUID = await findAnchor(parentUID, name, dataSchemaUID);
    if (fileUID && (await hasActivePlacement(fileUID, attester))) {
      // README already placed — look up its existing DATA (the active PIN
      // target at this file slot) so the caller can idempotently re-apply the
      // `system` TAG, which targets the DATA UID (like `nsfw`), not the anchor.
      const existingData = (await edgeResolver.getActivePinTarget(fileUID, attester, dataSchemaUID)) as string;
      console.log(`  README    "${name}" (exists, skipping) ${fileUID.slice(0, 10)}…`);
      return { fileUID, dataUID: existingData, created: false };
    }
    if (!fileUID) {
      if (recipient !== ethers.ZeroAddress) {
        // Address-container slot: recipient-fallback parenting (refUID=0x0).
        const tx = await eas.connect(signer).attest({
          schema: anchorSchemaUID,
          data: {
            recipient,
            expirationTime: 0n,
            revocable: false,
            refUID: ethers.ZeroHash,
            data: encode.encode(["string", "bytes32"], [name, dataSchemaUID]),
            value: 0n,
          },
        });
        fileUID = await getUID(tx);
        console.log(`  Anchor    "${name}"  ${fileUID.slice(0, 10)}…  (recipient=${recipient.slice(0, 10)}…)`);
      } else {
        fileUID = await makeAnchor(signer, name, parentUID, dataSchemaUID);
      }
    }
    const dataUID = await makeData(signer, content);
    await makeProperty(signer, dataUID, "contentType", "text/markdown");
    const onchainURI = await deployOnchainMirrorURI(signer, content);
    await makeMirror(signer, dataUID, onchainTransportUID, onchainURI);
    // Tag the DATA system BEFORE placement so the README is never reachable while
    // untagged (Codex P2). If the tag fails, makePin never runs and nothing leaks.
    if (systemDefUID) await tagSystemIfMissing(signer, dataUID, systemDefUID);
    await makePin(signer, dataUID, fileUID);
    // Ancestor visibility TAGs apply only to anchor-parented placements: each
    // walked parent becomes a TAG `refUID`, which must be a real attestation.
    // For address-container slots (recipient-fallback) the immediate parent is
    // `bytes32(uint160(addr))` — not an attestation — so EAS reverts NotFound on
    // the first hop. Address-container listings don't rely on these folder
    // visibility TAGs anyway, so skip the walk for that path.
    if (recipient === ethers.ZeroAddress) {
      await walkAncestorVisibility(signer, fileUID);
    }
    return { fileUID, dataUID, created: true };
  };

  /**
   * Idempotent `system` TAG marking a README's **DATA** as an Overview source.
   * The TAG is `definition = /tags/system anchor UID`, `refUID = README DATA
   * UID`, `weight = 1` — the exact shape the descriptive labels (`nsfw`, …) use:
   * the target is a DATA attestation, so the kernel files the entry under the
   * **DATA EAS schema** (`dataSchemaUID`) in
   * `_activeByAAS[systemDef][attester][dataSchemaUID]`.
   *
   * Tagging the DATA (not the anchor) is what lets the client's normal
   * `resolveTagSet`/`matchesUID` descriptive-label path hide system files:
   * `matchesUID` resolves a file item's DATA UID and checks it against the
   * excluded-tag set, so `system` must live on the DATA bucket alongside `nsfw`.
   *
   * Idempotency: `hasActiveTagFromAny(target, definition, [attester])` keys on
   * `_activeEdge[edgeHash(attester, target, definition, TAG_SCHEMA)]` — schema-
   * bucket-independent — so re-runs are a clean no-op.
   */
  const tagSystemIfMissing = async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signer: any,
    dataUID: string,
    systemDefUID: string,
  ): Promise<void> => {
    const attester = await signer.getAddress();
    const already = await edgeResolver.hasActiveTagFromAny(dataUID, systemDefUID, [attester]);
    if (already) {
      console.log(`  System    tag exists, skipping  ${dataUID.slice(0, 10)}…`);
      return;
    }
    console.log(`  System    tag → ${dataUID.slice(0, 10)}…  (def=${systemDefUID.slice(0, 10)}…)`);
    await makeTag(signer, dataUID, systemDefUID, 1n);
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
   * it in lens-scoped directory listings. Walk stops early when an already-
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
      // Folder visibility is TAG-only (ADR-0038, ADR-0041): check whether this attester
      // already has an active TAG on (parent, dataSchemaUID). A PIN would never satisfy
      // folder visibility — use hasActiveTagFromAny, not hasActiveEdgeFromAny.
      const alreadyTagged = await edgeResolver.hasActiveTagFromAny(parent, dataSchemaUID, [attester]);
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

  console.log("\n── /shared/ (lenses demo) ──");
  const shared = await getOrCreateFolder(deployerSigner, rootUID, "shared");
  const sharedUID = shared.uid;
  // One file-slot anchor, two lenses. The file-slot is created by whoever
  // runs first (idempotent via findAnchor); each lens is then guarded by
  // its own `hasActivePlacement` check so either can be backfilled
  // independently after a partial failure.
  let photoUID = await findAnchor(sharedUID, "photo.png", dataSchemaUID);
  if (!photoUID) {
    photoUID = await makeAnchor(deployerSigner, "photo.png", sharedUID, dataSchemaUID);
  }

  const deployerAddr = await deployerSigner.getAddress();
  if (await hasActivePlacement(photoUID, deployerAddr)) {
    console.log(`  Lens      owner (exists, skipping)`);
  } else {
    const ownerPhotoData = await makeData(deployerSigner, "owner-photo-png-bytes");
    await makeProperty(deployerSigner, ownerPhotoData, "contentType", "image/png");
    // Real HTTPS URLs so the lenses demo loads in the browser.
    // Two different picsum seeds give visually distinct images for owner vs user1.
    await makeMirror(deployerSigner, ownerPhotoData, httpsTransportUID, "https://picsum.photos/seed/efs-owner/400/300");
    await makePin(deployerSigner, ownerPhotoData, photoUID);
  }
  await walkAncestorVisibility(deployerSigner, photoUID);

  const user1Addr = await user1.getAddress();
  if (await hasActivePlacement(photoUID, user1Addr)) {
    console.log(`  Lens      user1 (exists, skipping)`);
  } else {
    const user1PhotoData = await makeData(user1, "user1-photo-png-bytes");
    await makeProperty(user1, user1PhotoData, "contentType", "image/png");
    await makeMirror(user1, user1PhotoData, httpsTransportUID, "https://picsum.photos/seed/efs-user1/400/300");
    await makePin(user1, user1PhotoData, photoUID);
  }
  await walkAncestorVisibility(user1, photoUID);

  // ── /tags/system + Overview READMEs (Task 15) ───────────────────────────────────
  //
  // The explorer's Overview pane renders a `system`-tagged README child of the
  // item being viewed. Seed the `/tags/system` definition anchor plus three
  // demo READMEs — on a folder, on a file anchor, and under the demo lens's
  // address container — so "any item type" is exercised. All idempotent and
  // guarded exactly like the rest of the seed.

  console.log("\n── /tags/system + Overview READMEs ──");
  // 1. Generic folder anchors /tags and /tags/system (schema 0). The client's
  //    tag filter walks resolvePath(root,"tags")→(…,"system") to resolve the
  //    `system` definition, then unions its DATA-target set (like `nsfw`).
  const tags = await getOrCreateFolder(deployerSigner, rootUID, "tags");
  const tagsUID = tags.uid;
  const systemFolder = await getOrCreateFolder(deployerSigner, tagsUID, "system");
  const systemDefUID = systemFolder.uid;

  const FOLDER_README = [
    "# Docs",
    "",
    "Welcome to the **docs** folder.",
    "",
    "## Contents",
    "",
    "| File | About |",
    "|------|-------|",
    "| readme.txt | legacy notes |",
    "",
    "> Rendered safely in the Overview pane.",
    "",
  ].join("\n");

  // 2. Folder case (must-have): /docs/README.md + system TAG.
  const docsReadme = await makeOnchainReadmeIfMissing(
    deployerSigner,
    docsUID,
    "README.md",
    FOLDER_README,
    ethers.ZeroAddress,
    systemDefUID,
  );
  await tagSystemIfMissing(deployerSigner, docsReadme.dataUID, systemDefUID);

  // 3. File-anchor case: a README hosted UNDER the /docs/readme.txt file anchor.
  //    A file leaf is itself an anchor that can host children, so the Overview
  //    of a *file* resolves system-tagged children the same way a folder does.
  const readmeTxtUID = await findAnchor(docsUID, "readme.txt", dataSchemaUID);
  if (readmeTxtUID) {
    const FILE_README = [
      "# readme.txt",
      "",
      "Overview for the **readme.txt** file item.",
      "",
      "This README is hosted *under a file anchor* to exercise the non-folder",
      "Overview path — a file leaf can host children just like a folder.",
      "",
    ].join("\n");
    const fileReadme = await makeOnchainReadmeIfMissing(
      deployerSigner,
      readmeTxtUID,
      "README.md",
      FILE_README,
      ethers.ZeroAddress,
      systemDefUID,
    );
    await tagSystemIfMissing(deployerSigner, fileReadme.dataUID, systemDefUID);
  } else {
    console.log("  ⏭️  /docs/readme.txt anchor missing — skipping file-anchor README.");
  }

  // 4. Address-container case: a README under the demo lens's (deployer's)
  //    address root. Address containers have no anchor UID to use as refUID, so
  //    the file-slot anchor takes the recipient-fallback path (recipient=addr,
  //    refUID=0x0) — same pattern as 07_persona_names.ts. The Overview of an
  //    address then resolves this system-tagged child.
  const ADDRESS_README = [
    "# Demo lens",
    "",
    "Overview for this **address** container.",
    "",
    "Files placed by this address (the demo deployer lens) show up across the",
    "explorer; this page is its address-level Overview.",
    "",
  ].join("\n");
  const addrReadme = await makeOnchainReadmeIfMissing(
    deployerSigner,
    ethers.zeroPadValue(deployerAddr, 32),
    "README.md",
    ADDRESS_README,
    deployerAddr,
    systemDefUID,
  );
  await tagSystemIfMissing(deployerSigner, addrReadme.dataUID, systemDefUID);

  // ── Summary ───────────────────────────────────────────────────────────────────

  console.log("\n═══════════════════════════════════════");
  console.log("  Seeding complete.");
  console.log(`  docs/     ${docsUID.slice(0, 14)}…`);
  console.log(`  images/   ${imagesUID.slice(0, 14)}…`);
  console.log(`  shared/   ${sharedUID.slice(0, 14)}…`);
  console.log(`  tags/system  ${systemDefUID.slice(0, 14)}…`);
  console.log("═══════════════════════════════════════\n");
  console.log("Tip: open the explorer at http://localhost:3000/explorer");
  console.log("     to browse the seeded data.\n");
}
