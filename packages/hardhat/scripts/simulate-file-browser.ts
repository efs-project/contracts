import { ethers } from "hardhat";
import { EFSIndexer, EdgeResolver } from "../typechain-types";

/**
 * EFS File Browser Simulation
 *
 * Exercises the full file browser workflow against a deployed EFS stack,
 * using the three-layer data model: paths (Anchors) → data (DATA) → retrieval (MIRRORs).
 *
 * Edge model (ADR-0041):
 *   - File placement → PIN (cardinality 1) under (definition=fileAnchor, attester, schema=DATA)
 *   - PROPERTY value binding → PIN under (definition=keyAnchor, attester, schema=PROPERTY)
 *   - Labels (favorite, funny, etc.) → TAG (cardinality N) with optional int256 weight
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
  console.log("  Paths · DATA · MIRRORs · PINs · TAGs");
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
  const pinSchemaUID = await indexer.PIN_SCHEMA_UID();
  const tagSchemaUID = await indexer.TAG_SCHEMA_UID();
  const edgeResolverAddr = await indexer.edgeResolver();
  const edgeResolver = (await ethers.getContractAt("EdgeResolver", edgeResolverAddr)) as unknown as EdgeResolver;
  const rootUID = await indexer.rootAnchorUID();

  console.log(`Indexer:      ${indexer.target}`);
  console.log(`EAS:          ${eas.target}`);
  console.log(`EdgeResolver: ${edgeResolverAddr}`);
  console.log(`Root:         ${rootUID}\n`);

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

  /**
   * Tracker: (target, definition, attester) → active PIN UID. Needed because
   * revoking a PIN takes its UID and we want O(1) lookup at unpin time.
   */
  const activePinIndex = new Map<string, string>();
  const pinKey = (target: string, definition: string, attester: string) =>
    `${target}|${definition}|${attester.toLowerCase()}`;

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

  /** Create a standalone DATA attestation (contentHash + size, non-revocable, standalone) */
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

  /** Place a PIN edge (cardinality 1). New PIN at the same slot supersedes the prior in O(1). */
  const pin = async (signer: any, targetUID: string, definitionUID: string) => {
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

  /** Revoke the active PIN at (target, definition, signer). */
  const unpin = async (signer: any, targetUID: string, definitionUID: string) => {
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
  const property = async (signer: any, containerUID: string, key: string, value: string) => {
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

    // Bind PROPERTY value to key anchor with a PIN — re-binding supersedes O(1).
    await pin(signer, propertyUID, keyAnchorUID);
    return propertyUID;
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

  /**
   * Place a DATA at a file Anchor via PIN (file placement is cardinality 1 — ADR-0041).
   * Returns the PIN UID.
   */
  const placeData = async (signer: any, dataUID: string, anchorUID: string) => {
    return pin(signer, dataUID, anchorUID);
  };

  /** Apply a TAG label (cardinality N). Optional int256 weight for sort/score metadata. */
  const tagLabel = async (signer: any, targetUID: string, definitionUID: string, weight: bigint = 1n) => {
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

  // ══════════════════════════════════════════════════════════════
  // PHASE 1: Build realistic file tree using three-layer model
  // ══════════════════════════════════════════════════════════════
  console.log("── Phase 1: Building File Tree ──\n");

  // /pets/
  const petsUID = await anchor(owner, `pets_${S}`, rootUID);
  console.log(`  /pets_${S}/  created`);

  // /pets/best.jpg — 3 lenses via PIN-based placement
  const bestUID = await anchor(owner, "best.jpg", petsUID, dataSchemaUID);

  // Owner's lens: DATA + PROPERTY(contentType) + MIRROR + PIN
  const ownerBestData = await createData(owner, "owner-best-jpeg-bytes");
  await property(owner, ownerBestData.uid, "contentType", "image/jpeg");
  await mirror(owner, ownerBestData.uid, ipfsTransportUID, "ipfs://owner-best");
  await placeData(owner, ownerBestData.uid, bestUID);

  // User1's lens
  const u1BestData = await createData(user1, "user1-best-jpeg-bytes");
  await property(user1, u1BestData.uid, "contentType", "image/jpeg");
  await mirror(user1, u1BestData.uid, ipfsTransportUID, "ipfs://user1-best");
  await placeData(user1, u1BestData.uid, bestUID);

  // User2's lens
  const u2BestData = await createData(user2, "user2-best-jpeg-bytes");
  await property(user2, u2BestData.uid, "contentType", "image/jpeg");
  await mirror(user2, u2BestData.uid, ipfsTransportUID, "ipfs://user2-best");
  await placeData(user2, u2BestData.uid, bestUID);

  console.log(`  /pets/best.jpg  3 lenses (PIN-placed)`);

  // /pets/cats/
  const catsUID = await anchor(owner, "cats", petsUID);
  const fluffyUID = await anchor(user1, "fluffy.png", catsUID, dataSchemaUID);
  const fluffyData = await createData(user1, "fluffy-png-bytes");
  await property(user1, fluffyData.uid, "contentType", "image/png");
  await mirror(user1, fluffyData.uid, ipfsTransportUID, "ipfs://fluffy");
  await placeData(user1, fluffyData.uid, fluffyUID);

  const garfieldUID = await anchor(user2, "garfield.gif", catsUID, dataSchemaUID);
  const garfieldData = await createData(user2, "garfield-gif-bytes");
  await property(user2, garfieldData.uid, "contentType", "image/gif");
  await mirror(user2, garfieldData.uid, ipfsTransportUID, "ipfs://garfield");
  await placeData(user2, garfieldData.uid, garfieldUID);
  console.log(`  /pets/cats/  2 files`);

  // /pets/dogs/
  const dogsUID = await anchor(owner, "dogs", petsUID);
  const rexUID = await anchor(owner, "rex.jpg", dogsUID, dataSchemaUID);
  const rexData = await createData(owner, "rex-jpeg-bytes");
  await property(owner, rexData.uid, "contentType", "image/jpeg");
  await mirror(owner, rexData.uid, ipfsTransportUID, "ipfs://rex");
  await placeData(owner, rexData.uid, rexUID);
  console.log(`  /pets/dogs/  1 file`);

  // /memes/
  const memesUID = await anchor(owner, `memes_${S}`, rootUID);
  const vitalikUID = await anchor(owner, "vitalik.jpg", memesUID, dataSchemaUID);

  const ownerVitalikData = await createData(owner, "owner-vitalik-bytes");
  await property(owner, ownerVitalikData.uid, "contentType", "image/jpeg");
  await mirror(owner, ownerVitalikData.uid, ipfsTransportUID, "ipfs://owner-vitalik");
  await placeData(owner, ownerVitalikData.uid, vitalikUID);

  const u1VitalikData = await createData(user1, "user1-vitalik-bytes");
  await property(user1, u1VitalikData.uid, "contentType", "image/jpeg");
  await mirror(user1, u1VitalikData.uid, ipfsTransportUID, "ipfs://user1-vitalik");
  await placeData(user1, u1VitalikData.uid, vitalikUID);

  console.log(`  /memes_${S}/vitalik.jpg  2 lenses`);
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

  // ── Test 3: Lens Directory Listing (getChildrenByAddressList — dedup) ──
  console.log("\n[3] Lens Directory Listing");
  const [lensList] = await indexer.getChildrenByAddressList(petsUID, [u1Addr, u2Addr, ownerAddr], 0n, 10, false, false);
  assert(
    "getChildrenByAddressList returns 3 unique items (best.jpg, cats, dogs)",
    lensList.length === 3,
    `got ${lensList.length} items`,
  );
  assert("First item is best.jpg (insertion order)", lensList[0] === bestUID);

  // ── Test 4: PIN-based File Placement + Folder Listing ──
  console.log("\n[4] PIN-based File Placement (getActivePinTarget — O(1))");

  // Owner placed ownerBestData at bestUID via PIN
  const ownerDataAtBest = await edgeResolver.getActivePinTarget(bestUID, ownerAddr, dataSchemaUID);
  assert("Owner's PIN target at best.jpg matches", ownerDataAtBest === ownerBestData.uid);

  // User1 placed u1BestData at bestUID via PIN
  const u1DataAtBest = await edgeResolver.getActivePinTarget(bestUID, u1Addr, dataSchemaUID);
  assert("User1's PIN target at best.jpg matches", u1DataAtBest === u1BestData.uid);

  // isActiveEdge: schema-aware check (PIN slot). The owner's PIN at best.jpg
  // has target=ownerBestData.uid, definition=bestUID — matches the placement
  // performed at line ~265 (placeData(owner, ownerBestData.uid, bestUID)).
  assert(
    "Owner has an active PIN edge at best.jpg",
    await edgeResolver.isActiveEdge(ownerAddr, ownerBestData.uid, bestUID, pinSchemaUID),
  );

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

  // ── Test 7: PIN Removal (eas.revoke under ADR-0041) ──
  console.log("\n[7] PIN Removal (eas.revoke)");
  // Revoke User1's PIN placing their DATA at best.jpg
  await unpin(user1, u1BestData.uid, bestUID);

  const u1AfterRemoval = await edgeResolver.getActivePinTarget(bestUID, u1Addr, dataSchemaUID);
  assert("User1's PIN cleared after revoke", u1AfterRemoval === ethers.ZeroHash);

  // Re-place via new PIN
  await placeData(user1, u1BestData.uid, bestUID);
  const u1AfterRetag = await edgeResolver.getActivePinTarget(bestUID, u1Addr, dataSchemaUID);
  assert("User1's PIN re-placed at best.jpg", u1AfterRetag === u1BestData.uid);

  // ── Test 8: Cross-Reference (same DATA at multiple paths via supersede) ──
  console.log("\n[8] PIN Cross-Reference (supersede O(1))");
  // PIN owner's best DATA also at /memes/vitalik.jpg anchor.
  // Note: PIN is cardinality 1 per (def=anchor, attester, schema), so this *supersedes*
  // the prior ownerVitalikData PIN at that anchor — only one DATA per attester per anchor.
  // (Multiple anchors can each PIN the same DATA — that's the cross-reference.)
  await placeData(owner, ownerBestData.uid, vitalikUID);

  const crossRefAtVitalik = await edgeResolver.getActivePinTarget(vitalikUID, ownerAddr, dataSchemaUID);
  assert(
    "Owner's PIN at vitalik.jpg now points to ownerBestData (supersede)",
    crossRefAtVitalik === ownerBestData.uid,
    `got ${crossRefAtVitalik}`,
  );

  // The same DATA is pinned at two anchors by the same attester — cross-reference works:
  const stillAtBest = await edgeResolver.getActivePinTarget(bestUID, ownerAddr, dataSchemaUID);
  assert("Owner's PIN at best.jpg still points to ownerBestData (cross-ref)", stillAtBest === ownerBestData.uid);

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

  // ── Test 11: Tagging (labels — cardinality N) ──
  console.log("\n[11] Tagging (labels — TAG with weight)");
  const funnyDef = await anchor(owner, `funny_${S}`, rootUID);

  // User1 labels ownerVitalikData as "funny" (weight=1)
  const tagUID1 = await tagLabel(user1, ownerVitalikData.uid, funnyDef);
  // User2 ALSO labels it (multiple TAGs coexist — cardinality N)
  const tagUID2 = await tagLabel(user2, ownerVitalikData.uid, funnyDef, 5n); // higher score

  const activeUID1 = await edgeResolver.getActiveEdgeUID(u1Addr, ownerVitalikData.uid, funnyDef, tagSchemaUID);
  assert("User1's active TAG UID matches", activeUID1 === tagUID1);

  const activeUID2 = await edgeResolver.getActiveEdgeUID(u2Addr, ownerVitalikData.uid, funnyDef, tagSchemaUID);
  assert("User2's active TAG UID matches", activeUID2 === tagUID2);

  assert(
    "hasActiveEdge(funny) true (user1 + user2 both applied)",
    await edgeResolver.hasActiveEdge(ownerVitalikData.uid, funnyDef),
  );

  // ── Test 12: propagateContains (tree visibility) ──
  console.log("\n[12] propagateContains (tree visibility)");
  // After PIN placement, the _containsAttestations flag should propagate up
  const u1ContainsPets = await indexer.containsAttestations(petsUID, u1Addr);
  assert("User1 containsAttestations in /pets/ (via fluffy.png PIN)", u1ContainsPets === true);

  const u2ContainsPets = await indexer.containsAttestations(petsUID, u2Addr);
  assert("User2 containsAttestations in /pets/ (via garfield.gif PIN)", u2ContainsPets === true);

  const ownerContainsPets = await indexer.containsAttestations(petsUID, ownerAddr);
  assert("Owner containsAttestations in /pets/ (via rex.jpg PIN)", ownerContainsPets === true);

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

  // Place DATA at L6 via PIN
  const deepData = await createData(owner, "deep-layer-6-content");
  await mirror(owner, deepData.uid, ipfsTransportUID, "ipfs://deep-layer-6");
  await placeData(owner, deepData.uid, l6);

  const deepData6 = await edgeResolver.getActivePinTarget(l6, ownerAddr, dataSchemaUID);
  assert("Data placed at Layer 6 via PIN", deepData6 === deepData.uid);

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

  // ── Test 17: PROPERTY metadata on DATA (PIN-bound under ADR-0041) ──
  console.log("\n[17] PROPERTY on DATA");
  const contentTypeKeyAnchor = await indexer.resolveAnchor(ownerBestData.uid, "contentType", propertySchemaUID);
  assert(
    "contentType key anchor exists on owner's DATA",
    contentTypeKeyAnchor !== ethers.ZeroHash,
    `got ${contentTypeKeyAnchor}`,
  );

  // PROPERTY value binding is a PIN: getActivePinTarget returns the PROPERTY UID directly (O(1)).
  const propUID = await edgeResolver.getActivePinTarget(contentTypeKeyAnchor, ownerAddr, propertySchemaUID);
  assert("Owner has an active contentType PROPERTY binding", propUID !== ethers.ZeroHash, `got ${propUID}`);

  const propAtt = await eas.getAttestation(propUID);
  const [propValue] = encode.decode(["string"], propAtt.data);
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
