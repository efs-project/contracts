import { ethers } from "hardhat";
import { EFSIndexer, EFSSortOverlay, NameSort, TimestampSort, TagResolver } from "../typechain-types";

/**
 * EFS Sort Overlay + Editions + Tags Simulation
 *
 * Exercises everything the UI will need against a deployed EFS stack using the
 * three-layer data model: paths (Anchors) → data (DATA) → retrieval (MIRRORs).
 *
 * Two users (Alice, Bob) build a shared /music/ directory, sort it independently,
 * place DATAs via TAGs, add MIRRORs, label items with tag definitions, and exercise
 * every read path the UI will call.
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
  console.log("  Sorts · DATA · MIRRORs · TAGs · Editions");
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
  const tagSchemaUID = await indexer.TAG_SCHEMA_UID();
  const tagResolverAddr = await indexer.tagResolver();
  const tagResolver = (await ethers.getContractAt("TagResolver", tagResolverAddr)) as unknown as TagResolver;
  const rootUID = await indexer.rootAnchorUID();

  // Resolve /transports/ for MIRRORs
  const transportsUID = await indexer.resolvePath(rootUID, "transports");
  const ipfsTransportUID = await indexer.resolvePath(transportsUID, "ipfs");

  console.log(`Indexer:     ${indexer.target}`);
  console.log(`Overlay:     ${overlay.target}`);
  console.log(`TagResolver: ${tagResolverAddr}`);
  console.log(`EAS:         ${easAddress}`);
  console.log(`Root:        ${rootUID}\n`);

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
   * Attach a PROPERTY to a container using the unified free-floating model
   * (ADR-0035): key anchor under the container, free-floating PROPERTY(value),
   * and a TAG binding them. Returns the PROPERTY UID.
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

    await eas.connect(signer).attest({
      schema: tagSchemaUID,
      data: {
        recipient: ethers.ZeroAddress,
        expirationTime: 0n,
        revocable: true,
        refUID: propertyUID,
        data: encode.encode(["bytes32", "bool"], [keyAnchorUID, true]),
        value: 0n,
      },
    });
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

  /** Place a DATA at an Anchor via TAG */
  const placeData = async (signer: any, dataUID: string, anchorUID: string, applies = true): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: tagSchemaUID,
      data: {
        recipient: ethers.ZeroAddress,
        expirationTime: 0n,
        revocable: true,
        refUID: dataUID,
        data: encode.encode(["bytes32", "bool"], [anchorUID, applies]),
        value: 0n,
      },
    });
    return getUID(tx);
  };

  /** Attest a TAG (definition, applies) targeting an anchor (for labels) */
  const tagLabel = async (signer: any, targetUID: string, definitionUID: string, applies = true): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: tagSchemaUID,
      data: {
        recipient: ethers.ZeroAddress,
        expirationTime: 0n,
        revocable: true,
        refUID: targetUID,
        data: encode.encode(["bytes32", "bool"], [definitionUID, applies]),
        value: 0n,
      },
    });
    return getUID(tx);
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
   * Resolve the first DATA placed at an anchor by a prioritized list of attesters.
   * Uses TagResolver.getActiveTargetsByAttesterAndSchema — the new edition resolution path.
   * Returns {uid, uri} from the first attester that has a TAG placement.
   */
  const resolveEdition = async (
    anchorUID: string,
    addressList: string[],
  ): Promise<{ uid: string; uri: string } | null> => {
    for (const attester of addressList) {
      const targets = await tagResolver.getActiveTargetsByAttesterAndSchema(anchorUID, attester, dataSchemaUID, 0, 1);
      if (targets.length > 0) {
        const dataUID = targets[0];
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
  // PHASE 4: Edition-filtered sorted view via getSortedChunkByAddressList
  // ════════════════════════════════════════════════════════════════════════════════
  console.log("\n── Phase 4: Edition-filtered sorted views ──\n");

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
  console.log("  Alice edition-filtered sorted:", aliceFilteredNames);
  assert(
    "Alice edition-filtered sorted has 4 items",
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
  console.log("  Bob edition-filtered sorted:", bobFilteredNames);
  assert("Bob edition-filtered has 3 items", bobFilteredSorted.length === 3, `got ${bobFilteredSorted.length}`);

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
  // PHASE 7: DATA editions — place content at anchors via TAGs
  // ════════════════════════════════════════════════════════════════════════════════
  console.log("\n── Phase 7: DATA editions (three-layer: DATA + MIRROR + TAG) ──\n");

  // Helper: create DATA + MIRROR + TAG (place at anchor) in sequence
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

  // Alice uploads her editions for all 6 of her anchors
  const aliceAppleData = await uploadFile(alice, aliceApple, "alice-apple-v1-bytes", "ipfs://alice-apple-v1");
  await uploadFile(alice, aliceBanana, "alice-banana-v1-bytes", "ipfs://alice-banana-v1");
  await uploadFile(alice, aliceMango, "alice-mango-v1-bytes", "ipfs://alice-mango-v1");
  const aliceZebraData = await uploadFile(alice, aliceZebra, "alice-zebra-v1-bytes", "ipfs://alice-zebra-v1");
  await uploadFile(alice, aliceCarrot, "alice-carrot-v1-bytes", "ipfs://alice-carrot-v1");
  await uploadFile(alice, aliceAardvark, "alice-aardvark-v1-bytes", "ipfs://alice-aardvark-v1");
  console.log("  Alice uploaded editions for all 6 anchors");

  // Bob uploads editions for 3 of Alice's anchors (covering, remixing)
  await uploadFile(bob, aliceApple, "bob-apple-v1-bytes", "ipfs://bob-apple-v1");
  await uploadFile(bob, aliceBanana, "bob-banana-v1-bytes", "ipfs://bob-banana-v1");
  const bobZebraData = await uploadFile(bob, aliceZebra, "bob-zebra-v1-bytes", "ipfs://bob-zebra-v1");
  console.log("  Bob uploaded editions for apple.mp3, banana.mp3, zebra.mp3");

  // Alice-only lookup
  const appleAlice = await resolveEdition(aliceApple, [aliceAddr]);
  assert("apple.mp3 [alice] → alice's uri", appleAlice?.uri === "ipfs://alice-apple-v1", appleAlice?.uri ?? "null");

  // Bob-only lookup
  const appleBob = await resolveEdition(aliceApple, [bobAddr]);
  assert("apple.mp3 [bob] → bob's uri", appleBob?.uri === "ipfs://bob-apple-v1", appleBob?.uri ?? "null");

  // Priority: Bob first
  const appleBobFirst = await resolveEdition(aliceApple, [bobAddr, aliceAddr]);
  assert(
    "apple.mp3 [bob,alice] → bob wins",
    appleBobFirst?.uri === "ipfs://bob-apple-v1",
    appleBobFirst?.uri ?? "null",
  );

  // Priority: Alice first
  const appleAliceFirst = await resolveEdition(aliceApple, [aliceAddr, bobAddr]);
  assert(
    "apple.mp3 [alice,bob] → alice wins",
    appleAliceFirst?.uri === "ipfs://alice-apple-v1",
    appleAliceFirst?.uri ?? "null",
  );

  // Anchor with no edition from Bob
  const carrotBob = await resolveEdition(aliceCarrot, [bobAddr]);
  assert("carrot.mp3 [bob only] → null (no edition)", carrotBob === null);

  // ════════════════════════════════════════════════════════════════════════════════
  // PHASE 8: Edition removal via TAG applies=false + fallback
  // ════════════════════════════════════════════════════════════════════════════════
  console.log("\n── Phase 8: Edition removal + fallback ──\n");

  // Alice removes her zebra placement (TAG applies=false)
  await placeData(alice, aliceZebraData.uid, aliceZebra, false);

  // Bob's edition should now win
  const zebraAfterRemoval = await resolveEdition(aliceZebra, [aliceAddr, bobAddr]);
  assert(
    "zebra.mp3 [alice,bob]: falls back to bob after alice removes placement",
    zebraAfterRemoval?.uri === "ipfs://bob-zebra-v1",
    zebraAfterRemoval?.uri ?? "null",
  );

  // If both remove placement → null
  await placeData(bob, bobZebraData.uid, aliceZebra, false);
  const zebraAllRemoved = await resolveEdition(aliceZebra, [aliceAddr, bobAddr]);
  assert("zebra.mp3: all placements removed → null", zebraAllRemoved === null);

  // Re-place Alice's zebra (TAG applies=true again)
  await placeData(alice, aliceZebraData.uid, aliceZebra, true);
  const zebraReplaced = await resolveEdition(aliceZebra, [aliceAddr]);
  assert(
    "zebra.mp3: re-placed after removal",
    zebraReplaced?.uri === "ipfs://alice-zebra-v1",
    zebraReplaced?.uri ?? "null",
  );

  // ════════════════════════════════════════════════════════════════════════════════
  // PHASE 9: Sorted list + per-position edition resolution (main UI read path)
  // ════════════════════════════════════════════════════════════════════════════════
  console.log("\n── Phase 9: Sorted list + edition resolution ──\n");
  console.log("  (Simulates: UI renders sorted list, resolves content per item for [alice, bob])");

  const sortedPositions = await readSortedAll(alphaInfoUID, musicUID);
  const resolved: { name: string; uri: string | null }[] = [];

  for (const posUID of sortedPositions) {
    const name = await getName(posUID);
    const edition = await resolveEdition(posUID, [aliceAddr, bobAddr]);
    resolved.push({ name, uri: edition?.uri ?? null });
  }

  console.log("  Sorted + editions:");
  resolved.forEach(r => console.log(`    ${r.name} → ${r.uri ?? "(no edition)"}`));

  // aardvark and carrot only have Alice's editions; apple and banana have both; zebra was re-placed by alice; mango only alice
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
    const edition = await resolveEdition(posUID, [bobAddr, aliceAddr]);
    resolvedBobFirst.push({ name, uri: edition?.uri ?? null });
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

  // Bob-only: 3 anchors he created + anchors where he placed DATA via TAG
  const [bobOnly] = await indexer.getChildrenByAddressList(musicUID, [bobAddr], 0n, 50, false, false);
  assert(
    "Bob-only dedup = 6 unique anchors (3 created + 3 with TAG placement)",
    bobOnly.length === 6,
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
  // PHASE 11: Version history — new DATA + TAG swap
  // ════════════════════════════════════════════════════════════════════════════════
  console.log("\n── Phase 11: Version history (new DATA + TAG swap) ──\n");

  // Alice uploads a v2 of apple.mp3: new DATA, untag old, tag new
  const aliceAppleV2 = await uploadFile(alice, aliceApple, "alice-apple-v2-bytes", "ipfs://alice-apple-v2");
  // Link v2 → v1 via previousVersion PROPERTY
  await property(alice, aliceAppleV2.uid, "previousVersion", aliceAppleData.uid);
  // Remove old placement
  await placeData(alice, aliceAppleData.uid, aliceApple, false);
  console.log("  Alice uploaded apple.mp3 v2, untagged v1");

  // Now only v2 should resolve
  const appleAfterV2 = await resolveEdition(aliceApple, [aliceAddr]);
  assert("After version swap, v2 resolves", appleAfterV2?.uri === "ipfs://alice-apple-v2", appleAfterV2?.uri ?? "null");

  // Verify previousVersion PROPERTY chain (unified free-floating model)
  const prevVersionKeyAnchor = await indexer.resolveAnchor(aliceAppleV2.uid, "previousVersion", propertySchemaUID);
  assert(
    "previousVersion key anchor exists on v2",
    prevVersionKeyAnchor !== ethers.ZeroHash,
    `got ${prevVersionKeyAnchor}`,
  );
  const prevVersionProps = await tagResolver.getActiveTargetsByAttesterAndSchema(
    prevVersionKeyAnchor,
    aliceAddr,
    propertySchemaUID,
    0,
    1,
  );
  assert(
    "Alice has 1 active previousVersion PROPERTY",
    prevVersionProps.length === 1,
    `got ${prevVersionProps.length}`,
  );
  const prevPropAtt = await eas.getAttestation(prevVersionProps[0]);
  const [prevValue] = encode.decode(["string"], prevPropAtt.data);
  assert("previousVersion PROPERTY links v2 → v1", prevValue === aliceAppleData.uid, `got ${prevValue}`);

  // ════════════════════════════════════════════════════════════════════════════════
  // PHASE 12: Tags on list items (labels, not file placement)
  // ════════════════════════════════════════════════════════════════════════════════
  console.log("\n── Phase 12: Tags on list items ──\n");

  // Create tag definition anchors
  const favoriteDefUID = await anchor(deployer, `favorite_${S}`, rootUID);
  const classicDefUID = await anchor(deployer, `classic_${S}`, rootUID);
  console.log("  Tag definitions: favorite, classic");

  // Alice tags apple and banana DATA as "favorite"
  await tagLabel(alice, aliceAppleV2.uid, favoriteDefUID);
  await tagLabel(alice, aliceAppleData.uid, favoriteDefUID); // tag v1 too (both versions labeled)
  const aliceBananaData = (
    await tagResolver.getActiveTargetsByAttesterAndSchema(aliceBanana, aliceAddr, dataSchemaUID, 0, 1)
  )[0];
  await tagLabel(alice, aliceBananaData, favoriteDefUID);

  // Bob tags apple DATA as "favorite" and mango DATA as "classic"
  const bobAppleData = (
    await tagResolver.getActiveTargetsByAttesterAndSchema(aliceApple, bobAddr, dataSchemaUID, 0, 1)
  )[0];
  await tagLabel(bob, bobAppleData, favoriteDefUID);

  const aliceMangoData = (
    await tagResolver.getActiveTargetsByAttesterAndSchema(aliceMango, aliceAddr, dataSchemaUID, 0, 1)
  )[0];
  await tagLabel(bob, aliceMangoData, classicDefUID);
  console.log("  Alice: favorite(apple v1+v2, banana); Bob: favorite(apple), classic(mango)");

  // isActivelyTagged: O(1) counter
  assert(
    "apple v2 DATA is actively tagged as favorite",
    await tagResolver.isActivelyTagged(aliceAppleV2.uid, favoriteDefUID),
  );
  assert(
    "banana DATA is actively tagged as favorite",
    await tagResolver.isActivelyTagged(aliceBananaData, favoriteDefUID),
  );
  assert("mango DATA is actively tagged as classic", await tagResolver.isActivelyTagged(aliceMangoData, classicDefUID));

  // getActiveTagUID: specific attester's active tag
  const aliceAppleTagUID = await tagResolver.getActiveTagUID(aliceAddr, aliceAppleV2.uid, favoriteDefUID);
  assert("Alice has an active tag UID on apple v2 DATA", aliceAppleTagUID !== ethers.ZeroHash);

  // Negate a tag: Alice un-favorites banana
  await tagLabel(alice, aliceBananaData, favoriteDefUID, false);
  assert(
    "banana DATA: no longer actively tagged after Alice negates",
    !(await tagResolver.isActivelyTagged(aliceBananaData, favoriteDefUID)),
  );
  // apple v2 still active
  assert(
    "apple v2 still actively tagged as favorite",
    await tagResolver.isActivelyTagged(aliceAppleV2.uid, favoriteDefUID),
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

  const vid1Edition = await resolveEdition(vid1, [aliceAddr]);
  assert("vid1 edition resolves correctly", vid1Edition?.uri === "ipfs://alice-first-mp4", vid1Edition?.uri ?? "null");

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

  // Editions still resolve correctly after sort is revoked (sort ≠ content)
  const appleEditionAfterSortRevoke = await resolveEdition(aliceApple, [aliceAddr]);
  assert(
    "Edition resolution unaffected by sort revoke",
    appleEditionAfterSortRevoke?.uri === "ipfs://alice-apple-v2",
    appleEditionAfterSortRevoke?.uri ?? "null",
  );

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
