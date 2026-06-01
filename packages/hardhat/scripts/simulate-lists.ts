import { ethers } from "hardhat";
import { EFSIndexer, ListEntryResolver, ListReader } from "../typechain-types";

/**
 * EFS Lists Simulation
 *
 * Exercises the lists primitive from a client/third-party-dev POV against
 * a deployed EFS stack. Validates ergonomics of ListReader, all 3 list modes,
 * add/remove/reorder, and lens switching.
 *
 * Run: yarn workspace @se-2/hardhat simulate:lists
 */

const PASS = "✅ PASS";
const FAIL = "❌ FAIL";
let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  ${PASS} ${label}${detail ? ` — ${detail}` : ""}`);
    passed++;
  } else {
    console.log(`  ${FAIL} ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

async function main() {
  console.log("════════════════════════════════════════");
  console.log("  EFS Lists Simulation");
  console.log("  ADDR · SCHEMA · ANY · lenses");
  console.log("════════════════════════════════════════\n");

  const [deployer, alice, bob] = await ethers.getSigners();
  const aliceAddr = await alice.getAddress();
  const bobAddr = await bob.getAddress();

  // Connect to deployed contracts
  const indexer = (await ethers.getContract("Indexer", deployer)) as unknown as EFSIndexer;
  const easAddr = await indexer.getEAS();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const eas = (await ethers.getContractAt(
    "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol:IEAS",
    easAddr,
  )) as any;

  const listEntryResolver = (await ethers.getContract("ListEntryResolver", deployer)) as unknown as ListEntryResolver;
  const listReader = (await ethers.getContract("ListReader", deployer)) as unknown as ListReader;

  const listSchemaUID = await listEntryResolver.LIST_SCHEMA_UID();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listEntrySchemaUID = await (listReader as any).LIST_ENTRY_SCHEMA_UID();

  console.log(`ListEntryResolver: ${await listEntryResolver.getAddress()}`);
  console.log(`ListReader:        ${await listReader.getAddress()}`);
  console.log(`LIST_SCHEMA_UID:   ${listSchemaUID}`);
  console.log(`LIST_ENTRY_SCHEMA_UID: ${listEntrySchemaUID}\n`);

  const enc = new ethers.AbiCoder();
  const S = Date.now().toString(36); // session suffix for uniqueness

  const encodeList = (ad: boolean, ao: boolean, tt: number, ts: string, me: number) =>
    enc.encode(["bool", "bool", "uint8", "bytes32", "uint32"], [ad, ao, tt, ts, me]);
  const encodeEntry = (lu: string, t: string) => enc.encode(["bytes32", "bytes32"], [lu, t]);

  const getUID = (receipt: any): string => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const log of receipt.logs) {
      try {
        const p = eas.interface.parseLog(log);
        if (p?.name === "Attested") return p.args.uid;
      } catch {
        /* ignore */
      }
    }
    throw new Error("No Attested event");
  };

  // ── Section 1: ADDR-typed allowlist ───────────────────────────────────────

  console.log("Section 1: ADDR-typed NFT allowlist");

  const list1Tx = await eas.connect(alice).attest({
    schema: listSchemaUID,
    data: {
      recipient: ethers.ZeroAddress,
      expirationTime: 0n,
      revocable: false,
      refUID: ethers.ZeroHash,
      data: encodeList(false, false, 1, ethers.ZeroHash, 0),
      value: 0n,
    },
  });
  const allowlistUID = getUID(await list1Tx.wait());
  console.log(`  Created allowlist: ${allowlistUID}`);

  // Verify getMode on empty list
  const mode1 = await listReader.getMode(allowlistUID);
  assert("getMode on empty list returns exists=true", mode1.exists);
  assert("getMode curator is alice", mode1.curator.toLowerCase() === aliceAddr.toLowerCase());
  assert("getMode targetType=ADDR", Number(mode1.targetType) === 1);

  // Add Bob
  const addBobTx = await eas.connect(alice).attest({
    schema: listEntrySchemaUID,
    data: {
      recipient: bobAddr,
      expirationTime: 0n,
      revocable: true,
      refUID: ethers.ZeroHash,
      data: encodeEntry(allowlistUID, ethers.ZeroHash),
      value: 0n,
    },
  });
  const bobEntryUID = getUID(await addBobTx.wait());

  const identityKeyBob = ethers.zeroPadValue(ethers.toBeHex(BigInt(bobAddr)), 32);
  const countBob = await listReader.countOf(allowlistUID, aliceAddr, identityKeyBob);
  assert("Bob is on allowlist (countOf == 1)", countBob === 1n);

  const len1 = await listReader.length(allowlistUID, aliceAddr);
  assert("allowlist length == 1", len1 === 1n);

  const bobDecoded = await listReader.targetAsAddress(allowlistUID, aliceAddr, bobEntryUID);
  assert("targetAsAddress returns bob's address", bobDecoded.toLowerCase() === bobAddr.toLowerCase());

  // Remove Bob
  await eas.connect(alice).revoke({ schema: listEntrySchemaUID, data: { uid: bobEntryUID, value: 0n } });
  const countAfterRevoke = await listReader.countOf(allowlistUID, aliceAddr, identityKeyBob);
  assert("Bob removed from allowlist (countOf == 0)", countAfterRevoke === 0n);

  // Verify re-add works after revoke
  const readdTx = await eas.connect(alice).attest({
    schema: listEntrySchemaUID,
    data: {
      recipient: bobAddr,
      expirationTime: 0n,
      revocable: true,
      refUID: ethers.ZeroHash,
      data: encodeEntry(allowlistUID, ethers.ZeroHash),
      value: 0n,
    },
  });
  const readdUID = getUID(await readdTx.wait());
  const countReAdded = await listReader.countOf(allowlistUID, aliceAddr, identityKeyBob);
  assert("Bob re-added after revoke (countOf == 1)", countReAdded === 1n);
  // Clean up
  await eas.connect(alice).revoke({ schema: listEntrySchemaUID, data: { uid: readdUID, value: 0n } });

  // ── Section 2: SCHEMA-typed ranked list ───────────────────────────────────

  console.log("\nSection 2: SCHEMA-typed Letterboxd film list");

  const dataSchemaUID = await indexer.DATA_SCHEMA_UID();

  const filmListTx = await eas.connect(alice).attest({
    schema: listSchemaUID,
    data: {
      recipient: ethers.ZeroAddress,
      expirationTime: 0n,
      revocable: false,
      refUID: ethers.ZeroHash,
      data: encodeList(false, false, 2, dataSchemaUID, 10),
      value: 0n,
    },
  });
  const filmListUID = getUID(await filmListTx.wait());

  // Mint a DATA attestation to use as a film
  const filmTx = await eas.connect(alice).attest({
    schema: dataSchemaUID,
    data: {
      recipient: ethers.ZeroAddress,
      expirationTime: 0n,
      revocable: false,
      refUID: ethers.ZeroHash,
      data: enc.encode(["bytes32", "uint64"], [ethers.keccak256(ethers.toUtf8Bytes(`film-${S}`)), 1000n]),
      value: 0n,
    },
  });
  const filmUID = getUID(await filmTx.wait());

  const addFilmTx = await eas.connect(alice).attest({
    schema: listEntrySchemaUID,
    data: {
      recipient: ethers.ZeroAddress,
      expirationTime: 0n,
      revocable: true,
      refUID: ethers.ZeroHash,
      data: encodeEntry(filmListUID, filmUID),
      value: 0n,
    },
  });
  const filmEntryUID = getUID(await addFilmTx.wait());

  const filmCount = await listReader.countOf(filmListUID, aliceAddr, filmUID);
  assert("Film is in list (countOf == 1)", filmCount === 1n);

  const filmDecoded = await listReader.targetAsUID(filmListUID, aliceAddr, filmEntryUID);
  assert("targetAsUID returns film UID", filmDecoded === filmUID);

  const filmEntries = await listReader.entries(filmListUID, aliceAddr, 0n, 10n);
  assert("entries() has 1 film", filmEntries.length === 1);
  assert("film entry decodes to film UID", filmEntries[0].identityKey === filmUID);

  // ── Section 3: ANY-typed shopping list ────────────────────────────────────

  console.log("\nSection 3: ANY-typed shopping list with intrinsic items");

  const shopListTx = await eas.connect(alice).attest({
    schema: listSchemaUID,
    data: {
      recipient: ethers.ZeroAddress,
      expirationTime: 0n,
      revocable: false,
      refUID: ethers.ZeroHash,
      data: encodeList(false, false, 0, ethers.ZeroHash, 0),
      value: 0n,
    },
  });
  const shopListUID = getUID(await shopListTx.wait());

  const milkKey = ethers.keccak256(enc.encode(["string", "string"], ["efs-list-intrinsic", "milk"]));
  const eggKey = ethers.keccak256(enc.encode(["string", "string"], ["efs-list-intrinsic", "eggs"]));

  await eas.connect(alice).attest({
    schema: listEntrySchemaUID,
    data: {
      recipient: ethers.ZeroAddress,
      expirationTime: 0n,
      revocable: true,
      refUID: ethers.ZeroHash,
      data: encodeEntry(shopListUID, milkKey),
      value: 0n,
    },
  });
  await eas.connect(alice).attest({
    schema: listEntrySchemaUID,
    data: {
      recipient: ethers.ZeroAddress,
      expirationTime: 0n,
      revocable: true,
      refUID: ethers.ZeroHash,
      data: encodeEntry(shopListUID, eggKey),
      value: 0n,
    },
  });

  const shopLen = await listReader.length(shopListUID, aliceAddr);
  assert("shopping list has 2 items", shopLen === 2n);
  assert("milk is in list", (await listReader.countOf(shopListUID, aliceAddr, milkKey)) === 1n);
  assert("eggs are in list", (await listReader.countOf(shopListUID, aliceAddr, eggKey)) === 1n);

  // ── Section 4: Multi-lens scenarios ──────────────────────────────────────────

  console.log("\nSection 4: Multi-lens scenarios (per-attester views)");

  const signers = await ethers.getSigners();
  const carol = signers[3]; // signers[2] is bob; carol must be a distinct address
  const carolAddr = await carol.getAddress();
  const deployerAddr = await deployer.getAddress();

  const identityKeyCarol = ethers.zeroPadValue(ethers.toBeHex(BigInt(carolAddr)), 32);
  const identityKeyDeployer = ethers.zeroPadValue(ethers.toBeHex(BigInt(deployerAddr)), 32);

  // One open ADDR list (no dups, not appendOnly, no cap) shared across 4-a through 4-h
  const openListTx = await eas.connect(alice).attest({
    schema: listSchemaUID,
    data: {
      recipient: ethers.ZeroAddress,
      expirationTime: 0n,
      revocable: false,
      refUID: ethers.ZeroHash,
      data: encodeList(false, false, 1, ethers.ZeroHash, 0),
      value: 0n,
    },
  });
  const openListUID = getUID(await openListTx.wait());

  // 4-a: Basic per-attester isolation — Alice adds Bob, Bob adds Carol
  console.log("  4-a: Basic per-attester isolation");
  const aliceAddsBobTx = await eas.connect(alice).attest({
    schema: listEntrySchemaUID,
    data: {
      recipient: bobAddr,
      expirationTime: 0n,
      revocable: true,
      refUID: ethers.ZeroHash,
      data: encodeEntry(openListUID, ethers.ZeroHash),
      value: 0n,
    },
  });
  const aliceAddsBobUID = getUID(await aliceAddsBobTx.wait());
  await eas.connect(bob).attest({
    schema: listEntrySchemaUID,
    data: {
      recipient: carolAddr,
      expirationTime: 0n,
      revocable: true,
      refUID: ethers.ZeroHash,
      data: encodeEntry(openListUID, ethers.ZeroHash),
      value: 0n,
    },
  });
  assert("4-a Alice's lens: Bob=1", (await listReader.countOf(openListUID, aliceAddr, identityKeyBob)) === 1n);
  assert("4-a Alice's lens: Carol=0", (await listReader.countOf(openListUID, aliceAddr, identityKeyCarol)) === 0n);
  assert("4-a Bob's lens: Carol=1", (await listReader.countOf(openListUID, bobAddr, identityKeyCarol)) === 1n);
  assert("4-a Bob's lens: Bob=0", (await listReader.countOf(openListUID, bobAddr, identityKeyBob)) === 0n);

  // 4-a': On-chain attester index (consensus state — what the UI's edition picker and any
  // smart contract reads, NOT event logs). Alice and Bob have each attested an entry, so the
  // index must enumerate exactly [alice, bob], deduped, and report count 2.
  const attCount = await listEntryResolver.getListAttesterCount(openListUID);
  const attPage = await listEntryResolver.getListAttesters(openListUID, 0n, 100n);
  const attSet = new Set(attPage.map((a: string) => a.toLowerCase()));
  assert("4-a' getListAttesterCount == 2", attCount === 2n);
  assert("4-a' getListAttesters page length == 2", attPage.length === 2);
  assert("4-a' index contains Alice", attSet.has(aliceAddr.toLowerCase()));
  assert("4-a' index contains Bob", attSet.has(bobAddr.toLowerCase()));
  assert("4-a' index deduped (no Carol — she attested nothing)", !attSet.has(carolAddr.toLowerCase()));

  // 4-b: Same member in two lenses (open curation) — Alice also adds Carol
  console.log("  4-b: Same member in two lenses");
  const aliceAddsCarolTx = await eas.connect(alice).attest({
    schema: listEntrySchemaUID,
    data: {
      recipient: carolAddr,
      expirationTime: 0n,
      revocable: true,
      refUID: ethers.ZeroHash,
      data: encodeEntry(openListUID, ethers.ZeroHash),
      value: 0n,
    },
  });
  const aliceAddsCarolUID = getUID(await aliceAddsCarolTx.wait());
  assert(
    "4-b Alice's lens: Carol=1 (now added)",
    (await listReader.countOf(openListUID, aliceAddr, identityKeyCarol)) === 1n,
  );
  assert(
    "4-b Bob's lens: Carol still=1 (independent)",
    (await listReader.countOf(openListUID, bobAddr, identityKeyCarol)) === 1n,
  );

  // 4-c: entries() and length() are scoped per lens
  console.log("  4-c: entries()/length() per lens");
  const aliceEntriesSec4 = await listReader.entries(openListUID, aliceAddr, 0n, 10n);
  const bobEntriesSec4 = await listReader.entries(openListUID, bobAddr, 0n, 10n);
  assert("4-c Alice has 2 entries (Bob + Carol)", aliceEntriesSec4.length === 2);
  assert("4-c Bob has 1 entry (Carol only)", bobEntriesSec4.length === 1);
  assert("4-c length(list, alice) == 2", (await listReader.length(openListUID, aliceAddr)) === 2n);
  assert("4-c length(list, bob) == 1", (await listReader.length(openListUID, bobAddr)) === 1n);

  // 4-d: Revoke in one lens, other lens unaffected
  console.log("  4-d: Revoke in one lens, other unaffected");
  await eas.connect(alice).revoke({ schema: listEntrySchemaUID, data: { uid: aliceAddsCarolUID, value: 0n } });
  assert(
    "4-d Alice's lens: Carol removed",
    (await listReader.countOf(openListUID, aliceAddr, identityKeyCarol)) === 0n,
  );
  assert(
    "4-d Bob's lens: Carol still present",
    (await listReader.countOf(openListUID, bobAddr, identityKeyCarol)) === 1n,
  );
  assert("4-d Alice now has 1 entry", (await listReader.length(openListUID, aliceAddr)) === 1n);
  // Attester index is append-only consensus state: revoking an entry never removes an
  // attester (Alice still appears even though one of her entries is gone).
  assert(
    "4-d getListAttesterCount still == 2 after revoke",
    (await listEntryResolver.getListAttesterCount(openListUID)) === 2n,
  );

  // 4-e: Typed accessor with wrong lens reverts
  console.log("  4-e: Wrong-lens revert on typed accessor");
  let wrongLensReverted = false;
  try {
    // aliceAddsBobUID was attested by alice; passing bob as lens should revert "wrong lens"
    await listReader.targetAsAddress(openListUID, bobAddr, aliceAddsBobUID);
  } catch {
    wrongLensReverted = true;
  }
  assert("4-e targetAsAddress with wrong lens reverts", wrongLensReverted);

  // 4-f: maxEntries cap is per-attester, not global
  console.log("  4-f: maxEntries cap is per-attester");
  const cappedListTx = await eas.connect(alice).attest({
    schema: listSchemaUID,
    data: {
      recipient: ethers.ZeroAddress,
      expirationTime: 0n,
      revocable: false,
      refUID: ethers.ZeroHash,
      data: encodeList(false, false, 1, ethers.ZeroHash, 2), // maxEntries=2
      value: 0n,
    },
  });
  const cappedListUID = getUID(await cappedListTx.wait());
  // Alice fills both her slots
  await eas.connect(alice).attest({
    schema: listEntrySchemaUID,
    data: {
      recipient: deployerAddr,
      expirationTime: 0n,
      revocable: true,
      refUID: ethers.ZeroHash,
      data: encodeEntry(cappedListUID, ethers.ZeroHash),
      value: 0n,
    },
  });
  await eas.connect(alice).attest({
    schema: listEntrySchemaUID,
    data: {
      recipient: carolAddr,
      expirationTime: 0n,
      revocable: true,
      refUID: ethers.ZeroHash,
      data: encodeEntry(cappedListUID, ethers.ZeroHash),
      value: 0n,
    },
  });
  assert("4-f Alice fills 2 slots", (await listReader.length(cappedListUID, aliceAddr)) === 2n);
  // Bob can independently fill his own 2 slots (cap is not shared)
  await eas.connect(bob).attest({
    schema: listEntrySchemaUID,
    data: {
      recipient: deployerAddr,
      expirationTime: 0n,
      revocable: true,
      refUID: ethers.ZeroHash,
      data: encodeEntry(cappedListUID, ethers.ZeroHash),
      value: 0n,
    },
  });
  await eas.connect(bob).attest({
    schema: listEntrySchemaUID,
    data: {
      recipient: carolAddr,
      expirationTime: 0n,
      revocable: true,
      refUID: ethers.ZeroHash,
      data: encodeEntry(cappedListUID, ethers.ZeroHash),
      value: 0n,
    },
  });
  assert("4-f Bob fills 2 slots (independent cap)", (await listReader.length(cappedListUID, bobAddr)) === 2n);
  // Alice cannot add a 3rd
  let aliceCapped = false;
  try {
    await eas.connect(alice).attest({
      schema: listEntrySchemaUID,
      data: {
        recipient: bobAddr,
        expirationTime: 0n,
        revocable: true,
        refUID: ethers.ZeroHash,
        data: encodeEntry(cappedListUID, ethers.ZeroHash),
        value: 0n,
      },
    });
  } catch {
    aliceCapped = true;
  }
  assert("4-f Alice's 3rd entry rejected (per-attester cap)", aliceCapped);

  // 4-g: Non-curator attester can add entries (open curation)
  console.log("  4-g: Non-curator can add entries");
  await eas.connect(carol).attest({
    schema: listEntrySchemaUID,
    data: {
      recipient: deployerAddr,
      expirationTime: 0n,
      revocable: true,
      refUID: ethers.ZeroHash,
      data: encodeEntry(openListUID, ethers.ZeroHash),
      value: 0n,
    },
  });
  assert("4-g Carol (non-curator) has her own lens", (await listReader.length(openListUID, carolAddr)) === 1n);
  assert(
    "4-g Carol's countOf is independent",
    (await listReader.countOf(openListUID, carolAddr, identityKeyDeployer)) === 1n,
  );

  // 4-h: allowsDuplicates=false is per-lens — Bob can add an identity Alice already added
  console.log("  4-h: dup-rejection is per-lens, not global");
  // Alice has Bob in her lens of openListUID. Bob adding himself to his own lens must succeed.
  await eas.connect(bob).attest({
    schema: listEntrySchemaUID,
    data: {
      recipient: bobAddr,
      expirationTime: 0n,
      revocable: true,
      refUID: ethers.ZeroHash,
      data: encodeEntry(openListUID, ethers.ZeroHash),
      value: 0n,
    },
  });
  assert(
    "4-h Bob can add himself (dup-check is per-lens, not global)",
    (await listReader.countOf(openListUID, bobAddr, identityKeyBob)) === 1n,
  );
  assert("4-h Alice's Bob entry unaffected", (await listReader.countOf(openListUID, aliceAddr, identityKeyBob)) === 1n);

  // ── Summary ────────────────────────────────────────────────────────────────

  console.log(`\n════════════════════════════════════════`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`════════════════════════════════════════`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
