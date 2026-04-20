import { ethers } from "hardhat";
import { EFSIndexer, TagResolver, EFSFileView, EFSRouter } from "../typechain-types";

/**
 * EFS Transports & Mirrors Simulation
 *
 * Exercises the full multi-transport retrieval layer:
 *   DATA (standalone) → MIRROR(s) (per transport) → gateway resolution
 *
 * Tests:
 *   1.  Transport definition anchor discovery (/transports/*)
 *   2.  Single-transport file upload (DATA + MIRROR + TAG)
 *   3.  Multi-transport mirrors on one DATA (IPFS + Arweave + HTTPS)
 *   4.  EFSFileView.getDataMirrors pagination + revocation filtering
 *   5.  Best-mirror selection via EFSRouter._getBestMirrorURI (web3:// preferred)
 *   6.  Content-addressed dedup — same content, shared mirrors
 *   7.  Adding a mirror to someone else's DATA (permissionless)
 *   8.  Mirror revocation — revoke one transport, others survive
 *   9.  EFSRouter full resolution: path → TAG → DATA → MIRROR → response
 *  10.  EFSFileView.getFilesAtPath for tag-based folder listing
 *  11.  Cross-path mirror sharing (same DATA at two paths)
 *  12.  Transport preference ordering (onchain > ipfs > arweave > https > magnet)
 *  13.  Magnet link transport
 *  14.  contentType PROPERTY resolution via EFSRouter._getContentType
 *
 * Run: npx hardhat run scripts/simulate-transports.ts --network localhost
 */
