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
  const encodeEntry = (lu: string, t: string, w: bigint) =>
    enc.encode(["bytes32", "bytes32", "int256"], [lu, t, w]);

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
      data: encodeEntry(allowlistUID, ethers.ZeroHash, 0n),
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
      data: encodeEntry(allowlistUID, ethers.ZeroHash, 0n),
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
      data: encodeEntry(filmListUID, filmUID, 900n), // weight = 900 = rank
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
  assert("film entry weight=900", filmEntries[0].weight === 900n);

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
      data: encodeEntry(shopListUID, milkKey, 1n),
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
      data: encodeEntry(shopListUID, eggKey, 2n),
      value: 0n,
    },
  });

  const shopLen = await listReader.length(shopListUID, aliceAddr);
  assert("shopping list has 2 items", shopLen === 2n);
  assert("milk is in list", (await listReader.countOf(shopListUID, aliceAddr, milkKey)) === 1n);
  assert("eggs are in list", (await listReader.countOf(shopListUID, aliceAddr, eggKey)) === 1n);

  // ── Section 4: Lens switching ─────────────────────────────────────────────

  console.log("\nSection 4: Lens switching (per-attester views)");

  const sharedListTx = await eas.connect(alice).attest({
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
  const sharedListUID = getUID(await sharedListTx.wait());

  const signers = await ethers.getSigners();
  const carol = signers[3]; // signers[2] is bob; carol must be a distinct address
  const carolAddr = await carol.getAddress();

  // Alice adds Bob; Bob adds Carol (each attester's own lens)
  await eas.connect(alice).attest({
    schema: listEntrySchemaUID,
    data: {
      recipient: bobAddr,
      expirationTime: 0n,
      revocable: true,
      refUID: ethers.ZeroHash,
      data: encodeEntry(sharedListUID, ethers.ZeroHash, 0n),
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
      data: encodeEntry(sharedListUID, ethers.ZeroHash, 0n),
      value: 0n,
    },
  });

  const identityKeyCarol = ethers.zeroPadValue(ethers.toBeHex(BigInt(carolAddr)), 32);
  assert(
    "Alice's lens: Bob is listed",
    (await listReader.countOf(sharedListUID, aliceAddr, identityKeyBob)) === 1n,
  );
  assert(
    "Alice's lens: Carol is NOT listed",
    (await listReader.countOf(sharedListUID, aliceAddr, identityKeyCarol)) === 0n,
  );
  assert(
    "Bob's lens: Carol is listed",
    (await listReader.countOf(sharedListUID, bobAddr, identityKeyCarol)) === 1n,
  );
  assert(
    "Bob's lens: Bob is NOT listed (different attester)",
    (await listReader.countOf(sharedListUID, bobAddr, identityKeyBob)) === 0n,
  );

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
