import { ethers } from "hardhat";
import { EFSIndexer, EFSSortOverlay, NameSort, TimestampSort, EdgeResolver } from "../typechain-types";

/**
 * EFS Sort Overlay + Lenses + PINs/TAGs Simulation
 *
 * Exercises everything the UI will need against a deployed EFS stack using the
 * three-layer data model: paths (Anchors) → data (DATA) → retrieval (MIRRORs).
 *
 * Two users (Alice, Bob) build a shared /music/ directory, sort it independently,
 * place DATAs via PINs (cardinality 1), add MIRRORs, label items with TAGs
 * (cardinality N), and exercise every read path the UI will call.
 *
 * Edge model (ADR-0041):
 *   - File placement → PIN under (definition=fileAnchor, attester, schema=DATA).
 *     A new PIN supersedes the prior one in O(1). Removal is via eas.revoke().
 *   - PROPERTY value binding → PIN under (definition=keyAnchor, attester, schema=PROPERTY).
 *   - Labels (favorite/classic) → TAG with optional int256 weight; multiple coexist per slot.
 *
 * Run: npx hardhat run scripts/simulate-sort-overlay.ts --network localhost
 *
 * Re-runnable: uses a session timestamp suffix to avoid DuplicateFileName collisions.
 */

const PASS = "✅ PASS";
const FAIL = "❌ FAIL";
let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail: string = "") {
  if (condition) {
    console.log(`  ${PASS} ${label}${detail ? ` — ${detail}` : ""}`);
    passed++;
  } else {
    console.log(`  ${FAIL} ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

async function main() {
  console.log("════════════════════════════════════════════════════════════");
  console.log("  EFS Full Integration Simulation");
  console.log("  Sorts · DATA · MIRRORs · PINs · TAGs · Lenses");
  console.log("════════════════════════════════════════════════════════════\n");

  const [deployer, alice, bob] = await ethers.getSigners();

  const aliceAddr = await alice.getAddress();
  const bobAddr = await bob.getAddress();

  // ── Connect to deployed contracts ────────────────────────────────────────────
  const indexer = (await ethers.getContract("Indexer", deployer)) as unknown as EFSIndexer;
  const overlay = (await ethers.getContract("EFSSortOverlay", deployer)) as unknown as EFSSortOverlay;

  const easAddress = await indexer.getEAS();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const eas = (await ethers.getContractAt(
    "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol:IEAS",
    easAddress,
  )) as any;

  // All schema UIDs and partner contract addresses are available on a single entry point: EFSIndexer
  const anchorSchemaUID = await indexer.ANCHOR_SCHEMA_UID();
  const dataSchemaUID = await indexer.DATA_SCHEMA_UID();
  const propertySchemaUID = await indexer.PROPERTY_SCHEMA_UID();
  const mirrorSchemaUID = await indexer.MIRROR_SCHEMA_UID();
  const sortInfoSchemaUID = await indexer.SORT_INFO_SCHEMA_UID();
  const pinSchemaUID = await indexer.PIN_SCHEMA_UID();
  const tagSchemaUID = await indexer.TAG_SCHEMA_UID();
  const edgeResolverAddr = await indexer.edgeResolver();
  const edgeResolver = (await ethers.getContractAt("EdgeResolver", edgeResolverAddr)) as unknown as EdgeResolver;
  const rootUID = await indexer.rootAnchorUID();

  // Resolve /transports/ for MIRRORs
  const transportsUID = await indexer.resolvePath(rootUID, "transports");
  const ipfsTransportUID = await indexer.resolvePath(transportsUID, "ipfs");

  console.log(`Indexer:      ${indexer.target}`);
  console.log(`Overlay:      ${overlay.target}`);
  console.log(`EdgeResolver: ${edgeResolverAddr}`);
  console.log(`EAS:          ${easAddress}`);
  console.log(`Root:         ${rootUID}\n`);

  // ── Deploy sort implementations inline ───────────────────────────────────────
  const NameSortFactory = await ethers.getContractFactory("NameSort");
  const nameSortContract = (await NameSortFactory.deploy(easAddress)) as unknown as NameSort;
  await (nameSortContract as any).waitForDeployment();

  const TimestampSortFactory = await ethers.getContractFactory("TimestampSort");
  const timestampSort = (await TimestampSortFactory.deploy(easAddress)) as unknown as TimestampSort;
  await (timestampSort as any).waitForDeployment();

  console.log(`NameSort:      ${(nameSortContract as any).target}`);
  console.log(`TimestampSort: ${(timestampSort as any).target}\n`);

  // ── Helpers ───────────────────────────────────────────────────────────────────

  const S = Date.now().toString(36);
  const encode = ethers.AbiCoder.defaultAbiCoder();

  /**
   * Index of currently active PINs by (target, definition, attester) — needed
   * because revoking a PIN requires its UID and we don't want a per-revoke scan.
   */
  const activePinIndex = new Map<string, string>();
  const pinKey = (target: string, definition: string, attester: string) =>
    `${target}|${definition}|${attester.toLowerCase()}`;

  const getUID = async (tx: any): Promise<string> => {
    const receipt = await tx.wait();
    for (const log of receipt.logs) {
      try {
        const parsed = eas.interface.parseLog(log);
        if (parsed?.name === "Attested") return parsed.args.uid;
      } catch {}
    }
    throw new Error("Attested event not found");
  };

  /** Create an Anchor attestation as `signer` under `parentUID` */
  const anchor = async (signer: any, name: string, parentUID: string, schema = ethers.ZeroHash): Promise<string> => {
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
    return getUID(tx);
  };

  /** Create a standalone DATA attestation (contentHash + size, non-revocable, standalone) */
  const createData = async (signer: any, content: string): Promise<{ uid: string; contentHash: string }> => {
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
    return { uid: await getUID(tx), contentHash };
  };

  /**
   * Place a PIN edge: target ← (definition, attester, schema) singleton (cardinality 1).
   * Used for file placement (target=DATA, definition=fileAnchor) and PROPERTY value
   * binding (target=PROPERTY, definition=keyAnchor). A new PIN at the same slot
   * supersedes the prior one in O(1) via _activeBySlot.
   */
  const pin = async (signer: any, targetUID: string, definitionUID: string): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: pinSchemaUID,
      data: {
        recipient: ethers.ZeroAddress,
        expirationTime: 0n,
        revocable: true,
        refUID: targetUID,
        data: encode.encode(["bytes32"], [definitionUID]),
        value: 0n,
      },
    });
    const uid = await getUID(tx);
    const attesterAddr = await signer.getAddress();
    activePinIndex.set(pinKey(targetUID, definitionUID, attesterAddr), uid);
    return uid;
  };

  /** Revoke the active PIN at (target, definition, attester). */
  const unpin = async (signer: any, targetUID: string, definitionUID: string): Promise<void> => {
    const attesterAddr = await signer.getAddress();
    const key = pinKey(targetUID, definitionUID, attesterAddr);
    const uid = activePinIndex.get(key);
    if (uid === undefined) throw new Error(`no active PIN tracked for ${key}`);
    await eas.connect(signer).revoke({ schema: pinSchemaUID, data: { uid, value: 0n } });
    activePinIndex.delete(key);
  };

  /**
   * Attach a PROPERTY to a container using the unified free-floating model
   * (ADR-0035 + ADR-0041): key anchor under the container, free-floating
   * PROPERTY(value), and a PIN binding them. Returns the PROPERTY UID.
   */
  const property = async (signer: any, containerUID: string, key: string, value: string): Promise<string> => {
    let keyAnchorUID: string = await indexer.resolveAnchor(containerUID, key, propertySchemaUID);
    if (keyAnchorUID === ethers.ZeroHash) {
      const keyTx = await eas.connect(signer).attest({
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
      keyAnchorUID = await getUID(keyTx);
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
    const propertyUID: string = await getUID(propTx);

    // Bind the PROPERTY value to the key anchor with a PIN. Re-binding under the
    // same key supersedes O(1) — readers always see the current value.
    await pin(signer, propertyUID, keyAnchorUID);
    return propertyUID;
  };

  /** Create a MIRROR on a DATA */
  const createMirror = async (signer: any, dataUID: string, transportDef: string, uri: string): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: mirrorSchemaUID,
      data: {
        recipient: ethers.ZeroAddress,
        expirationTime: 0n,
        revocable: true,
        refUID: dataUID,
        data: encode.encode(["bytes32", "string"], [transportDef, uri]),
        value: 0n,
      },
    });
    return getUID(tx);
  };

  /** Attest SORT_INFO pointing at a naming anchor */
  const sortInfo = async (
    signer: any,
    namingAnchorUID: string,
    sortFuncAddr: string,
    targetSchema = ethers.ZeroHash,
    sourceType = 0,
  ): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: sortInfoSchemaUID,
      data: {
        recipient: ethers.ZeroAddress,
        expirationTime: 0n,
        revocable: true,
        refUID: namingAnchorUID,
        data: encode.encode(["address", "bytes32", "uint8"], [sortFuncAddr, targetSchema, sourceType]),
        value: 0n,
      },
    });
    return getUID(tx);
  };

  /**
   * Place a DATA at an Anchor via PIN (ADR-0041: file placement is cardinality 1).
   * Returns the PIN attestation UID. A subsequent placeData at the same anchor by
   * the same attester (with a different DATA) supersedes the prior PIN in O(1).
   */
  const placeData = async (signer: any, dataUID: string, anchorUID: string): Promise<string> => {
    return pin(signer, dataUID, anchorUID);
  };

  /** Revoke the active file-placement PIN. Removes the placement. */
  const unplaceData = async (signer: any, dataUID: string, anchorUID: string): Promise<void> => {
    return unpin(signer, dataUID, anchorUID);
  };

  /**
   * Apply a TAG label (cardinality N): edge from `targetUID` under `definitionUID`
   * with optional sort/score weight. Multiple labels coexist per (attester, target).
   * Re-attesting the same (attester, target, definition) updates the weight in place.
   */
  const tagLabel = async (
    signer: any,
    targetUID: string,
    definitionUID: string,
    weight: bigint = 1n,
  ): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: tagSchemaUID,
      data: {
        recipient: ethers.ZeroAddress,
        expirationTime: 0n,
        revocable: true,
        refUID: targetUID,
        data: encode.encode(["bytes32", "int256"], [definitionUID, weight]),
        value: 0n,
      },
    });
    return getUID(tx);
  };

  /**
   * Remove a TAG label by revoking the active TAG attestation. Looks the active
   * UID up via EdgeResolver.getActiveEdgeUID — under TAG semantics there is at
   * most one active edge per (attester, target, definition).
   */
  const untagLabel = async (signer: any, targetUID: string, definitionUID: string): Promise<void> => {
    const attesterAddr = await signer.getAddress();
    const activeUID = await edgeResolver.getActiveEdgeUID(attesterAddr, targetUID, definitionUID, tagSchemaUID);
    if (activeUID === ethers.ZeroHash) throw new Error(`no active TAG for ${targetUID} / ${definitionUID}`);
    await eas.connect(signer).revoke({ schema: tagSchemaUID, data: { uid: activeUID, value: 0n } });
  };

  /** Drain all sorted items for a (sortInfoUID, parentAnchor) pair using cursor pagination */
  const readSortedAll = async (sInfoUID: string, parentAnchorUID: string): Promise<string[]> => {
    const result: string[] = [];
    let cursor = ethers.ZeroHash;
    do {
      const [chunk, next] = await overlay.getSortedChunk(sInfoUID, parentAnchorUID, cursor, 50n, false);
      result.push(...chunk);
      cursor = next;
    } while (cursor !== ethers.ZeroHash);
    return result;
  };

  /** Get the `name` field from an Anchor attestation */
  const getName = async (uid: string): Promise<string> => {
    const att = await eas.getAttestation(uid);
    const [name] = encode.decode(["string", "bytes32"], att.data) as unknown as [string, string];
    return name;
  };

  /**
   * Resolve the active DATA placed at an anchor by a prioritized list of attesters.
   * Uses EdgeResolver.getActivePinTarget — the O(1) read for cardinality-1 edges
   * (file placement under ADR-0041).
   * Returns {uid, uri} from the first attester that has an active PIN at the anchor.
   */
  const resolveLens = async (
    anchorUID: string,
    addressList: string[],
  ): Promise<{ uid: string; uri: string } | null> => {
    for (const attester of addressList) {
      const dataUID = await edgeResolver.getActivePinTarget(anchorUID, attester, dataSchemaUID);
      if (dataUID !== ethers.ZeroHash) {
        // Resolve the MIRROR URI for this DATA
        const mirrors = await indexer.getReferencingAttestations(dataUID, mirrorSchemaUID, 0, 1, false);
        if (mirrors.length > 0) {
          const mirrorAtt = await eas.getAttestation(mirrors[0]);
          const [, uri] = encode.decode(["bytes32", "string"], mirrorAtt.data);
          return { uid: dataUID, uri };
        }
        return { uid: dataUID, uri: "(no mirror)" };
      }
    }
    return null;
  };

  // ════════════════════════════════════════════════════════════════════════════════
  // PHASE 1: Build shared /music/ directory
  // ════════════════════════════════════════════════════════════════════════════════
  console.log("── Phase 1: Build /music/ directory ──\n");

  const musicUID = await anchor(deployer, `music_${S}`, rootUID);
  console.log(`  /music_${S}/  created`);

  // Alice adds 4 tracks (out of alphabetical order on purpose)
  const aliceZebra = await anchor(alice, "zebra.mp3", musicUID, dataSchemaUID);
  const aliceApple = await anchor(alice, "apple.mp3", musicUID, dataSchemaUID);
  const aliceMango = await anchor(alice, "mango.mp3", musicUID, dataSchemaUID);
  const aliceBanana = await anchor(alice, "banana.mp3", musicUID, dataSchemaUID);
  console.log("  Alice added: zebra.mp3, apple.mp3, mango.mp3, banana.mp3");

  // Bob adds 3 tracks
  const _bobWaterfall = await anchor(bob, "waterfall.mp3", musicUID, dataSchemaUID);
  await anchor(bob, "echo.mp3", musicUID, dataSchemaUID);
  await anchor(bob, "apex.mp3", musicUID, dataSchemaUID);
  console.log("  Bob   added: waterfall.mp3, echo.mp3, apex.mp3");

  assert("Alice has 4 items in kernel", (await indexer.getChildrenByAttesterCount(musicUID, aliceAddr)) === 4n);
  assert("Bob has 3 items in kernel", (await indexer.getChildrenByAttesterCount(musicUID, bobAddr)) === 3n);

  // ════════════════════════════════════════════════════════════════════════════════
  // PHASE 2: Register NameSort SORT_INFO (shared sorted list)
  // ════════════════════════════════════════════════════════════════════════════════
  console.log("\n── Phase 2: Register NameSort SORT_INFO (shared sorted list) ──\n");

  const alphaNameUID = await anchor(deployer, "alphabetical", musicUID, sortInfoSchemaUID);
  const alphaInfoUID = await sortInfo(deployer, alphaNameUID, (nameSortContract as any).target);

  assert("Sort registered", await overlay.isSortRegistered(alphaInfoUID));
  assert("Sort not revoked", !(await indexer.isRevoked(alphaInfoUID)));
  const config = await overlay.getSortConfig(alphaInfoUID);
  assert(
    "Sort config has correct sortFunc",
    config.sortFunc.toLowerCase() === ((nameSortContract as any).target as string).toLowerCase(),
  );

  // ════════════════════════════════════════════════════════════════════════════════
  // PHASE 3: Process shared sorted list (anyone can contribute — gas is public good)
  // ════════════════════════════════════════════════════════════════════════════════
  console.log("\n── Phase 3: Process shared sorted list ──\n");

  // Shared kernel: all children of musicUID (global _children array)
  const kernelCount = await indexer.getChildrenCount(musicUID);
  assert(
    "Kernel staleness = total children before processing",
    (await overlay.getSortStaleness(alphaInfoUID, musicUID)) === kernelCount,
  );

  // Fetch all items from global kernel using getChildAt (O(1) per item)
  const allKernelItems: string[] = [];
  for (let fetchIdx = 0; fetchIdx < Number(kernelCount); fetchIdx++) {
    allKernelItems.push(await indexer.getChildAt(musicUID, fetchIdx));
  }

  // Use overlay.computeHints() — free eth_call
  const [sortLeft, sortRight] = await overlay.computeHints(alphaInfoUID, musicUID, allKernelItems);
  const expectedIdx = await overlay.getLastProcessedIndex(alphaInfoUID, musicUID);
  await (
    await overlay
      .connect(alice)
      .processItems(alphaInfoUID, musicUID, expectedIdx, allKernelItems, [...sortLeft], [...sortRight])
  ).wait();

  const sharedSorted = await readSortedAll(alphaInfoUID, musicUID);
  const sharedSortedNames = await Promise.all(sharedSorted.map(getName));
  console.log("  Shared sorted:", sharedSortedNames);

  // Names in /music/: alphabetical(naming), apple.mp3, banana.mp3, mango.mp3, zebra.mp3, waterfall.mp3, echo.mp3, apex.mp3
  // Sorted: alphabetical < apex < apple < banana < echo < mango < waterfall < zebra
  assert("Shared sorted list has all 8 items", sharedSorted.length === 8, `got ${sharedSorted.length}`);
  assert("Staleness = 0 after processing", (await overlay.getSortStaleness(alphaInfoUID, musicUID)) === 0n);

  // ── Membership integrity: processItems rejects fabricated UIDs ───────────────
  const fakeUID = ethers.keccak256(ethers.toUtf8Bytes("not-a-real-kernel-item"));
  let rejectedFake = false;
  try {
    await overlay
      .connect(alice)
      .processItems(
        alphaInfoUID,
        musicUID,
        expectedIdx + BigInt(allKernelItems.length),
        [fakeUID],
        [ethers.ZeroHash],
        [ethers.ZeroHash],
      );
  } catch {
    rejectedFake = true;
  }
  assert("processItems rejects fabricated UIDs (InvalidItem)", rejectedFake);

  // ── overlay.computeHints cross-check ────────────────────────────────────────
  const [contractLeft, contractRight] = await overlay.computeHints(alphaInfoUID, musicUID, allKernelItems.slice(0, 2));
  const hintsMatch = contractLeft.length === 2 && contractRight.length === 2;
  assert("overlay.computeHints returns correct array lengths", hintsMatch);

  // ════════════════════════════════════════════════════════════════════════════════
  // PHASE 4: Lens-filtered sorted view via getSortedChunkByAddressList
  // ════════════════════════════════════════════════════════════════════════════════
  console.log("\n── Phase 4: Lens-filtered sorted views ──\n");

  // Alice's items only (filtered from shared sorted list)
  const [aliceFilteredSorted] = await overlay.getSortedChunkByAddressList(
    alphaInfoUID,
    musicUID,
    ethers.ZeroHash,
    50n,
    0n,
    [aliceAddr],
    false,
  );
  const aliceFilteredNames = await Promise.all(aliceFilteredSorted.map(getName));
  console.log("  Alice lens-filtered sorted:", aliceFilteredNames);
  assert(
    "Alice lens-filtered sorted has 4 items",
    aliceFilteredSorted.length === 4,
    `got ${aliceFilteredSorted.length}`,
  );

  // Bob's items only
  const [bobFilteredSorted] = await overlay.getSortedChunkByAddressList(
    alphaInfoUID,
    musicUID,
    ethers.ZeroHash,
    50n,
    0n,
    [bobAddr],
    false,
  );
  const bobFilteredNames = await Promise.all(bobFilteredSorted.map(getName));
  console.log("  Bob lens-filtered sorted:", bobFilteredNames);
  assert("Bob lens-filtered has 3 items", bobFilteredSorted.length === 3, `got ${bobFilteredSorted.length}`);

  // ════════════════════════════════════════════════════════════════════════════════
  // PHASE 5: Incremental processing — Alice adds 2 more items to shared list
  // ════════════════════════════════════════════════════════════════════════════════
  console.log("\n── Phase 5: Incremental processing (Alice adds carrot.mp3, aardvark.mp3) ──\n");

  const aliceCarrot = await anchor(alice, "carrot.mp3", musicUID, dataSchemaUID);
  const aliceAardvark = await anchor(alice, "aardvark.mp3", musicUID, dataSchemaUID);

  assert("Shared staleness = 2 after adding items", (await overlay.getSortStaleness(alphaInfoUID, musicUID)) === 2n);

  const continueIdx = await overlay.getLastProcessedIndex(alphaInfoUID, musicUID);
  const newKernelItems: string[] = [
    await indexer.getChildAt(musicUID, Number(continueIdx)),
    await indexer.getChildAt(musicUID, Number(continueIdx) + 1),
  ];
  const [aliceLeft2, aliceRight2] = await overlay.computeHints(alphaInfoUID, musicUID, newKernelItems);
  await (
    await overlay
      .connect(alice)
      .processItems(alphaInfoUID, musicUID, continueIdx, newKernelItems, [...aliceLeft2], [...aliceRight2])
  ).wait();

  const finalSorted = await readSortedAll(alphaInfoUID, musicUID);
  const finalNames = await Promise.all(finalSorted.map(getName));
  console.log("  Final shared sorted:", finalNames);
  // Now 10 items: original 8 + carrot + aardvark
  assert("Shared sorted = 10 items after adding 2 more", finalSorted.length === 10, `got ${finalSorted.length}`);
  assert("Staleness = 0", (await overlay.getSortStaleness(alphaInfoUID, musicUID)) === 0n);

  // ════════════════════════════════════════════════════════════════════════════════
  // PHASE 6: Cursor pagination of sorted list
  // ════════════════════════════════════════════════════════════════════════════════
  console.log("\n── Phase 6: Cursor pagination ──\n");

  let cursor = ethers.ZeroHash;
  const pagedNames: string[] = [];
  let pageCount = 0;
  do {
    const [chunk, next] = await overlay.getSortedChunk(alphaInfoUID, musicUID, cursor, 3n, false);
    pagedNames.push(...(await Promise.all(chunk.map(getName))));
    cursor = next;
    pageCount++;
  } while (cursor !== ethers.ZeroHash);

  console.log(`  ${pagedNames.length} items across ${pageCount} pages`);
  assert("Pagination returns all 10 items", pagedNames.length === finalSorted.length, `got ${pagedNames.length}`);
  assert("Pagination order matches direct read", pagedNames.join(",") === finalNames.join(","));

  // ════════════════════════════════════════════════════════════════════════════════
  // PHASE 7: DATA lenses — place content at anchors via PINs
  // ════════════════════════════════════════════════════════════════════════════════
  console.log("\n── Phase 7: DATA lenses (three-layer: DATA + MIRROR + PIN) ──\n");

  // Helper: create DATA + MIRROR + PIN (place at anchor) in sequence
  const uploadFile = async (
    signer: any,
    anchorUID: string,
    content: string,
    uri: string,
    contentType = "application/epub+zip",
  ) => {
    const d = await createData(signer, content);
    await property(signer, d.uid, "contentType", contentType);
    await createMirror(signer, d.uid, ipfsTransportUID, uri);
    await placeData(signer, d.uid, anchorUID);
    return d;
  };

  // Alice uploads her lenses for all 6 of her anchors
  const aliceAppleData = await uploadFile(alice, aliceApple, "alice-apple-v1-bytes", "ipfs://alice-apple-v1");
  await uploadFile(alice, aliceBanana, "alice-banana-v1-bytes", "ipfs://alice-banana-v1");
  await uploadFile(alice, aliceMango, "alice-mango-v1-bytes", "ipfs://alice-mango-v1");
  const aliceZebraData = await uploadFile(alice, aliceZebra, "alice-zebra-v1-bytes", "ipfs://alice-zebra-v1");
  await uploadFile(alice, aliceCarrot, "alice-carrot-v1-bytes", "ipfs://alice-carrot-v1");
  await uploadFile(alice, aliceAardvark, "alice-aardvark-v1-bytes", "ipfs://alice-aardvark-v1");
  console.log("  Alice uploaded lenses for all 6 anchors");

  // Bob uploads lenses for 3 of Alice's anchors (covering, remixing)
  await uploadFile(bob, aliceApple, "bob-apple-v1-bytes", "ipfs://bob-apple-v1");
  await uploadFile(bob, aliceBanana, "bob-banana-v1-bytes", "ipfs://bob-banana-v1");
  const bobZebraData = await uploadFile(bob, aliceZebra, "bob-zebra-v1-bytes", "ipfs://bob-zebra-v1");
  console.log("  Bob uploaded lenses for apple.mp3, banana.mp3, zebra.mp3");

  // Alice-only lookup
  const appleAlice = await resolveLens(aliceApple, [aliceAddr]);
  assert("apple.mp3 [alice] → alice's uri", appleAlice?.uri === "ipfs://alice-apple-v1", appleAlice?.uri ?? "null");

  // Bob-only lookup
  const appleBob = await resolveLens(aliceApple, [bobAddr]);
  assert("apple.mp3 [bob] → bob's uri", appleBob?.uri === "ipfs://bob-apple-v1", appleBob?.uri ?? "null");

  // Priority: Bob first
  const appleBobFirst = await resolveLens(aliceApple, [bobAddr, aliceAddr]);
  assert(
    "apple.mp3 [bob,alice] → bob wins",
    appleBobFirst?.uri === "ipfs://bob-apple-v1",
    appleBobFirst?.uri ?? "null",
  );

  // Priority: Alice first
  const appleAliceFirst = await resolveLens(aliceApple, [aliceAddr, bobAddr]);
  assert(
    "apple.mp3 [alice,bob] → alice wins",
    appleAliceFirst?.uri === "ipfs://alice-apple-v1",
    appleAliceFirst?.uri ?? "null",
  );

  // Anchor with no lens from Bob
  const carrotBob = await resolveLens(aliceCarrot, [bobAddr]);
  assert("carrot.mp3 [bob only] → null (no lens)", carrotBob === null);

  // ════════════════════════════════════════════════════════════════════════════════
  // PHASE 8: Lens removal via PIN revoke + fallback
  // ════════════════════════════════════════════════════════════════════════════════
  console.log("\n── Phase 8: Lens removal + fallback ──\n");

  // Alice removes her zebra placement (eas.revoke on the active PIN — ADR-0041).
  await unplaceData(alice, aliceZebraData.uid, aliceZebra);

  // Bob's lens should now win
  const zebraAfterRemoval = await resolveLens(aliceZebra, [aliceAddr, bobAddr]);
  assert(
    "zebra.mp3 [alice,bob]: falls back to bob after alice revokes PIN",
    zebraAfterRemoval?.uri === "ipfs://bob-zebra-v1",
    zebraAfterRemoval?.uri ?? "null",
  );

  // If both remove placement → null
  await unplaceData(bob, bobZebraData.uid, aliceZebra);
  const zebraAllRemoved = await resolveLens(aliceZebra, [aliceAddr, bobAddr]);
  assert("zebra.mp3: all placements removed → null", zebraAllRemoved === null);

  // Re-place Alice's zebra (new PIN)
  await placeData(alice, aliceZebraData.uid, aliceZebra);
  const zebraReplaced = await resolveLens(aliceZebra, [aliceAddr]);
  assert(
    "zebra.mp3: re-placed after removal",
    zebraReplaced?.uri === "ipfs://alice-zebra-v1",
    zebraReplaced?.uri ?? "null",
  );

  // ════════════════════════════════════════════════════════════════════════════════
  // PHASE 9: Sorted list + per-position lens resolution (main UI read path)
  // ════════════════════════════════════════════════════════════════════════════════
  console.log("\n── Phase 9: Sorted list + lens resolution ──\n");
  console.log("  (Simulates: UI renders sorted list, resolves content per item for [alice, bob])");

  const sortedPositions = await readSortedAll(alphaInfoUID, musicUID);
  const resolved: { name: string; uri: string | null }[] = [];

  for (const posUID of sortedPositions) {
    const name = await getName(posUID);
    const lens = await resolveLens(posUID, [aliceAddr, bobAddr]);
    resolved.push({ name, uri: lens?.uri ?? null });
  }

  console.log("  Sorted + lenses:");
  resolved.forEach(r => console.log(`    ${r.name} → ${r.uri ?? "(no lens)"}`));

  // aardvark and carrot only have Alice's lenses; apple and banana have both; zebra was re-placed by alice; mango only alice
  assert(
    "aardvark.mp3 → alice's uri",
    resolved.find(r => r.name === "aardvark.mp3")?.uri === "ipfs://alice-aardvark-v1",
  );
  assert(
    "apple.mp3 → alice's uri (alice first in list)",
    resolved.find(r => r.name === "apple.mp3")?.uri === "ipfs://alice-apple-v1",
  );
  assert(
    "banana.mp3 → alice's uri (alice first)",
    resolved.find(r => r.name === "banana.mp3")?.uri === "ipfs://alice-banana-v1",
  );
  assert("mango.mp3 → alice's uri", resolved.find(r => r.name === "mango.mp3")?.uri === "ipfs://alice-mango-v1");
  assert(
    "zebra.mp3 → alice's uri (re-placed)",
    resolved.find(r => r.name === "zebra.mp3")?.uri === "ipfs://alice-zebra-v1",
  );

  // Same list but bob-first: apple and banana should now resolve to bob's uri
  const resolvedBobFirst: { name: string; uri: string | null }[] = [];
  for (const posUID of sortedPositions) {
    const name = await getName(posUID);
    const lens = await resolveLens(posUID, [bobAddr, aliceAddr]);
    resolvedBobFirst.push({ name, uri: lens?.uri ?? null });
  }
  assert(
    "apple.mp3 [bob,alice] → bob's uri",
    resolvedBobFirst.find(r => r.name === "apple.mp3")?.uri === "ipfs://bob-apple-v1",
  );
  assert(
    "carrot.mp3 [bob,alice] → alice's uri (bob has none)",
    resolvedBobFirst.find(r => r.name === "carrot.mp3")?.uri === "ipfs://alice-carrot-v1",
  );

  // ════════════════════════════════════════════════════════════════════════════════
  // PHASE 10: Directory listing — dedup vs interleaved
  // ════════════════════════════════════════════════════════════════════════════════
  console.log("\n── Phase 10: Directory listing (dedup and interleaved) ──\n");

  // getChildrenByAddressList — unique items only, global insertion order
  // Alice-only: 6 anchors alice created (zebra, apple, mango, banana, carrot, aardvark)
  const [aliceOnly] = await indexer.getChildrenByAddressList(musicUID, [aliceAddr], 0n, 50, false, false);
  assert("Alice-only dedup = 6 unique anchors", aliceOnly.length === 6, `got ${aliceOnly.length}`);

  // Bob-only: 3 anchors he created + anchors where he still has an active PIN.
  // He uploaded PINs at apple, banana, zebra in Phase 7, then revoked his zebra
  // PIN in Phase 8. EdgeResolver's onRevoke calls indexer.clearContains() once
  // an attester's active-edge count at an anchor drops to zero, so zebra is no
  // longer in Bob's _containsAttestations set: 3 created + 2 still-active = 5.
  const [bobOnly] = await indexer.getChildrenByAddressList(musicUID, [bobAddr], 0n, 50, false, false);
  assert(
    "Bob-only dedup = 5 unique anchors (3 created + 2 active PIN placements after zebra revoke)",
    bobOnly.length === 5,
    `got ${bobOnly.length}`,
  );

  // Combined [alice, bob]: 9 unique anchors (all in /music/ except the SORT_INFO naming anchor
  // which was created by deployer, not alice or bob)
  let dedupCursor = 0n;
  const dedupResults: string[] = [];
  do {
    const [page, next] = await indexer.getChildrenByAddressList(
      musicUID,
      [aliceAddr, bobAddr],
      dedupCursor,
      4,
      false,
      false,
    );
    dedupResults.push(...page);
    dedupCursor = next;
  } while (dedupCursor > 0n);

  assert(
    "Dedup [alice,bob] = 9 unique anchors (no duplicates)",
    dedupResults.length === 9,
    `got ${dedupResults.length}`,
  );
  assert("Dedup results have no duplicates", new Set(dedupResults).size === dedupResults.length);
  // First item = global insertion order: zebra was created first
  assert("Dedup first item = aliceZebra (insertion order)", dedupResults[0] === aliceZebra);

  console.log(`  dedup: ${dedupResults.length} unique items`);

  // ════════════════════════════════════════════════════════════════════════════════
  // PHASE 11: Version history — new DATA + PIN supersede
  // ════════════════════════════════════════════════════════════════════════════════
  console.log("\n── Phase 11: Version history (PIN supersede O(1)) ──\n");

  // Alice uploads a v2 of apple.mp3: new DATA, then a new PIN at the same anchor.
  // Under ADR-0041, the new PIN supersedes the v1 PIN automatically — no untag needed.
  // (uploadFile internally calls placeData → pin, which writes _activeBySlot in O(1).)
  const aliceAppleV2 = await uploadFile(alice, aliceApple, "alice-apple-v2-bytes", "ipfs://alice-apple-v2");
  // Note on activePinIndex: pin() keys by (target, definition, attester) so the v1 and v2
  // PINs are tracked under different keys — both stay in the local map. On-chain, the v2
  // PIN supersedes v1 in O(1) via _activeBySlot. The stale v1 entry in the map is harmless
  // because nothing in this script revokes it.

  // Link v2 → v1 via previousVersion PROPERTY
  await property(alice, aliceAppleV2.uid, "previousVersion", aliceAppleData.uid);
  console.log("  Alice uploaded apple.mp3 v2 — PIN supersedes v1 in O(1)");

  // Now only v2 should resolve
  const appleAfterV2 = await resolveLens(aliceApple, [aliceAddr]);
  assert("After version swap, v2 resolves", appleAfterV2?.uri === "ipfs://alice-apple-v2", appleAfterV2?.uri ?? "null");

  // Verify previousVersion PROPERTY chain (PIN-bound under ADR-0041)
  const prevVersionKeyAnchor = await indexer.resolveAnchor(aliceAppleV2.uid, "previousVersion", propertySchemaUID);
  assert(
    "previousVersion key anchor exists on v2",
    prevVersionKeyAnchor !== ethers.ZeroHash,
    `got ${prevVersionKeyAnchor}`,
  );
  // PROPERTY value binding is a PIN: getActivePinTarget returns the PROPERTY UID directly.
  const prevVersionPropUID = await edgeResolver.getActivePinTarget(prevVersionKeyAnchor, aliceAddr, propertySchemaUID);
  assert(
    "Alice has an active previousVersion PROPERTY binding",
    prevVersionPropUID !== ethers.ZeroHash,
    `got ${prevVersionPropUID}`,
  );
  const prevPropAtt = await eas.getAttestation(prevVersionPropUID);
  const [prevValue] = encode.decode(["string"], prevPropAtt.data);
  assert("previousVersion PROPERTY links v2 → v1", prevValue === aliceAppleData.uid, `got ${prevValue}`);

  // ════════════════════════════════════════════════════════════════════════════════
  // PHASE 12: Tags on list items (labels — cardinality N)
  // ════════════════════════════════════════════════════════════════════════════════
  console.log("\n── Phase 12: Tags on list items (cardinality N) ──\n");

  // Create tag definition anchors
  const favoriteDefUID = await anchor(deployer, `favorite_${S}`, rootUID);
  const classicDefUID = await anchor(deployer, `classic_${S}`, rootUID);
  console.log("  Tag definitions: favorite, classic");

  // Alice tags apple v2 and v1 DATA as "favorite" (different DATAs at same label coexist)
  await tagLabel(alice, aliceAppleV2.uid, favoriteDefUID);
  await tagLabel(alice, aliceAppleData.uid, favoriteDefUID); // tag v1 too (both versions labeled)
  // Resolve Alice's banana DATA via the now-O(1) PIN read.
  const aliceBananaData = await edgeResolver.getActivePinTarget(aliceBanana, aliceAddr, dataSchemaUID);
  await tagLabel(alice, aliceBananaData, favoriteDefUID);

  // Bob tags apple DATA as "favorite" and mango DATA as "classic"
  const bobAppleData = await edgeResolver.getActivePinTarget(aliceApple, bobAddr, dataSchemaUID);
  await tagLabel(bob, bobAppleData, favoriteDefUID);

  const aliceMangoData = await edgeResolver.getActivePinTarget(aliceMango, aliceAddr, dataSchemaUID);
  await tagLabel(bob, aliceMangoData, classicDefUID);
  console.log("  Alice: favorite(apple v1+v2, banana); Bob: favorite(apple), classic(mango)");

  // hasActiveEdge: O(1) cross-attester check via shared aggregate counter
  assert(
    "apple v2 DATA has an active favorite edge (any attester)",
    await edgeResolver.hasActiveEdge(aliceAppleV2.uid, favoriteDefUID),
  );
  assert("banana DATA has an active favorite edge", await edgeResolver.hasActiveEdge(aliceBananaData, favoriteDefUID));
  assert("mango DATA has an active classic edge", await edgeResolver.hasActiveEdge(aliceMangoData, classicDefUID));

  // getActiveEdgeUID: specific attester's active TAG (schema-aware)
  const aliceAppleTagUID = await edgeResolver.getActiveEdgeUID(
    aliceAddr,
    aliceAppleV2.uid,
    favoriteDefUID,
    tagSchemaUID,
  );
  assert("Alice has an active TAG UID on apple v2 DATA", aliceAppleTagUID !== ethers.ZeroHash);

  // Negate a tag: Alice un-favorites banana (revoke the active TAG attestation)
  await untagLabel(alice, aliceBananaData, favoriteDefUID);
  // Bob's tags on banana? None — so the cross-attester counter goes to zero.
  assert(
    "banana DATA: no longer has an active favorite edge after Alice revokes",
    !(await edgeResolver.hasActiveEdge(aliceBananaData, favoriteDefUID)),
  );
  // apple v2 still active (alice's TAG plus bob's TAG on bobAppleData; we check alice's slot)
  assert(
    "apple v2 still actively tagged as favorite by Alice",
    await edgeResolver.isActiveEdge(aliceAddr, aliceAppleV2.uid, favoriteDefUID, tagSchemaUID),
  );

  // ════════════════════════════════════════════════════════════════════════════════
  // PHASE 13: Discover available sorts via getAnchorsBySchema
  // ════════════════════════════════════════════════════════════════════════════════
  console.log("\n── Phase 13: Sort discovery ──\n");

  const sortNamingAnchors = await indexer["getAnchorsBySchema(bytes32,bytes32,uint256,uint256,bool)"](
    musicUID,
    sortInfoSchemaUID,
    0,
    10,
    false,
  );
  assert(
    "getAnchorsBySchema finds 1 sort naming anchor in /music/",
    sortNamingAnchors.length === 1 && sortNamingAnchors[0] === alphaNameUID,
    `got ${sortNamingAnchors.length}`,
  );

  const sortInfoRefsFromIndexer = await indexer.getReferencingAttestations(
    alphaNameUID,
    sortInfoSchemaUID,
    0,
    10,
    false,
  );
  assert(
    "EFSIndexer has 1 SORT_INFO ref via index() wiring (fully on-chain discovery)",
    sortInfoRefsFromIndexer.length === 1,
    `got ${sortInfoRefsFromIndexer.length}`,
  );
  assert("Discovered SORT_INFO UID matches known alphaInfoUID", sortInfoRefsFromIndexer[0] === alphaInfoUID);

  const discoveredConfig = await overlay.getSortConfig(alphaInfoUID);
  assert("getSortConfig returns valid config for known sortInfoUID", await overlay.isSortRegistered(alphaInfoUID));
  assert(
    "Discovered sortFunc is NameSort",
    discoveredConfig.sortFunc.toLowerCase() === ((nameSortContract as any).target as string).toLowerCase(),
  );

  const namingAnchorName = await getName(alphaNameUID);
  assert("Naming anchor name = alphabetical", namingAnchorName === "alphabetical");

  const sortLength = await overlay.getSortLength(alphaInfoUID, musicUID);
  const sortStaleness = await overlay.getSortStaleness(alphaInfoUID, musicUID);
  assert("getSortLength = 10 (all shared items)", sortLength === 10n, `got ${sortLength}`);
  assert("getSortStaleness = 0", sortStaleness === 0n, `got ${sortStaleness}`);

  console.log(`  Sort: "${namingAnchorName}" → sortFunc ${discoveredConfig.sortFunc}`);

  // ════════════════════════════════════════════════════════════════════════════════
  // PHASE 14: TimestampSort on a separate directory
  // ════════════════════════════════════════════════════════════════════════════════
  console.log("\n── Phase 14: TimestampSort ──\n");

  const vidDirUID = await anchor(deployer, `videos_${S}`, rootUID);
  const vid1 = await anchor(alice, "first.mp4", vidDirUID, dataSchemaUID);
  const vid2 = await anchor(alice, "second.mp4", vidDirUID, dataSchemaUID);
  const vid3 = await anchor(alice, "third.mp4", vidDirUID, dataSchemaUID);

  const tsNameUID = await anchor(deployer, "by-date", vidDirUID, sortInfoSchemaUID);
  const tsInfoUID = await sortInfo(deployer, tsNameUID, (timestampSort as any).target);

  // Fetch all video anchors from the global kernel (includes by-date sort naming anchor)
  const vidKernelCount = await indexer.getChildrenCount(vidDirUID);
  const vidItems: string[] = [];
  for (let i = 0; i < Number(vidKernelCount); i++) {
    vidItems.push(await indexer.getChildAt(vidDirUID, i));
  }

  const [tsLeft, tsRight] = await overlay.computeHints(tsInfoUID, vidDirUID, [...vidItems]);
  const tsExpectedIdx = await overlay.getLastProcessedIndex(tsInfoUID, vidDirUID);
  await (
    await overlay
      .connect(alice)
      .processItems(tsInfoUID, vidDirUID, tsExpectedIdx, [...vidItems], [...tsLeft], [...tsRight])
  ).wait();

  const tsSorted = await readSortedAll(tsInfoUID, vidDirUID);
  assert(
    "TimestampSort: insertion order preserved (oldest first)",
    tsSorted[0] === vid1 && tsSorted[1] === vid2 && tsSorted[2] === vid3,
    (await Promise.all(tsSorted.map(getName))).join(","),
  );

  // Alice uploads DATA + MIRRORs to her videos
  await uploadFile(alice, vid1, "alice-first-mp4-bytes", "ipfs://alice-first-mp4", "video/mp4");
  await uploadFile(alice, vid2, "alice-second-mp4-bytes", "ipfs://alice-second-mp4", "video/mp4");
  await uploadFile(alice, vid3, "alice-third-mp4-bytes", "ipfs://alice-third-mp4", "video/mp4");

  const vid1Lens = await resolveLens(vid1, [aliceAddr]);
  assert("vid1 lens resolves correctly", vid1Lens?.uri === "ipfs://alice-first-mp4", vid1Lens?.uri ?? "null");

  // ════════════════════════════════════════════════════════════════════════════════
  // PHASE 15: Revoke SORT_INFO — processItems blocked, existing data readable
  // ════════════════════════════════════════════════════════════════════════════════
  console.log("\n── Phase 15: Revoke SORT_INFO ──\n");

  await (
    await eas.connect(deployer).revoke({ schema: sortInfoSchemaUID, data: { uid: alphaInfoUID, value: 0n } })
  ).wait();

  assert("Sort config marked revoked", await indexer.isRevoked(alphaInfoUID));

  let revertedCorrectly = false;
  try {
    const lastIdx2 = await overlay.getLastProcessedIndex(alphaInfoUID, musicUID);
    await overlay
      .connect(alice)
      .processItems(alphaInfoUID, musicUID, lastIdx2, [aliceApple], [ethers.ZeroHash], [ethers.ZeroHash]);
  } catch {
    revertedCorrectly = true;
  }
  assert("processItems reverts on revoked sortInfoUID", revertedCorrectly);

  // Existing sorted data is still readable after revoke
  const afterRevoke = await readSortedAll(alphaInfoUID, musicUID);
  assert("Sorted data still readable after sort revoke", afterRevoke.length === 10, `got ${afterRevoke.length}`);

  // Lenses still resolve correctly after sort is revoked (sort ≠ content)
  const appleLensAfterSortRevoke = await resolveLens(aliceApple, [aliceAddr]);
  assert(
    "Lens resolution unaffected by sort revoke",
    appleLensAfterSortRevoke?.uri === "ipfs://alice-apple-v2",
    appleLensAfterSortRevoke?.uri ?? "null",
  );

  // Suppress unused-var lint on aliceMangoData / bobAppleData — they are used above.
  void aliceMangoData;
  void bobAppleData;
  void _bobWaterfall;

  // ════════════════════════════════════════════════════════════════════════════════
  // Summary
  // ════════════════════════════════════════════════════════════════════════════════
  console.log("\n════════════════════════════════════════════════════════════");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log("════════════════════════════════════════════════════════════\n");

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
