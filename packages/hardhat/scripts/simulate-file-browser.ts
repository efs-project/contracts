import { ethers } from "hardhat";
import { EFSIndexer, TagResolver } from "../typechain-types";

/**
 * EFS File Browser Simulation
 *
 * Exercises the full file browser workflow against a deployed EFSIndexer.
 * Run: npx hardhat run scripts/simulate-file-browser.ts --network localhost
 *
 * All anchor names use a session timestamp suffix so the script is re-runnable
 * against persistent chain state without DuplicateFileName collisions.
 */
async function main() {
  const PASS = "✅ PASS";
  const FAIL = "❌ FAIL";
  let passed = 0;
  let failed = 0;
  const assert = (label: string, condition: boolean, detail: string = "") => {
    if (condition) {
      console.log(`  ${PASS} ${label}${detail ? ` — ${detail}` : ""}`);
      passed++;
    } else {
      console.log(`  ${FAIL} ${label}${detail ? ` — ${detail}` : ""}`);
      failed++;
    }
  };

  console.log("════════════════════════════════════════");
  console.log("  EFS File Browser Simulation");
  console.log("════════════════════════════════════════\n");

  const [deployer, user1, user2] = await ethers.getSigners();
  const owner = deployer;

  const ownerAddr = await owner.getAddress();
  const u1Addr = await user1.getAddress();
  const u2Addr = await user2.getAddress();

  // Connect to deployed contracts
  const indexer = (await ethers.getContract("Indexer", owner)) as unknown as EFSIndexer;
  const easAddress = await indexer.getEAS();
  const eas = await ethers.getContractAt(
    "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol:IEAS",
    easAddress,
  );

  // All schema UIDs and partner contract addresses are available on EFSIndexer
  const anchorSchemaUID = await indexer.ANCHOR_SCHEMA_UID();
  const dataSchemaUID = await indexer.DATA_SCHEMA_UID();
  const tagSchemaUID = await indexer.TAG_SCHEMA_UID();
  const tagResolverAddr = await indexer.tagResolver();
  const tagResolver = (await ethers.getContractAt("TagResolver", tagResolverAddr)) as unknown as TagResolver;
  const rootUID = await indexer.rootAnchorUID();

  console.log(`Indexer: ${indexer.target}`);
  console.log(`EAS:     ${eas.target}`);
  console.log(`Root:    ${rootUID}\n`);

  // Session ID for unique names (re-runnable)
  const S = Date.now().toString(36);

  // ── Helpers ──────────────────────────────────────────────────

  const getUID = async (tx: any) => {
    const receipt = await tx.wait();
    for (const log of receipt.logs) {
      try {
        const parsed = eas.interface.parseLog(log);
        if (parsed?.name === "Attested") return parsed.args.uid;
      } catch {}
    }
    throw new Error("Attested event not found in receipt");
  };

  const encode = ethers.AbiCoder.defaultAbiCoder();

  const anchor = async (signer: any, name: string, parent: string, schema = ethers.ZeroHash) => {
    const tx = await eas.connect(signer).attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ethers.ZeroAddress,
        expirationTime: 0n,
        revocable: false,
        refUID: parent,
        data: encode.encode(["string", "bytes32"], [name, schema]),
        value: 0n,
      },
    });
    return getUID(tx);
  };

  const data = async (signer: any, anchorUID: string, uri: string, mime: string, mode = "file") => {
    const tx = await eas.connect(signer).attest({
      schema: dataSchemaUID,
      data: {
        recipient: ethers.ZeroAddress,
        expirationTime: 0n,
        revocable: true,
        refUID: anchorUID,
        data: encode.encode(["string", "string", "string"], [uri, mime, mode]),
        value: 0n,
      },
    });
    return getUID(tx);
  };

  const tag = async (signer: any, targetUID: string, definition: string, applies: boolean) => {
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

  const decodeData = (raw: string) => encode.decode(["string", "string", "string"], raw) as [string, string, string];

  // ══════════════════════════════════════════════════════════════
  // PHASE 1: Build realistic file tree
  // ══════════════════════════════════════════════════════════════
  console.log("── Phase 1: Building File Tree ──\n");

  // /pets/
  const petsUID = await anchor(owner, `pets_${S}`, rootUID);
  console.log(`  /pets_${S}/  created`);

  // /pets/best.jpg — 3 editions (owner, user1, user2)
  const bestUID = await anchor(owner, "best.jpg", petsUID, dataSchemaUID);
  const bestOwnerData = await data(owner, bestUID, "ipfs://owner-best", "image/jpeg");
  const bestU1Data = await data(user1, bestUID, "ipfs://user1-best", "image/jpeg");
  const bestU2Data = await data(user2, bestUID, "ipfs://user2-best", "image/jpeg");
  console.log(`  /pets/best.jpg  3 editions`);

  // /pets/cats/
  const catsUID = await anchor(owner, "cats", petsUID);
  const fluffyUID = await anchor(user1, "fluffy.png", catsUID, dataSchemaUID);
  await data(user1, fluffyUID, "ipfs://fluffy", "image/png");
  const garfieldUID = await anchor(user2, "garfield.gif", catsUID, dataSchemaUID);
  await data(user2, garfieldUID, "ipfs://garfield", "image/gif");
  console.log(`  /pets/cats/  2 files`);

  // /pets/dogs/
  const dogsUID = await anchor(owner, "dogs", petsUID);
  const rexUID = await anchor(owner, "rex.jpg", dogsUID, dataSchemaUID);
  await data(owner, rexUID, "ipfs://rex", "image/jpeg");
  console.log(`  /pets/dogs/  1 file`);

  // /memes/
  const memesUID = await anchor(owner, `memes_${S}`, rootUID);
  const vitalikUID = await anchor(owner, "vitalik.jpg", memesUID, dataSchemaUID);
  await data(owner, vitalikUID, "ipfs://owner-vitalik", "image/jpeg");
  await data(user1, vitalikUID, "ipfs://user1-vitalik", "image/jpeg");
  console.log(`  /memes_${S}/vitalik.jpg  2 editions`);

  console.log("\n  Tree built successfully.\n");

  // ══════════════════════════════════════════════════════════════
  // PHASE 2: Simulate Browser Operations
  // ══════════════════════════════════════════════════════════════
  console.log("── Phase 2: Browser Operations ──\n");

  // ── Test 1: Path Resolution ──
  console.log("[1] Path Resolution");
  const resolvedPets = await indexer.resolvePath(rootUID, `pets_${S}`);
  assert("resolvePath(/pets/)", resolvedPets === petsUID);

  const resolvedCats = await indexer.resolvePath(petsUID, "cats");
  assert("resolvePath(/pets/cats/)", resolvedCats === catsUID);

  const resolvedNothing = await indexer.resolvePath(rootUID, "nonexistent_dir_xyz");
  assert("resolvePath(nonexistent) returns zero", resolvedNothing === ethers.ZeroHash);

  // ── Test 2: List Children (global) ──
  console.log("\n[2] Children Listing");
  const petsChildren = await indexer["getChildren(bytes32,uint256,uint256,bool)"](petsUID, 0n, 10, false);
  assert(
    "getChildren(/pets/) returns 3 (best.jpg, cats, dogs)",
    petsChildren.length === 3,
    `got ${petsChildren.length}`,
  );

  const petsCount = await indexer.getChildrenCount(petsUID);
  assert("getChildrenCount matches", petsCount === 3n);

  // ── Test 3: Edition Directory Listing (getChildrenByAddressList — dedup) ──
  console.log("\n[3] Edition Directory Listing");
  // /pets/ has: best.jpg (owner, user1, user2 all have DATA), cats/ (owner), dogs/ (owner)
  // All 3 unique anchors qualify for [u1, u2, owner]. Should return exactly 3 with no duplicates.
  const [editionList] = await indexer.getChildrenByAddressList(
    petsUID,
    [u1Addr, u2Addr, ownerAddr],
    0n,
    10,
    false,
    false,
  );
  assert(
    "getChildrenByAddressList returns 3 unique items (best.jpg, cats, dogs)",
    editionList.length === 3,
    `got ${editionList.length} items`,
  );
  // First item = first in global insertion order (best.jpg was created first)
  assert("First item is best.jpg (insertion order)", editionList[0] === bestUID);

  // ── Test 4: Open File (getDataByAddressList) ──
  console.log("\n[4] Open File — Edition Fallback");
  const openResult = await indexer.getDataByAddressList(bestUID, [u1Addr, u2Addr, ownerAddr], false);
  const openAtt = await eas.getAttestation(openResult);
  const [openUri] = decodeData(openAtt.data);
  assert("Prefers User1 (first in list)", openUri === "ipfs://user1-best", `got: ${openUri}`);

  // Flip order: prefer User2
  const openResult2 = await indexer.getDataByAddressList(bestUID, [u2Addr, u1Addr, ownerAddr], false);
  const [openUri2] = decodeData((await eas.getAttestation(openResult2)).data);
  assert("Prefers User2 when listed first", openUri2 === "ipfs://user2-best", `got: ${openUri2}`);

  // Gas cost for the lookup
  const gasEstimate = await indexer.getDataByAddressList.estimateGas(bestUID, [u1Addr, u2Addr, ownerAddr], false);
  console.log(`  ℹ️  Gas estimate for getDataByAddressList: ${gasEstimate}`);

  // ── Test 5: Subdirectory Navigation ──
  console.log("\n[5] Subdirectory Navigation");
  const catsChildren = await indexer["getChildren(bytes32,uint256,uint256,bool)"](catsUID, 0, 10, false);
  assert("/pets/cats/ has 2 files", catsChildren.length === 2);

  const dogsChildren = await indexer["getChildren(bytes32,uint256,uint256,bool)"](dogsUID, 0, 10, false);
  assert("/pets/dogs/ has 1 file", dogsChildren.length === 1);

  // ── Test 6: Filter by MIME Type ──
  console.log("\n[6] MIME Type Filtering");
  const imagesInPets = await indexer["getChildrenByType(bytes32,string,uint256,uint256,bool)"](petsUID, "image", 0, 10, false);
  assert("image/* in /pets/", imagesInPets.length > 0, `found ${imagesInPets.length}`);

  const jpegInPets = await indexer["getChildrenByType(bytes32,string,uint256,uint256,bool)"](petsUID, "image/jpeg", 0, 10, false);
  assert("image/jpeg in /pets/", jpegInPets.length > 0, `found ${jpegInPets.length}`);

  // ── Test 7: Revoke + Fallback ──
  console.log("\n[7] Revoke and Fallback");
  await eas.connect(user1).revoke({ schema: dataSchemaUID, data: { uid: bestU1Data, value: 0n } });

  const afterRevoke = await indexer.getDataByAddressList(bestUID, [u1Addr, u2Addr, ownerAddr], false);
  const [revokedUri] = decodeData((await eas.getAttestation(afterRevoke)).data);
  assert("Falls back to User2 after User1 revoked", revokedUri === "ipfs://user2-best", `got: ${revokedUri}`);

  // showRevoked=true should still return User1
  const showRevokedResult = await indexer.getDataByAddressList(bestUID, [u1Addr, u2Addr, ownerAddr], true);
  const [showRevokedUri] = decodeData((await eas.getAttestation(showRevokedResult)).data);
  assert("showRevoked=true returns User1", showRevokedUri === "ipfs://user1-best", `got: ${showRevokedUri}`);

  // All-revoked returns zero
  await eas.connect(user2).revoke({ schema: dataSchemaUID, data: { uid: bestU2Data, value: 0n } });
  await eas.connect(owner).revoke({ schema: dataSchemaUID, data: { uid: bestOwnerData, value: 0n } });
  const allRevokedResult = await indexer.getDataByAddressList(bestUID, [u1Addr, u2Addr, ownerAddr], false);
  assert("All revoked → returns bytes32(0)", allRevokedResult === ethers.ZeroHash);

  // ── Test 8: Data History (getDataHistoryByAddress) ──
  console.log("\n[8] Data History");
  const [histAll] = await indexer.getDataHistoryByAddress(bestUID, u1Addr, 0, 10, false, true);
  assert("User1 full history = 1 entry", histAll.length === 1, `got ${histAll.length}`);

  const [histActive] = await indexer.getDataHistoryByAddress(bestUID, u1Addr, 0, 10, false, false);
  assert("User1 active history = 0 (revoked)", histActive.length === 0, `got ${histActive.length}`);

  const u1HistCount = await indexer.getDataHistoryCountByAddress(bestUID, u1Addr);
  assert("getDataHistoryCountByAddress = 1", u1HistCount === 1n);

  // ── Test 9: getChildrenByAddressList — dedup pagination ──
  console.log("\n[9] Dedup Pagination (30 files × 3 users, getChildrenByAddressList)");
  const spamParent = await anchor(owner, `spam_${S}`, rootUID);
  const signers = [owner, user1, user2];
  for (let i = 0; i < 30; i++) {
    await anchor(signers[i % 3], `f${i}.txt`, spamParent, dataSchemaUID);
  }

  let cursor = 0n;
  const allResults: string[] = [];
  let pages = 0;
  do {
    const [pageRes, nextCursor] = await indexer.getChildrenByAddressList(
      spamParent,
      [ownerAddr, u1Addr, u2Addr],
      cursor,
      5,
      false,
      false,
    );
    allResults.push(...pageRes);
    cursor = nextCursor;
    pages++;
  } while (cursor > 0n);

  assert(`Collected all 30 files across ${pages} pages`, allResults.length === 30, `got ${allResults.length}`);
  const uniqueUIDs = new Set(allResults);
  assert(
    "Guaranteed no duplicates (dedup version)",
    uniqueUIDs.size === allResults.length,
    `${uniqueUIDs.size} unique / ${allResults.length} total`,
  );

  // ── Test 10: Reverse order (dedup) ──
  console.log("\n[10] Reverse Order");
  const [fwd] = await indexer.getChildrenByAddressList(spamParent, [ownerAddr, u1Addr, u2Addr], 0n, 5, false, false);
  const [rev] = await indexer.getChildrenByAddressList(spamParent, [ownerAddr, u1Addr, u2Addr], 0n, 5, true, false);
  assert(
    "Forward ≠ Reverse first element",
    fwd[0] !== rev[0],
    `fwd[0]=${fwd[0].slice(0, 10)}… rev[0]=${rev[0].slice(0, 10)}…`,
  );

  // ── Test 11: getChildrenByAddressListInterleaved — round-robin fair distribution ──
  console.log("\n[11] Interleaved Round-Robin (getChildrenByAddressListInterleaved)");
  const unequalParent = await anchor(owner, `unequal_${S}`, rootUID);
  const bigUserFiles: string[] = [];
  for (let i = 0; i < 8; i++) {
    bigUserFiles.push(await anchor(user1, `big${i}`, unequalParent));
  }
  const smallUserFile = await anchor(user2, `small0`, unequalParent);

  // Round-robin: user1[0], user2[0], user1[1], user1[2], ... (user2 exhausted after small0)
  const [uneqPage1, uneqCursor1] = await indexer.getChildrenByAddressListInterleaved(
    unequalParent,
    [u1Addr, u2Addr],
    0n,
    5,
    false,
    false,
  );
  assert("Interleaved page 1: 5 items", uneqPage1.length === 5, `got ${uneqPage1.length}`);
  assert("Interleaved: item 0 = User1's first (round-robin start)", uneqPage1[0] === bigUserFiles[0]);
  assert("Interleaved: item 1 = User2's only file (fair distribution)", uneqPage1[1] === smallUserFile);

  const [uneqPage2, _uneqCursor2] = await indexer.getChildrenByAddressListInterleaved(
    unequalParent,
    [u1Addr, u2Addr],
    uneqCursor1,
    10,
    false,
    false,
  );
  assert("Interleaved page 2: remaining 4 items", uneqPage2.length === 4, `got ${uneqPage2.length}`);
  assert(
    "Interleaved: all 9 items across both pages",
    uneqPage1.length + uneqPage2.length === 9,
    `${uneqPage1.length} + ${uneqPage2.length}`,
  );

  // ── Test 12: Tagging ──
  console.log("\n[12] Tagging");
  // Tag definitions live as Anchors under /tags/ — for simplicity, create one under root
  const funnyDef = await anchor(owner, `funny_${S}`, rootUID);

  // User1 applies tag (applies=true), user2 negates it (applies=false)
  const tagUID1 = await tag(user1, vitalikUID, funnyDef, true);
  const tagUID2 = await tag(user2, vitalikUID, funnyDef, false);

  // isActivelyTagged checks if any attester has applied this tag with applies=true
  const activeUID1 = await tagResolver.getActiveTagUID(u1Addr, vitalikUID, funnyDef);
  assert("User1's active tag UID matches", activeUID1 === tagUID1, `got ${activeUID1}`);

  const activeUID2 = await tagResolver.getActiveTagUID(u2Addr, vitalikUID, funnyDef);
  assert("User2's active tag UID matches (negation)", activeUID2 === tagUID2, `got ${activeUID2}`);

  // isActivelyTagged checks if ANYONE has tagged this target with this definition (applies=true)
  const tagged = await tagResolver.isActivelyTagged(vitalikUID, funnyDef);
  assert("isActivelyTagged true (user1 applied it)", tagged === true, `got ${tagged}`);

  // ── Test 13: Deep Nesting (> 5 levels) ──
  console.log("\n[13] Deep Navigational Nesting");
  const l1 = await anchor(owner, `l1_${S}`, rootUID);
  const l2 = await anchor(owner, `l2`, l1);
  const l3 = await anchor(owner, `l3`, l2);
  const l4 = await anchor(owner, `l4`, l3);
  const l5 = await anchor(owner, `l5`, l4);
  const l6 = await anchor(owner, `l6`, l5, dataSchemaUID);

  const deepRes1 = await indexer.resolvePath(rootUID, `l1_${S}`);
  const deepRes2 = await indexer.resolvePath(deepRes1, `l2`);
  const deepRes3 = await indexer.resolvePath(deepRes2, `l3`);
  const deepRes4 = await indexer.resolvePath(deepRes3, `l4`);
  const deepRes5 = await indexer.resolvePath(deepRes4, `l5`);
  // l6 was created with dataSchemaUID → resolvePath (which defaults to ZERO_BYTES32 schema) won't match it.
  // Use resolveAnchor with the explicit schema UID.
  const deepRes6 = await indexer.resolveAnchor(deepRes5, `l6`, dataSchemaUID);

  assert("Layer 1 resolved", deepRes1 === l1);
  assert("Layer 2 resolved", deepRes2 === l2);
  assert("Layer 3 resolved", deepRes3 === l3);
  assert("Layer 4 resolved", deepRes4 === l4);
  assert("Layer 5 resolved", deepRes5 === l5);
  assert("Layer 6 resolved", deepRes6 === l6);

  // Attach data to L6
  await data(owner, l6, "ipfs://deep-layer-6", "text/plain");
  const deepData = await indexer.getDataByAddressList(l6, [ownerAddr], false);
  const [deepUri] = decodeData((await eas.getAttestation(deepData)).data);
  assert("Data resolves at Layer 6", deepUri === "ipfs://deep-layer-6", `got: ${deepUri}`);
  console.log("\n════════════════════════════════════════");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log("════════════════════════════════════════\n");

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
