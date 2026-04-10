import { ethers } from "hardhat";
import { EFSIndexer, EFSSortOverlay, NameSort, TimestampSort, TagResolver } from "../typechain-types";

/**
 * EFS Sort Overlay + Editions + Tags Simulation
 *
 * Exercises everything the UI will need against a deployed EFSIndexer, EFSSortOverlay,
 * and TagResolver. Two users (Alice, Bob) build a shared /music/ directory, sort it
 * independently, attach editions (DATA) to each item, tag items, and exercise every
 * read path the UI will call.
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
  console.log("  Sorts · Editions · Tags · History · Discovery");
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
  const sortInfoSchemaUID = await indexer.SORT_INFO_SCHEMA_UID();
  const tagSchemaUID = await indexer.TAG_SCHEMA_UID();
  const tagResolverAddr = await indexer.tagResolver();
  const tagResolver = (await ethers.getContractAt("TagResolver", tagResolverAddr)) as unknown as TagResolver;
  const rootUID = await indexer.rootAnchorUID();

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

  /** Attest DATA to an anchor (simulates file upload) */
  const data = async (
    signer: any,
    anchorUID: string,
    uri: string,
    contentType = "application/epub+zip",
    fileMode = "file",
  ): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: dataSchemaUID,
      data: {
        recipient: ethers.ZeroAddress,
        expirationTime: 0n,
        revocable: true,
        refUID: anchorUID,
        data: encode.encode(["string", "string", "string"], [uri, contentType, fileMode]),
        value: 0n,
      },
    });
    return getUID(tx);
  };

  /** Revoke a DATA attestation */
  const revokeData = async (signer: any, uid: string): Promise<void> => {
    await (await eas.connect(signer).revoke({ schema: dataSchemaUID, data: { uid, value: 0n } })).wait();
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

  /** Attest a TAG (definition, applies) targeting an anchor */
  const tag = async (signer: any, targetUID: string, definitionUID: string, applies = true): Promise<string> => {
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

  /**
   * Compute processItems hints for a batch of new kernel items.
   * Uses ISortFunc.getSortKey to determine ordering.
   * Takes into account items already in the sorted list.
   */
  const _computeHints = async (
    newItems: string[],
    alreadySorted: string[],
    sortFuncAddr: string,
    sortInfoUID: string,
  ): Promise<{ leftHints: string[]; rightHints: string[] }> => {
    const iface = new ethers.Interface([
      "function getSortKey(bytes32 uid, bytes32 sortInfoUID) external view returns (bytes memory)",
    ]);
    const func = new ethers.Contract(sortFuncAddr, iface, ethers.provider);

    const newKeys: Buffer[] = await Promise.all(
      newItems.map(async uid => Buffer.from(((await func.getSortKey(uid, sortInfoUID)) as string).slice(2), "hex")),
    );
    const existingKeys: Buffer[] = await Promise.all(
      alreadySorted.map(async uid =>
        Buffer.from(((await func.getSortKey(uid, sortInfoUID)) as string).slice(2), "hex"),
      ),
    );

    const simList = [...alreadySorted];
    const simKeys = [...existingKeys];
    const leftHints: string[] = [];
    const rightHints: string[] = [];

    for (let i = 0; i < newItems.length; i++) {
      const uid = newItems[i];
      const key = newKeys[i];

      if (key.length === 0) {
        leftHints.push(ethers.ZeroHash);
        rightHints.push(ethers.ZeroHash);
        continue;
      }

      let lo = 0,
        hi = simList.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (Buffer.compare(simKeys[mid], key) <= 0) lo = mid + 1;
        else hi = mid;
      }
      const pos = lo;

      leftHints.push(pos === 0 ? ethers.ZeroHash : simList[pos - 1]);
      rightHints.push(pos === simList.length ? ethers.ZeroHash : simList[pos]);
      simList.splice(pos, 0, uid);
      simKeys.splice(pos, 0, key);
    }

    return { leftHints, rightHints };
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

  /** Decode DATA attestation → {uri, contentType, fileMode} */
  const decodeData = (raw: string): { uri: string; contentType: string; fileMode: string } => {
    const [uri, contentType, fileMode] = encode.decode(["string", "string", "string"], raw) as unknown as [
      string,
      string,
      string,
    ];
    return { uri, contentType, fileMode };
  };

  /** Resolve DATA for an anchor from an ordered address list, return {uid, uri} or null */
  const resolveEdition = async (
    anchorUID: string,
    addressList: string[],
    showRevoked = false,
  ): Promise<{ uid: string; uri: string } | null> => {
    const uid = await indexer.getDataByAddressList(anchorUID, addressList, showRevoked);
    if (uid === ethers.ZeroHash) return null;
    const att = await eas.getAttestation(uid);
    return { uid, ...decodeData(att.data) };
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
  // Verify that a second computeHints call (for hypothetical new items) uses the populated list.
  // Just check it returns arrays of the right length.
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

  const aliceFinalNames = finalNames; // alias for later use

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
  assert("Pagination order matches direct read", pagedNames.join(",") === aliceFinalNames.join(","));

  // ════════════════════════════════════════════════════════════════════════════════
  // PHASE 7: DATA editions — attach content to anchors
  // ════════════════════════════════════════════════════════════════════════════════
  console.log("\n── Phase 7: DATA editions ──\n");

  // Alice uploads her editions for all 6 of her anchors
  const aliceAppleData = await data(alice, aliceApple, "ipfs://alice-apple-v1");
  await data(alice, aliceBanana, "ipfs://alice-banana-v1");
  await data(alice, aliceMango, "ipfs://alice-mango-v1");
  const aliceZebraData = await data(alice, aliceZebra, "ipfs://alice-zebra-v1");
  await data(alice, aliceCarrot, "ipfs://alice-carrot-v1");
  await data(alice, aliceAardvark, "ipfs://alice-aardvark-v1");
  console.log("  Alice uploaded editions for all 6 anchors");

  // Bob uploads editions for 3 of Alice's anchors (covering, remixing)
  await data(bob, aliceApple, "ipfs://bob-apple-v1");
  await data(bob, aliceBanana, "ipfs://bob-banana-v1");
  const bobZebraData = await data(bob, aliceZebra, "ipfs://bob-zebra-v1");
  console.log("  Bob uploaded editions for apple.mp3, banana.mp3, zebra.mp3");

  // Alice-only lookup
  const appleAlice = await resolveEdition(aliceApple, [aliceAddr]);
  assert("apple.mp3 [alice] → alice's uri", appleAlice?.uri === "ipfs://alice-apple-v1", appleAlice?.uri);

  // Bob-only lookup
  const appleBob = await resolveEdition(aliceApple, [bobAddr]);
  assert("apple.mp3 [bob] → bob's uri", appleBob?.uri === "ipfs://bob-apple-v1", appleBob?.uri);

  // Priority: Bob first
  const appleBobFirst = await resolveEdition(aliceApple, [bobAddr, aliceAddr]);
  assert("apple.mp3 [bob,alice] → bob wins", appleBobFirst?.uri === "ipfs://bob-apple-v1", appleBobFirst?.uri);

  // Priority: Alice first
  const appleAliceFirst = await resolveEdition(aliceApple, [aliceAddr, bobAddr]);
  assert("apple.mp3 [alice,bob] → alice wins", appleAliceFirst?.uri === "ipfs://alice-apple-v1", appleAliceFirst?.uri);

  // Anchor with no edition from Bob
  const carrotBob = await resolveEdition(aliceCarrot, [bobAddr]);
  assert("carrot.mp3 [bob only] → null (no edition)", carrotBob === null);

  // ════════════════════════════════════════════════════════════════════════════════
  // PHASE 8: Edition revoke + fallback
  // ════════════════════════════════════════════════════════════════════════════════
  console.log("\n── Phase 8: Edition revoke + fallback ──\n");

  // Alice revokes her zebra edition
  await revokeData(alice, aliceZebraData);

  // Bob's edition should now win
  const zebraAfterRevoke = await resolveEdition(aliceZebra, [aliceAddr, bobAddr]);
  assert(
    "zebra.mp3 [alice,bob]: falls back to bob after alice revoke",
    zebraAfterRevoke?.uri === "ipfs://bob-zebra-v1",
    zebraAfterRevoke?.uri,
  );

  // showRevoked=true still returns Alice's revoked edition (she's first)
  const zebraShowRevoked = await resolveEdition(aliceZebra, [aliceAddr, bobAddr], true);
  assert(
    "zebra.mp3 showRevoked=true → alice's revoked edition",
    zebraShowRevoked?.uri === "ipfs://alice-zebra-v1",
    zebraShowRevoked?.uri,
  );

  // If both Alice's and Bob's are revoked → null
  await revokeData(bob, bobZebraData);
  const zebraAllRevoked = await resolveEdition(aliceZebra, [aliceAddr, bobAddr]);
  assert("zebra.mp3: all editions revoked → null", zebraAllRevoked === null);

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

  // aardvark and carrot only have Alice's editions; apple and banana have both; zebra is all-revoked; mango only alice
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
  assert("zebra.mp3 → null (both editions revoked)", resolved.find(r => r.name === "zebra.mp3")?.uri === null);

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
  // Alice-only: 6 anchors alice created (zebra, banana, mango, apple, carrot, aardvark)
  const [aliceOnly] = await indexer.getChildrenByAddressList(musicUID, [aliceAddr], 0n, 50, false, false);
  assert("Alice-only dedup = 6 unique anchors", aliceOnly.length === 6, `got ${aliceOnly.length}`);

  // Bob-only: 3 he created + 3 he added DATA to (apple, banana, zebra) = 6
  const [bobOnly] = await indexer.getChildrenByAddressList(musicUID, [bobAddr], 0n, 50, false, false);
  assert("Bob-only dedup = 6 unique anchors (3 created + 3 with DATA)", bobOnly.length === 6, `got ${bobOnly.length}`);

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
  // PHASE 11: Data history — multiple versions per user
  // ════════════════════════════════════════════════════════════════════════════════
  console.log("\n── Phase 11: Data history (multiple editions per user) ──\n");

  // Alice uploads a v2 of apple.mp3
  await data(alice, aliceApple, "ipfs://alice-apple-v2");
  console.log("  Alice uploaded apple.mp3 v2");

  // Full history (showRevoked=true) → 2 entries
  const [histAll] = await indexer.getDataHistoryByAddress(aliceApple, aliceAddr, 0, 10, false, true);
  assert("Alice apple.mp3 full history = 2 versions", histAll.length === 2, `got ${histAll.length}`);

  // Active-only (showRevoked=false) → 2 entries (v1 not revoked, v2 added)
  const [histActive] = await indexer.getDataHistoryByAddress(aliceApple, aliceAddr, 0, 10, false, false);
  assert("Alice apple.mp3 active history = 2 (neither revoked)", histActive.length === 2, `got ${histActive.length}`);

  // getDataByAddressList returns most recent (v2)
  const appleLatest = await resolveEdition(aliceApple, [aliceAddr]);
  assert(
    "getDataByAddressList returns latest version (v2)",
    appleLatest?.uri === "ipfs://alice-apple-v2",
    appleLatest?.uri,
  );

  // Revoke v1 — active history drops to 1
  await revokeData(alice, aliceAppleData);
  const [histAfterRevoke] = await indexer.getDataHistoryByAddress(aliceApple, aliceAddr, 0, 10, false, false);
  assert("Active history = 1 after revoking v1", histAfterRevoke.length === 1, `got ${histAfterRevoke.length}`);

  // Latest is still v2
  const appleAfterRevokeV1 = await resolveEdition(aliceApple, [aliceAddr]);
  assert(
    "After revoking v1, v2 still served",
    appleAfterRevokeV1?.uri === "ipfs://alice-apple-v2",
    appleAfterRevokeV1?.uri,
  );

  // Reverse order: most recent first
  const [histReverse] = await indexer.getDataHistoryByAddress(aliceApple, aliceAddr, 0, 10, true, true);
  const attV2 = await eas.getAttestation(histReverse[0]);
  const { uri: uriReverse } = decodeData(attV2.data);
  assert("Reverse history[0] = v2 (most recent)", uriReverse === "ipfs://alice-apple-v2", uriReverse);

  // Count
  const appleHistCount = await indexer.getDataHistoryCountByAddress(aliceApple, aliceAddr);
  assert("getDataHistoryCountByAddress = 2", appleHistCount === 2n, `got ${appleHistCount}`);

  // ════════════════════════════════════════════════════════════════════════════════
  // PHASE 12: Tags on list items
  // ════════════════════════════════════════════════════════════════════════════════
  console.log("\n── Phase 12: Tags on list items ──\n");

  // Create tag definition anchors (the "Type as Topic" pattern — a definition is just an anchor)
  const favoriteDefUID = await anchor(deployer, `favorite_${S}`, rootUID);
  const classicDefUID = await anchor(deployer, `classic_${S}`, rootUID);
  console.log("  Tag definitions: favorite, classic");

  // Alice tags apple.mp3 and banana.mp3 as "favorite"
  await tag(alice, aliceApple, favoriteDefUID);
  await tag(alice, aliceBanana, favoriteDefUID);

  // Bob tags apple.mp3 as "favorite" and mango.mp3 as "classic"
  await tag(bob, aliceApple, favoriteDefUID);
  await tag(bob, aliceMango, classicDefUID);
  console.log("  Alice: favorite(apple, banana); Bob: favorite(apple), classic(mango)");

  // isActivelyTagged: O(1) counter
  assert("apple.mp3 is actively tagged as favorite", await tagResolver.isActivelyTagged(aliceApple, favoriteDefUID));
  assert("banana.mp3 is actively tagged as favorite", await tagResolver.isActivelyTagged(aliceBanana, favoriteDefUID));
  assert("mango.mp3 is actively tagged as classic", await tagResolver.isActivelyTagged(aliceMango, classicDefUID));
  assert("carrot.mp3 is NOT tagged as favorite", !(await tagResolver.isActivelyTagged(aliceCarrot, favoriteDefUID)));

  // getActiveTagUID: specific attester's active tag
  const aliceAppleTagUID = await tagResolver.getActiveTagUID(aliceAddr, aliceApple, favoriteDefUID);
  assert("Alice has an active tag UID on apple.mp3", aliceAppleTagUID !== ethers.ZeroHash);

  // getTagDefinitions: what definitions have ever been applied to apple.mp3
  const appleDefs = await tagResolver.getTagDefinitions(aliceApple, 0, 10);
  assert("apple.mp3 has 1 tag definition (favorite)", appleDefs.length === 1 && appleDefs[0] === favoriteDefUID);

  // getTaggedTargets: what items have been tagged with "favorite"
  const favoriteTargets = await tagResolver.getTaggedTargets(favoriteDefUID, 0, 10);
  assert("2 items tagged as favorite (apple, banana)", favoriteTargets.length === 2, `got ${favoriteTargets.length}`);

  // Negate a tag: Alice un-favorites banana
  await tag(alice, aliceBanana, favoriteDefUID, false);
  assert(
    "banana.mp3: active count drops after Alice negates tag",
    !(await tagResolver.isActivelyTagged(aliceBanana, favoriteDefUID)),
  );
  // apple.mp3 still active (2 users → 1 after negation of banana, apple still has 2)
  assert("apple.mp3 still actively tagged as favorite", await tagResolver.isActivelyTagged(aliceApple, favoriteDefUID));

  // ════════════════════════════════════════════════════════════════════════════════
  // PHASE 13: Discover available sorts via getAnchorsBySchema
  // ════════════════════════════════════════════════════════════════════════════════
  console.log("\n── Phase 13: Sort discovery ──\n");

  // The UI discovers available sorts for a directory in two steps:
  //
  // Step 1 (on-chain): getAnchorsBySchema finds naming anchors with anchorSchema == SORT_INFO_SCHEMA_UID.
  //   These are regular ANCHOR attestations indexed by EFSIndexer.
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

  // Step 2 (fully on-chain): EFSSortOverlay.onAttest calls indexer.index(uid), so SORT_INFO
  //   attestations are registered into EFSIndexer's generic referencing indices. No eth_getLogs needed.
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

  // The SORT_INFO UID is now discoverable purely on-chain:
  const discoveredConfig = await overlay.getSortConfig(alphaInfoUID);
  assert("getSortConfig returns valid config for known sortInfoUID", await overlay.isSortRegistered(alphaInfoUID));
  assert(
    "Discovered sortFunc is NameSort",
    discoveredConfig.sortFunc.toLowerCase() === ((nameSortContract as any).target as string).toLowerCase(),
  );

  const namingAnchorName = await getName(alphaNameUID);
  assert("Naming anchor name = alphabetical", namingAnchorName === "alphabetical");

  // Once we have the sortInfoUID, all overlay reads are on-chain (shared list, keyed by parentAnchor):
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

  // Fetch all 3 video anchors from the global kernel
  const vidItems: string[] = [];
  for (let i = 0; i < 3; i++) {
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

  // Alice also uploads DATA to her videos — timestamps affect sort, not content
  await data(alice, vid1, "ipfs://alice-first-mp4", "video/mp4");
  await data(alice, vid2, "ipfs://alice-second-mp4", "video/mp4");
  await data(alice, vid3, "ipfs://alice-third-mp4", "video/mp4");

  const vid1Edition = await resolveEdition(vid1, [aliceAddr]);
  assert("vid1 edition resolves correctly", vid1Edition?.uri === "ipfs://alice-first-mp4", vid1Edition?.uri);

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
  const aliceAfterRevoke = await readSortedAll(alphaInfoUID, musicUID);
  assert(
    "Sorted data still readable after sort revoke",
    aliceAfterRevoke.length === 6,
    `got ${aliceAfterRevoke.length}`,
  );

  // Editions still resolve correctly after sort is revoked (sort ≠ content)
  const appleEditionAfterSortRevoke = await resolveEdition(aliceApple, [aliceAddr]);
  assert(
    "Edition resolution unaffected by sort revoke",
    appleEditionAfterSortRevoke?.uri === "ipfs://alice-apple-v2",
    appleEditionAfterSortRevoke?.uri,
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