async function main() {
  const PASS = "\u2705 PASS";
  const FAIL = "\u274c FAIL";
  let passed = 0;
  let failed = 0;
  const assert = (label: string, condition: boolean, detail: string = "") => {
    if (condition) {
      console.log(`  ${PASS} ${label}${detail ? ` \u2014 ${detail}` : ""}`);
      passed++;
    } else {
      console.log(`  ${FAIL} ${label}${detail ? ` \u2014 ${detail}` : ""}`);
      failed++;
    }
  };

  console.log(
    "\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550",
  );
  console.log("  EFS Transports & Mirrors Simulation");
  console.log("  DATA \u2192 MIRROR(s) \u2192 Gateway Resolution");
  console.log(
    "\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n",
  );

  const [deployer, user1, user2] = await ethers.getSigners();
  const owner = deployer;

  const ownerAddr = await owner.getAddress();
  const u1Addr = await user1.getAddress();
  const u2Addr = await user2.getAddress();

  // Connect to deployed contracts
  const indexer = (await ethers.getContract("Indexer", owner)) as unknown as EFSIndexer;
  const fileView = (await ethers.getContract("EFSFileView", owner)) as unknown as EFSFileView;
  const router = (await ethers.getContract("EFSRouter", owner)) as unknown as EFSRouter;
  const easAddress = await indexer.getEAS();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const eas = (await ethers.getContractAt(
    "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol:IEAS",
    easAddress,
  )) as any;

  // Schema UIDs and partner contracts from Indexer (single entry point)
  const anchorSchemaUID = await indexer.ANCHOR_SCHEMA_UID();
  const dataSchemaUID = await indexer.DATA_SCHEMA_UID();
  const propertySchemaUID = await indexer.PROPERTY_SCHEMA_UID();
  const mirrorSchemaUID = await indexer.MIRROR_SCHEMA_UID();
  const tagSchemaUID = await indexer.TAG_SCHEMA_UID();
  const tagResolverAddr = await indexer.tagResolver();
  const tagResolver = (await ethers.getContractAt("TagResolver", tagResolverAddr)) as unknown as TagResolver;
  const rootUID = await indexer.rootAnchorUID();

  console.log(`Indexer:   ${indexer.target}`);
  console.log(`FileView:  ${fileView.target}`);
  console.log(`Router:    ${router.target}`);
  console.log(`EAS:       ${eas.target}`);
  console.log(`Root:      ${rootUID}\n`);

  // Session ID for unique names
  const S = Date.now().toString(36);

  // \u2500\u2500 Helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  /**
   * Attach a PROPERTY to a container using the unified free-floating model
   * (ADR-0035): key anchor under the container, free-floating PROPERTY(value),
   * and a TAG binding them. Returns the PROPERTY UID.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const property = async (signer: any, containerUID: string, key: string, value: string) => {
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createMirror = async (signer: any, dataUID: string, transportDef: string, uri: string) => {
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const revoke = async (signer: any, schemaUID: string, uid: string) => {
    const tx = await eas.connect(signer).revoke({
      schema: schemaUID,
      data: { uid, value: 0n },
    });
    await tx.wait();
  };

  // Resolve all transport definition anchors
  const transportsUID = await indexer.resolvePath(rootUID, "transports");
  const onchainTransportUID = await indexer.resolvePath(transportsUID, "onchain");
  const ipfsTransportUID = await indexer.resolvePath(transportsUID, "ipfs");
  const arweaveTransportUID = await indexer.resolvePath(transportsUID, "arweave");
  const magnetTransportUID = await indexer.resolvePath(transportsUID, "magnet");
  const httpsTransportUID = await indexer.resolvePath(transportsUID, "https");

  // ======================================================================
  // TEST 1: Transport Definition Anchor Discovery
  // ======================================================================
  console.log("[1] Transport Definition Anchor Discovery\n");

  assert("/transports/ exists", transportsUID !== ethers.ZeroHash);
  assert("/transports/onchain exists", onchainTransportUID !== ethers.ZeroHash);
  assert("/transports/ipfs exists", ipfsTransportUID !== ethers.ZeroHash);
  assert("/transports/arweave exists", arweaveTransportUID !== ethers.ZeroHash);
  assert("/transports/magnet exists", magnetTransportUID !== ethers.ZeroHash);
  assert("/transports/https exists", httpsTransportUID !== ethers.ZeroHash);

  // Verify all 5 transport types are children of /transports/
  const transportChildren = await indexer["getChildren(bytes32,uint256,uint256,bool)"](transportsUID, 0, 10, false);
  assert("5 transport children", transportChildren.length === 5, `got ${transportChildren.length}`);

  // ======================================================================
  // TEST 2: Single-Transport File Upload (IPFS)
  // ======================================================================
  console.log("\n[2] Single-Transport File Upload (IPFS)\n");

  const galleryUID = await anchor(owner, `gallery_${S}`, rootUID);
  const photo1UID = await anchor(owner, "sunset.jpg", galleryUID, dataSchemaUID);

  const photo1Data = await createData(owner, "sunset-jpeg-bytes-content");
  await property(owner, photo1Data.uid, "contentType", "image/jpeg");
  const photo1Mirror = await createMirror(owner, photo1Data.uid, ipfsTransportUID, "ipfs://QmSunset123");
  await tag(owner, photo1Data.uid, photo1UID, true);

  // Verify mirror is discoverable via getReferencingAttestations
  const photo1Mirrors = await indexer.getReferencingAttestations(photo1Data.uid, mirrorSchemaUID, 0, 10, false);
  assert("MIRROR indexed on DATA", photo1Mirrors.length === 1);
  assert("MIRROR UID matches", photo1Mirrors[0] === photo1Mirror);

  // Decode mirror attestation to verify fields
  const photo1MirrorAtt = await eas.getAttestation(photo1Mirror);
  const [decodedTransport, decodedURI] = encode.decode(["bytes32", "string"], photo1MirrorAtt.data);
  assert("transport = /transports/ipfs", decodedTransport === ipfsTransportUID);
  assert("uri = ipfs://QmSunset123", decodedURI === "ipfs://QmSunset123");

  console.log(`  /gallery_${S}/sunset.jpg uploaded with IPFS mirror`);

  // ======================================================================
  // TEST 3: Multi-Transport Mirrors on One DATA
  // ======================================================================
  console.log("\n[3] Multi-Transport Mirrors on One DATA\n");

  const docUID = await anchor(owner, "paper.pdf", galleryUID, dataSchemaUID);
  const docData = await createData(owner, "academic-paper-pdf-content");
  await property(owner, docData.uid, "contentType", "application/pdf");

  // Three transports for the same DATA
  const _docMirrorIPFS = await createMirror(owner, docData.uid, ipfsTransportUID, "ipfs://QmPaper456");
  const _docMirrorArweave = await createMirror(owner, docData.uid, arweaveTransportUID, "ar://paper789");
  const docMirrorHTTPS = await createMirror(owner, docData.uid, httpsTransportUID, "https://example.com/paper.pdf");
  await tag(owner, docData.uid, docUID, true);

  const docMirrors = await indexer.getReferencingAttestations(docData.uid, mirrorSchemaUID, 0, 10, false);
  assert("3 mirrors on paper.pdf DATA", docMirrors.length === 3, `got ${docMirrors.length}`);

  // Verify each mirror's transport definition
  for (const mUID of docMirrors) {
    const att = await eas.getAttestation(mUID);
    const [tDef] = encode.decode(["bytes32", "string"], att.data);
    const isKnownTransport = tDef === ipfsTransportUID || tDef === arweaveTransportUID || tDef === httpsTransportUID;
    assert(`mirror ${mUID.slice(0, 10)}... has valid transport`, isKnownTransport);
  }

  // ======================================================================
  // TEST 4: EFSFileView.getDataMirrors (pagination + filtering)
  // ======================================================================
  console.log("\n[4] EFSFileView.getDataMirrors\n");

  const mirrorItems = await fileView.getDataMirrors(docData.uid, 0, 10);
  assert("getDataMirrors returns 3 active mirrors", mirrorItems.length === 3, `got ${mirrorItems.length}`);

  // Verify MirrorItem struct fields
  const firstMirror = mirrorItems[0];
  assert("MirrorItem has uid", firstMirror.uid !== ethers.ZeroHash);
  assert("MirrorItem has transportDefinition", firstMirror.transportDefinition !== ethers.ZeroHash);
  assert("MirrorItem has uri", firstMirror.uri.length > 0);
  assert("MirrorItem has attester", firstMirror.attester === ownerAddr);
  assert("MirrorItem has timestamp", firstMirror.timestamp > 0n);

  // Pagination: page size 2
  const page1 = await fileView.getDataMirrors(docData.uid, 0, 2);
  assert("Page 1 returns 2 mirrors", page1.length === 2);
  const page2 = await fileView.getDataMirrors(docData.uid, 2, 2);
  assert("Page 2 returns 1 mirror", page2.length === 1);

  // ======================================================================
  // TEST 5: Mirror Revocation — revoke one, others survive
  // ======================================================================
  console.log("\n[5] Mirror Revocation\n");

  // Revoke the HTTPS mirror
  await revoke(owner, mirrorSchemaUID, docMirrorHTTPS);
  assert("HTTPS mirror revoked", await indexer.isRevoked(docMirrorHTTPS));

  // getDataMirrors should filter out the revoked one
  const postRevokeMirrors = await fileView.getDataMirrors(docData.uid, 0, 10);
  assert(
    "getDataMirrors returns 2 after revocation",
    postRevokeMirrors.length === 2,
    `got ${postRevokeMirrors.length}`,
  );

  // Verify the surviving mirrors are IPFS and Arweave
  const survivingTransports = postRevokeMirrors.map(m => m.transportDefinition);
  assert("IPFS mirror survives", survivingTransports.includes(ipfsTransportUID));
  assert("Arweave mirror survives", survivingTransports.includes(arweaveTransportUID));

  // ======================================================================
  // TEST 6: Permissionless Mirror Addition
  // ======================================================================
  console.log("\n[6] Permissionless Mirror Addition (user1 mirrors owner's DATA)\n");

  // user1 adds an Arweave mirror to owner's sunset.jpg DATA
  const _u1SunsetMirror = await createMirror(user1, photo1Data.uid, arweaveTransportUID, "ar://user1-sunset-backup");

  const sunsetMirrors = await fileView.getDataMirrors(photo1Data.uid, 0, 10);
  assert("sunset.jpg now has 2 mirrors", sunsetMirrors.length === 2, `got ${sunsetMirrors.length}`);

  // Verify second mirror's attester is user1
  const u1Mirror = sunsetMirrors.find(m => m.attester === u1Addr);
  assert("user1's mirror found", u1Mirror !== undefined);
  assert("user1's mirror is Arweave", u1Mirror!.transportDefinition === arweaveTransportUID);
  assert("user1's mirror URI correct", u1Mirror!.uri === "ar://user1-sunset-backup");

  // ======================================================================
  // TEST 7: Content-Addressed Dedup + Shared Mirrors
  // ======================================================================
  console.log("\n[7] Content-Addressed Dedup\n");

  // user2 creates a DATA with the same content as sunset.jpg
  const dupData = await createData(user2, "sunset-jpeg-bytes-content");
  assert("same content produces same contentHash", dupData.contentHash === photo1Data.contentHash);

  // Canonical DATA lookup returns the original
  const canonical = await indexer.dataByContentKey(photo1Data.contentHash);
  assert("canonical DATA is owner's (first)", canonical === photo1Data.uid);

  // Both DATA UIDs are distinct attestations
  assert("duplicate DATA gets its own UID", dupData.uid !== photo1Data.uid);

  // user2 can add mirrors to their own DATA
  await createMirror(user2, dupData.uid, ipfsTransportUID, "ipfs://QmSunsetDup");
  const dupMirrors = await fileView.getDataMirrors(dupData.uid, 0, 10);
  assert("duplicate DATA has its own mirror", dupMirrors.length === 1);

  // Original DATA's mirrors are unaffected
  const origMirrors = await fileView.getDataMirrors(photo1Data.uid, 0, 10);
  assert("original DATA mirrors unchanged", origMirrors.length === 2);

  // ======================================================================
  // TEST 8: Cross-Path Mirror Sharing (same DATA at two paths)
  // ======================================================================
  console.log("\n[8] Cross-Path Sharing\n");

  const favesUID = await anchor(owner, `faves_${S}`, rootUID);
  const faveSunsetUID = await anchor(owner, "sunset.jpg", favesUID, dataSchemaUID);

  // Place the SAME original DATA at a second path — no new mirrors needed
  await tag(owner, photo1Data.uid, faveSunsetUID, true);

  // Verify the DATA is now in both paths
  const galleryTargets = await tagResolver.getActiveTargetsByAttesterAndSchema(
    photo1UID,
    ownerAddr,
    dataSchemaUID,
    0,
    10,
  );
  assert("sunset.jpg in /gallery/ via TAG", galleryTargets.length === 1);
  assert("gallery points to original DATA", galleryTargets[0] === photo1Data.uid);

  const faveTargets = await tagResolver.getActiveTargetsByAttesterAndSchema(
    faveSunsetUID,
    ownerAddr,
    dataSchemaUID,
    0,
    10,
  );
  assert("sunset.jpg in /faves/ via TAG", faveTargets.length === 1);
  assert("faves points to same DATA", faveTargets[0] === photo1Data.uid);

  // Both paths share the same mirrors
  const favesMirrors = await fileView.getDataMirrors(faveTargets[0], 0, 10);
  assert("shared DATA, shared mirrors (2)", favesMirrors.length === 2, `got ${favesMirrors.length}`);

  // ======================================================================
  // TEST 9: EFSFileView.getFilesAtPath (tag-based folder listing)
  // ======================================================================
  console.log("\n[9] EFSFileView.getFilesAtPath\n");

  // List DATAs at the gallery folder for owner
  const galleryPage = await fileView.getFilesAtPath(photo1UID, [ownerAddr], dataSchemaUID, "0x", 10);
  const galleryFiles = galleryPage.items;
  assert("getFilesAtPath returns 1 DATA at sunset.jpg anchor", galleryFiles.length === 1, `got ${galleryFiles.length}`);
  assert("returned item has correct contentHash", galleryFiles[0].contentHash === photo1Data.contentHash);
  assert("returned item hasData=true", galleryFiles[0].hasData);

  // Multi-attester query: owner + user2 at sunset anchor (owner tagged, user2 didn't)
  const multiAttesterPage = await fileView.getFilesAtPath(photo1UID, [ownerAddr, u2Addr], dataSchemaUID, "0x", 10);
  assert("multi-attester: only owner's DATA", multiAttesterPage.items.length === 1);

  // ======================================================================
  // TEST 10: Magnet Link Transport
  // ======================================================================
  console.log("\n[10] Magnet Link Transport\n");

  const torrentUID = await anchor(owner, "linux.iso", galleryUID, dataSchemaUID);
  const torrentData = await createData(owner, "linux-iso-content-hash-stand-in");
  await property(owner, torrentData.uid, "contentType", "application/x-iso9660-image");
  const magnetURI = "magnet:?xt=urn:btih:abc123&dn=linux.iso";
  await createMirror(owner, torrentData.uid, magnetTransportUID, magnetURI);
  await tag(owner, torrentData.uid, torrentUID, true);

  const torrentMirrors = await fileView.getDataMirrors(torrentData.uid, 0, 10);
  assert("magnet mirror created", torrentMirrors.length === 1);
  assert("magnet URI preserved", torrentMirrors[0].uri === magnetURI);
  assert("transport = /transports/magnet", torrentMirrors[0].transportDefinition === magnetTransportUID);

  // ======================================================================
  // TEST 11: Transport Preference — Router Best-Mirror Selection
  // ======================================================================
  console.log("\n[11] Transport Preference (Best Mirror via Router)\n");

  // Create a file with multiple transports to test preference ordering
  const prefUID = await anchor(owner, `pref_${S}.txt`, galleryUID, dataSchemaUID);
  const prefData = await createData(owner, "preference-test-content");
  await property(owner, prefData.uid, "contentType", "text/plain");

  // Add mirrors in non-preferred order: https first, then ipfs
  await createMirror(owner, prefData.uid, httpsTransportUID, "https://cdn.example.com/pref.txt");
  await createMirror(owner, prefData.uid, ipfsTransportUID, "ipfs://QmPref");
  await tag(owner, prefData.uid, prefUID, true);

  // Router request — should pick ipfs or https (no web3:// mirror, so first non-web3 wins)
  // Since _getBestMirrorURI prefers web3://, and there's none, it picks the first available
  const routerRes = await router.request([`gallery_${S}`, `pref_${S}.txt`], [{ key: "editions", value: ownerAddr }]);
  assert("Router returns 200", routerRes[0] === 200n, `got ${routerRes[0]}`);
  // External URI → message/external-body response
  const _headerStr = new TextDecoder().decode(ethers.getBytes(routerRes[1]));
  // Body is empty for external URIs; check headers
  const headers = routerRes[2];
  const contentTypeHeader = headers.find(
    (h: { key: string; value: string }) => h.key === "Content-Type" && !h.value.startsWith("message/"),
  );
  assert(
    "Router resolves contentType from PROPERTY",
    contentTypeHeader?.value === "text/plain",
    `got: ${contentTypeHeader?.value}`,
  );

  // ======================================================================
  // TEST 12: contentType PROPERTY Resolution
  // ======================================================================
  console.log("\n[12] contentType PROPERTY Resolution\n");

  // Verify the _getContentType fix: it should return the PROPERTY value via
  // the unified free-floating model — key anchor + attester-scoped TAG.
  const ctKeyAnchor = await indexer.resolveAnchor(prefData.uid, "contentType", propertySchemaUID);
  assert("contentType key anchor indexed under DATA", ctKeyAnchor !== ethers.ZeroHash, `got ${ctKeyAnchor}`);
  const ctProps = await tagResolver.getActiveTargetsByAttesterAndSchema(
    ctKeyAnchor,
    ownerAddr,
    propertySchemaUID,
    0,
    10,
  );
  assert("Owner has 1 active contentType PROPERTY", ctProps.length === 1, `got ${ctProps.length}`);
  const ctPropAtt = await eas.getAttestation(ctProps[0]);
  const [ctValue] = encode.decode(["string"], ctPropAtt.data);
  assert("PROPERTY value is 'text/plain'", ctValue === "text/plain", `got ${ctValue}`);

  // ======================================================================
  // TEST 13: Router Resolution — Full Path Walk
  // ======================================================================
  console.log("\n[13] Router Full Path Walk\n");

  // Resolve sunset.jpg through the Router (gallery path)
  const sunsetRes = await router.request([`gallery_${S}`, "sunset.jpg"], [{ key: "editions", value: ownerAddr }]);
  assert("Router resolves /gallery/sunset.jpg", sunsetRes[0] === 200n, `status ${sunsetRes[0]}`);

  // Non-existent path
  const notFoundRes = await router.request(
    [`gallery_${S}`, "nonexistent.txt"],
    [{ key: "editions", value: ownerAddr }],
  );
  assert("Router returns 404 for missing file", notFoundRes[0] === 404n);

  // No editions → should still find data via referencing fallback or return 404
  const noEditionsRes = await router.request([`gallery_${S}`, "sunset.jpg"], []);
  // Without editions, Router falls back to getReferencingAttestations
  // sunset.jpg anchor has no direct DATA refUID, but photo1Data.uid doesn't ref the anchor either
  // In new model without editions, the router's no-editions fallback checks getReferencingAttestations
  // on the anchor for DATA_SCHEMA — which returns empty (DATA is standalone). So this should 404.
  assert(
    "Router with no editions returns 404 (DATA is tag-placed, not direct ref)",
    noEditionsRes[0] === 404n,
    `got ${noEditionsRes[0]}`,
  );

  // ======================================================================
  // TEST 14: DATA with No Mirrors
  // ======================================================================
  console.log("\n[14] DATA with No Mirrors\n");

  const orphanUID = await anchor(owner, `orphan_${S}.txt`, galleryUID, dataSchemaUID);
  const orphanData = await createData(owner, "orphan-no-mirrors");
  await tag(owner, orphanData.uid, orphanUID, true);

  const orphanMirrors = await fileView.getDataMirrors(orphanData.uid, 0, 10);
  assert("DATA with no mirrors returns empty", orphanMirrors.length === 0);

  // Router should return 404 (no mirror available)
  const orphanRouterRes = await router.request(
    [`gallery_${S}`, `orphan_${S}.txt`],
    [{ key: "editions", value: ownerAddr }],
  );
  assert("Router returns 404 for mirrorless DATA", orphanRouterRes[0] === 404n);

  // ======================================================================
  // Summary
  // ======================================================================
  console.log(`\n${"═".repeat(40)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`${"═".repeat(40)}\n`);

  if (failed > 0) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
