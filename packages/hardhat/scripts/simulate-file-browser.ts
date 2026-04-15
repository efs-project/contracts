import { ethers } from "hardhat";
import { EFSIndexer, TagResolver } from "../typechain-types";

/**
 * EFS File Browser Simulation
 *
 * Exercises the full file browser workflow against a deployed EFS stack,
 * using the three-layer data model: paths (Anchors) → data (DATA) → retrieval (MIRRORs).
 *
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
  console.log("  Paths · DATA · MIRRORs · TAGs");
  console.log("════════════════════════════════════════\n");

  const [deployer, user1, user2] = await ethers.getSigners();
  const owner = deployer;

  const ownerAddr = await owner.getAddress();
  const u1Addr = await user1.getAddress();
  const u2Addr = await user2.getAddress();

  // Connect to deployed contracts
  const indexer = (await ethers.getContract("Indexer", owner)) as unknown as EFSIndexer;
  const easAddress = await indexer.getEAS();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const eas = (await ethers.getContractAt(
    "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol:IEAS",
    easAddress,
  )) as any;

  // All schema UIDs and partner contract addresses are available on EFSIndexer
  const anchorSchemaUID = await indexer.ANCHOR_SCHEMA_UID();
  const dataSchemaUID = await indexer.DATA_SCHEMA_UID();
  const propertySchemaUID = await indexer.PROPERTY_SCHEMA_UID();
  const mirrorSchemaUID = await indexer.MIRROR_SCHEMA_UID();
  const tagSchemaUID = await indexer.TAG_SCHEMA_UID();
  const tagResolverAddr = await indexer.tagResolver();
  const tagResolver = (await ethers.getContractAt("TagResolver", tagResolverAddr)) as unknown as TagResolver;
  const rootUID = await indexer.rootAnchorUID();

  console.log(`Indexer: ${indexer.target}`);
  console.log(`EAS:     ${eas.target}`);
  console.log(`Root:    ${rootUID}\n`);

  // Resolve /transports/ anchors for MIRRORs
  const transportsUID = await indexer.resolvePath(rootUID, "transports");
  const ipfsTransportUID = await indexer.resolvePath(transportsUID, "ipfs");
  const onchainTransportUID = await indexer.resolvePath(transportsUID, "onchain");
  console.log(`/transports/ipfs:    ${ipfsTransportUID}`);
  console.log(`/transports/onchain: ${onchainTransportUID}\n`);

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

  /** Create an Anchor attestation */
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

  /** Create a standalone DATA attestation (new model: contentHash + size, non-revocable) */
  const createData = async (signer: any, content: string) => {
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

  /** Create a PROPERTY attestation on a DATA or Anchor */
  const property = async (signer: any, targetUID: string, key: string, value: string) => {
    const tx = await eas.connect(signer).attest({
      schema: propertySchemaUID,
      data: {
        recipient: ethers.ZeroAddress,
        expirationTime: 0n,
        revocable: true,
        refUID: targetUID,
        data: encode.encode(["string", "string"], [key, value]),
        value: 0n,
      },
    });
    return getUID(tx);
  };

  /** Create a MIRROR attestation on a DATA */
  const mirror = async (signer: any, dataUID: string, transportDef: string, uri: string) => {
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

  /** Create a TAG attestation (file placement or labeling) */
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

  // ══════════════════════════════════════════════════════════════
  // PHASE 1: Build realistic file tree using three-layer model
  // ══════════════════════════════════════════════════════════════
  console.log("── Phase 1: Building File Tree ──\n");

  // /pets/
  const petsUID = await anchor(owner, `pets_${S}`, rootUID);
  console.log(`  /pets_${S}/  created`);

  // /pets/best.jpg — 3 editions via TAG-based placement
  const bestUID = await anchor(owner, "best.jpg", petsUID, dataSchemaUID);

  // Owner's edition: DATA + PROPERTY(contentType) + MIRROR + TAG
  const ownerBestData = await createData(owner, "owner-best-jpeg-bytes");
  await property(owner, ownerBestData.uid, "contentType", "image/jpeg");
  await mirror(owner, ownerBestData.uid, ipfsTransportUID, "ipfs://owner-best");
  await tag(owner, ownerBestData.uid, bestUID, true);

  // User1's edition
  const u1BestData = await createData(user1, "user1-best-jpeg-bytes");
  await property(user1, u1BestData.uid, "contentType", "image/jpeg");
  await mirror(user1, u1BestData.uid, ipfsTransportUID, "ipfs://user1-best");
  await tag(user1, u1BestData.uid, bestUID, true);

  // User2's edition
  const u2BestData = await createData(user2, "user2-best-jpeg-bytes");
  await property(user2, u2BestData.uid, "contentType", "image/jpeg");
  await mirror(user2, u2BestData.uid, ipfsTransportUID, "ipfs://user2-best");
  await tag(user2, u2BestData.uid, bestUID, true);

  console.log(`  /pets/best.jpg  3 editions (TAG-placed)`);

  // /pets/cats/
  const catsUID = await anchor(owner, "cats", petsUID);
  const fluffyUID = await anchor(user1, "fluffy.png", catsUID, dataSchemaUID);
  const fluffyData = await createData(user1, "fluffy-png-bytes");
  await property(user1, fluffyData.uid, "contentType", "image/png");
  await mirror(user1, fluffyData.uid, ipfsTransportUID, "ipfs://fluffy");
  await tag(user1, fluffyData.uid, fluffyUID, true);

  const garfieldUID = await anchor(user2, "garfield.gif", catsUID, dataSchemaUID);
  const garfieldData = await createData(user2, "garfield-gif-bytes");
  await property(user2, garfieldData.uid, "contentType", "image/gif");
  await mirror(user2, garfieldData.uid, ipfsTransportUID, "ipfs://garfield");
  await tag(user2, garfieldData.uid, garfieldUID, true);
  console.log(`  /pets/cats/  2 files`);

  // /pets/dogs/
  const dogsUID = await anchor(owner, "dogs", petsUID);
  const rexUID = await anchor(owner, "rex.jpg", dogsUID, dataSchemaUID);
  const rexData = await createData(owner, "rex-jpeg-bytes");
  await property(owner, rexData.uid, "contentType", "image/jpeg");
  await mirror(owner, rexData.uid, ipfsTransportUID, "ipfs://rex");
  await tag(owner, rexData.uid, rexUID, true);
  console.log(`  /pets/dogs/  1 file`);

  // /memes/
  const memesUID = await anchor(owner, `memes_${S}`, rootUID);
  const vitalikUID = await anchor(owner, "vitalik.jpg", memesUID, dataSchemaUID);

  const ownerVitalikData = await createData(owner, "owner-vitalik-bytes");
  await property(owner, ownerVitalikData.uid, "contentType", "image/jpeg");
  await mirror(owner, ownerVitalikData.uid, ipfsTransportUID, "ipfs://owner-vitalik");
  await tag(owner, ownerVitalikData.uid, vitalikUID, true);

  const u1VitalikData = await createData(user1, "user1-vitalik-bytes");
  await property(user1, u1VitalikData.uid, "contentType", "image/jpeg");
  await mirror(user1, u1VitalikData.uid, ipfsTransportUID, "ipfs://user1-vitalik");
  await tag(user1, u1VitalikData.uid, vitalikUID, true);

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
  assert("First item is best.jpg (insertion order)", editionList[0] === bestUID);

  // ── Test 4: TAG-based File Placement + Folder Listing ──
  console.log("\n[4] TAG-based File Placement (getActiveTargetsByAttesterAndSchema)");

  // Owner placed ownerBestData at bestUID
  const ownerDatasAtBest = await tagResolver.getActiveTargetsByAttesterAndSchema(
    bestUID,
    ownerAddr,
    dataSchemaUID,
    0,
    10,
  );
  assert("Owner has 1 DATA placed at best.jpg", ownerDatasAtBest.length === 1, `got ${ownerDatasAtBest.length}`);
  assert("Owner's DATA UID matches", ownerDatasAtBest[0] === ownerBestData.uid);

  // User1 placed u1BestData at bestUID
  const u1DatasAtBest = await tagResolver.getActiveTargetsByAttesterAndSchema(bestUID, u1Addr, dataSchemaUID, 0, 10);
  assert("User1 has 1 DATA placed at best.jpg", u1DatasAtBest.length === 1);
  assert("User1's DATA UID matches", u1DatasAtBest[0] === u1BestData.uid);

  // Count function
  const ownerCount = await tagResolver.getActiveTargetsByAttesterAndSchemaCount(bestUID, ownerAddr, dataSchemaUID);
  assert("Count matches for owner at best.jpg", ownerCount === 1n);

  // ── Test 5: MIRROR Resolution ──
  console.log("\n[5] MIRROR Resolution");
  // MIRRORs are indexed via indexer.index() — discoverable via getReferencingAttestations
  const ownerMirrors = await indexer.getReferencingAttestations(ownerBestData.uid, mirrorSchemaUID, 0, 10, false);
  assert("Owner's DATA has 1 MIRROR", ownerMirrors.length === 1, `got ${ownerMirrors.length}`);

  // Decode MIRROR to get URI
  const mirrorAtt = await eas.getAttestation(ownerMirrors[0]);
  const [mirrorTransport, mirrorUri] = encode.decode(["bytes32", "string"], mirrorAtt.data);
  assert("MIRROR transport is ipfs", mirrorTransport === ipfsTransportUID);
  assert("MIRROR URI is correct", mirrorUri === "ipfs://owner-best", `got: ${mirrorUri}`);

  // ── Test 6: Content-Addressed Dedup ──
  console.log("\n[6] Content-Addressed Dedup (dataByContentKey)");
  const canonicalUID = await indexer.dataByContentKey(ownerBestData.contentHash);
  assert("dataByContentKey returns first DATA for this hash", canonicalUID === ownerBestData.uid);

  // Create a second DATA with the same content — different UID but same contentHash
  const dupData = await createData(owner, "owner-best-jpeg-bytes"); // same content
  const dupCanonical = await indexer.dataByContentKey(dupData.contentHash);
  assert("Canonical still points to first DATA (dedup)", dupCanonical === ownerBestData.uid);
  assert("Duplicate DATA has different UID", dupData.uid !== ownerBestData.uid);

  // ── Test 7: TAG Removal (applies=false) ──
  console.log("\n[7] TAG Removal (applies=false)");
  // Remove User1's placement of their DATA at best.jpg
  await tag(user1, u1BestData.uid, bestUID, false);

  const u1AfterRemoval = await tagResolver.getActiveTargetsByAttesterAndSchema(bestUID, u1Addr, dataSchemaUID, 0, 10);
  assert("User1's DATA removed from best.jpg after TAG applies=false", u1AfterRemoval.length === 0);

  // Re-tag it back
  await tag(user1, u1BestData.uid, bestUID, true);
  const u1AfterRetag = await tagResolver.getActiveTargetsByAttesterAndSchema(bestUID, u1Addr, dataSchemaUID, 0, 10);
  assert("User1's DATA re-placed at best.jpg after re-tag", u1AfterRetag.length === 1);

  // ── Test 8: Cross-Reference (same DATA at multiple paths) ──
  console.log("\n[8] Cross-Reference (same DATA at two paths)");
  // Place owner's best DATA also at /memes/vitalik.jpg anchor (cross-reference)
  await tag(owner, ownerBestData.uid, vitalikUID, true);

  const crossRefAtVitalik = await tagResolver.getActiveTargetsByAttesterAndSchema(
    vitalikUID,
    ownerAddr,
    dataSchemaUID,
    0,
    10,
  );
  // Owner already placed ownerVitalikData there, now also ownerBestData
  assert("Owner has 2 DATAs at vitalik.jpg (original + cross-ref)", crossRefAtVitalik.length === 2);
  assert("Cross-referenced DATA appears at second path", crossRefAtVitalik.includes(ownerBestData.uid));

  // ── Test 9: Multiple MIRRORs per DATA ──
  console.log("\n[9] Multiple MIRRORs (multi-transport)");
  // Add a second mirror (onchain) to owner's best DATA
  await mirror(owner, ownerBestData.uid, onchainTransportUID, "web3://0xABCDEF");

  const allMirrors = await indexer.getReferencingAttestations(ownerBestData.uid, mirrorSchemaUID, 0, 10, false);
  assert("DATA now has 2 MIRRORs (ipfs + onchain)", allMirrors.length === 2, `got ${allMirrors.length}`);

  // ── Test 10: Subdirectory Navigation ──
  console.log("\n[10] Subdirectory Navigation");
  const catsChildren = await indexer["getChildren(bytes32,uint256,uint256,bool)"](catsUID, 0, 10, false);
  assert("/pets/cats/ has 2 files", catsChildren.length === 2);

  const dogsChildren = await indexer["getChildren(bytes32,uint256,uint256,bool)"](dogsUID, 0, 10, false);
  assert("/pets/dogs/ has 1 file", dogsChildren.length === 1);

  // ── Test 11: Tagging (labels, not file placement) ──
  console.log("\n[11] Tagging (labels)");
  const funnyDef = await anchor(owner, `funny_${S}`, rootUID);

  // User1 labels ownerVitalikData as "funny"
  const tagUID1 = await tag(user1, ownerVitalikData.uid, funnyDef, true);
  // User2 negates it
  const tagUID2 = await tag(user2, ownerVitalikData.uid, funnyDef, false);

  const activeUID1 = await tagResolver.getActiveTagUID(u1Addr, ownerVitalikData.uid, funnyDef);
  assert("User1's active tag UID matches", activeUID1 === tagUID1);

  const activeUID2 = await tagResolver.getActiveTagUID(u2Addr, ownerVitalikData.uid, funnyDef);
  assert("User2's active tag UID matches (negation)", activeUID2 === tagUID2);

  const tagged = await tagResolver.isActivelyTagged(ownerVitalikData.uid, funnyDef);
  assert("isActivelyTagged true (user1 applied it)", tagged === true);

  // ── Test 12: propagateContains (tree visibility) ──
  console.log("\n[12] propagateContains (tree visibility)");
  // After TAG placement, the _containsAttestations flag should propagate up
  const u1ContainsPets = await indexer.containsAttestations(petsUID, u1Addr);
  assert("User1 containsAttestations in /pets/ (via fluffy.png TAG)", u1ContainsPets === true);

  const u2ContainsPets = await indexer.containsAttestations(petsUID, u2Addr);
  assert("User2 containsAttestations in /pets/ (via garfield.gif TAG)", u2ContainsPets === true);

  const ownerContainsPets = await indexer.containsAttestations(petsUID, ownerAddr);
  assert("Owner containsAttestations in /pets/ (via rex.jpg TAG)", ownerContainsPets === true);

  // ── Test 13: Schema-filtered Anchor listing ──
  console.log("\n[13] Schema-filtered Anchor Listing");
  // getAnchorsBySchema with dataSchemaUID should only return file anchors, not sub-folders
  const fileAnchorsInPets = await indexer["getAnchorsBySchema(bytes32,bytes32,uint256,uint256,bool)"](
    petsUID,
    dataSchemaUID,
    0,
    10,
    false,
  );
  assert(
    "DATA-schema anchors in /pets/ = 1 (best.jpg only, cats and dogs are folders)",
    fileAnchorsInPets.length === 1,
    `got ${fileAnchorsInPets.length}`,
  );
  assert("The DATA-schema anchor is best.jpg", fileAnchorsInPets[0] === bestUID);

  // ── Test 14: Deep Nesting ──
  console.log("\n[14] Deep Navigational Nesting");
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
  const deepRes6 = await indexer.resolveAnchor(deepRes5, `l6`, dataSchemaUID);

  assert("Layer 1 resolved", deepRes1 === l1);
  assert("Layer 2 resolved", deepRes2 === l2);
  assert("Layer 3 resolved", deepRes3 === l3);
  assert("Layer 4 resolved", deepRes4 === l4);
  assert("Layer 5 resolved", deepRes5 === l5);
  assert("Layer 6 resolved", deepRes6 === l6);

  // Place DATA at L6 via TAG
  const deepData = await createData(owner, "deep-layer-6-content");
  await mirror(owner, deepData.uid, ipfsTransportUID, "ipfs://deep-layer-6");
  await tag(owner, deepData.uid, l6, true);

  const deepDatas = await tagResolver.getActiveTargetsByAttesterAndSchema(l6, ownerAddr, dataSchemaUID, 0, 10);
  assert("Data placed at Layer 6 via TAG", deepDatas.length === 1);
  assert("DATA UID matches at Layer 6", deepDatas[0] === deepData.uid);

  // ── Test 15: Dedup Pagination ──
  console.log("\n[15] Dedup Pagination (30 files × 3 users, getChildrenByAddressList)");
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

  // ── Test 16: Reverse order (dedup) ──
  console.log("\n[16] Reverse Order");
  const [fwd] = await indexer.getChildrenByAddressList(spamParent, [ownerAddr, u1Addr, u2Addr], 0n, 5, false, false);
  const [rev] = await indexer.getChildrenByAddressList(spamParent, [ownerAddr, u1Addr, u2Addr], 0n, 5, true, false);
  assert(
    "Forward ≠ Reverse first element",
    fwd[0] !== rev[0],
    `fwd[0]=${fwd[0].slice(0, 10)}… rev[0]=${rev[0].slice(0, 10)}…`,
  );

  // ── Test 17: PROPERTY metadata on DATA ──
  console.log("\n[17] PROPERTY on DATA");
  const propRefs = await indexer.getReferencingAttestations(ownerBestData.uid, propertySchemaUID, 0, 10, false);
  assert("Owner's DATA has 1 PROPERTY (contentType)", propRefs.length === 1, `got ${propRefs.length}`);

  const propAtt = await eas.getAttestation(propRefs[0]);
  const [propKey, propValue] = encode.decode(["string", "string"], propAtt.data);
  assert("PROPERTY key is contentType", propKey === "contentType");
  assert("PROPERTY value is image/jpeg", propValue === "image/jpeg");

  // ══════════════════════════════════════════════════════════════
  // Summary
  // ══════════════════════════════════════════════════════════════
  console.log("\n════════════════════════════════════════");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log("════════════════════════════════════════\n");

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
