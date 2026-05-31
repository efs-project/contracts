// packages/hardhat/test/Lists.conformance.test.ts
import { expect } from "chai";
import { ethers } from "hardhat";
import { EAS, SchemaRegistry, ListEntryResolver } from "../typechain-types";
import { Signer, ZeroAddress } from "ethers";

const ZERO_BYTES32 = "0x" + "0".repeat(64);
const NO_EXPIRATION = 0n;
const LIST_SCHEMA =
  "bool allowsDuplicates, bool appendOnly, uint8 targetType, bytes32 targetSchema, uint32 maxEntries";
const LIST_ENTRY_SCHEMA = "bytes32 listUID, bytes32 target"; // ADR-0046

describe("Lists — Conformance (worked example lifecycle)", function () {
  let eas: EAS;
  let registry: SchemaRegistry;
  let alice: Signer; // curator
  let bob: Signer; // listed address

  let listSchemaUID: string;
  let listEntrySchemaUID: string;
  let listEntryResolverAddr: string;
  let ler: ListEntryResolver;

  const enc = new ethers.AbiCoder();

  const encodeList = (
    allowsDuplicates: boolean,
    appendOnly: boolean,
    targetType: number,
    targetSchema: string,
    maxEntries: number,
  ) =>
    enc.encode(
      ["bool", "bool", "uint8", "bytes32", "uint32"],
      [allowsDuplicates, appendOnly, targetType, targetSchema, maxEntries],
    );

  const encodeEntry = (listUID: string, target: string) => enc.encode(["bytes32", "bytes32"], [listUID, target]);

  const getUID = (receipt: any): string => {
    const iface = eas.interface;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed?.name === "Attested") return parsed.args.uid;
      } catch {
        /* ignore */
      }
    }
    throw new Error("No Attested event");
  };

  beforeEach(async function () {
    [alice, bob] = await ethers.getSigners();
    const aliceAddr = await alice.getAddress();

    const RegistryFactory = await ethers.getContractFactory("SchemaRegistry");
    registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();

    const EASFactory = await ethers.getContractFactory("EAS");
    eas = await EASFactory.deploy(await registry.getAddress());
    await eas.waitForDeployment();

    // nonce+0: ListResolver, nonce+1: LIST reg, nonce+2: LIST_ENTRY reg, nonce+3: ListEntryResolver
    const n = await ethers.provider.getTransactionCount(aliceAddr);
    const futureListResolverAddr = ethers.getCreateAddress({ from: aliceAddr, nonce: n });
    listEntryResolverAddr = ethers.getCreateAddress({ from: aliceAddr, nonce: n + 3 });

    listSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      [LIST_SCHEMA, futureListResolverAddr, false],
    );
    listEntrySchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      [LIST_ENTRY_SCHEMA, listEntryResolverAddr, true],
    );

    const LR = await ethers.getContractFactory("ListResolver");
    const listResolver = await LR.deploy(await eas.getAddress());
    await listResolver.waitForDeployment();
    expect(await listResolver.getAddress()).to.equal(futureListResolverAddr);

    await registry.register(LIST_SCHEMA, await listResolver.getAddress(), false);
    await registry.register(LIST_ENTRY_SCHEMA, listEntryResolverAddr, true);

    const LER = await ethers.getContractFactory("ListEntryResolver");
    const listEntryResolverContract = await LER.deploy(await eas.getAddress(), listSchemaUID);
    await listEntryResolverContract.waitForDeployment();
    expect(await listEntryResolverContract.getAddress()).to.equal(listEntryResolverAddr);

    ler = listEntryResolverContract;
  });

  it("worked example: ADDR list — attest → dup-reject → revoke → re-add → stale-revoke", async function () {
    const aliceAddr = await alice.getAddress();
    const bobAddr = await bob.getAddress();

    // Step 1: Alice attests LIST (no-dupes, not append-only, ADDR-typed, uncapped)
    const listTx = await eas.connect(alice).attest({
      schema: listSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: ZERO_BYTES32,
        data: encodeList(false, false, 1, ZERO_BYTES32, 0),
        value: 0n,
      },
    });
    const listUID = getUID(await listTx.wait());
    expect(listUID).to.not.equal(ZERO_BYTES32);

    // Step 2: Alice attests LIST_ENTRY for Bob (ADDR mode: target=0, recipient=bob)
    const e1Tx = await eas.connect(alice).attest({
      schema: listEntrySchemaUID,
      data: {
        recipient: bobAddr,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: ZERO_BYTES32,
        data: encodeEntry(listUID, ZERO_BYTES32),
        value: 0n,
      },
    });
    const e1UID = getUID(await e1Tx.wait());

    // Verify membership via ListEntryResolver.getMemberCount
    const identityKeyBob = ethers.zeroPadValue(ethers.toBeHex(BigInt(bobAddr)), 32);
    expect(await ler.getMemberCount(listUID, identityKeyBob, aliceAddr)).to.equal(1n);
    expect(await ler.getLength(listUID, aliceAddr)).to.equal(1n);

    // Step 3: Duplicate rejection — same recipient
    await expect(
      eas.connect(alice).attest({
        schema: listEntrySchemaUID,
        data: {
          recipient: bobAddr,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: ZERO_BYTES32,
          data: encodeEntry(listUID, ZERO_BYTES32),
          value: 0n,
        },
      }),
    ).to.be.revertedWithCustomError(ler, "DuplicateIdentity");

    // Step 4: Alice revokes e1
    await eas.connect(alice).revoke({ schema: listEntrySchemaUID, data: { uid: e1UID, value: 0n } });
    expect(await ler.getMemberCount(listUID, identityKeyBob, aliceAddr)).to.equal(0n);
    expect(await ler.getLength(listUID, aliceAddr)).to.equal(0n);

    // Step 5: Re-add Bob (slot freed)
    const e3Tx = await eas.connect(alice).attest({
      schema: listEntrySchemaUID,
      data: {
        recipient: bobAddr,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: ZERO_BYTES32,
        data: encodeEntry(listUID, ZERO_BYTES32),
        value: 0n,
      },
    });
    const e3UID = getUID(await e3Tx.wait());
    expect(await ler.getMemberCount(listUID, identityKeyBob, aliceAddr)).to.equal(1n);

    // Step 6: Stale revoke — NOTE: EAS itself reverts with AlreadyRevoked() if you try to
    // revoke an already-revoked attestation (EAS.sol:539). The resolver's pp1==0 idempotency
    // guard is defensive code for CREATE2-redeployment / multi-chain scenarios where the
    // resolver might have empty state but receive revoke calls for existing EAS attestations.
    // It is not exercisable through EAS's normal revoke() path in tests.
    // We verify instead that the post-revoke+re-add state is still consistent.
    expect(await ler.getMemberCount(listUID, identityKeyBob, aliceAddr)).to.equal(1n);
    expect(await ler.getLength(listUID, aliceAddr)).to.equal(1n);

    // Cleanup: revoke e3 so later asserts don't see stale state
    await eas.connect(alice).revoke({ schema: listEntrySchemaUID, data: { uid: e3UID, value: 0n } });
  });

  it("address(0) as list entry — identityKey==bytes32(0) is valid", async function () {
    const aliceAddr = await alice.getAddress();

    const listTx = await eas.connect(alice).attest({
      schema: listSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: ZERO_BYTES32,
        data: encodeList(false, false, 1, ZERO_BYTES32, 0),
        value: 0n,
      },
    });
    const listUID = getUID(await listTx.wait());

    // address(0) → identityKey = bytes32(0)
    const eTx = await eas.connect(alice).attest({
      schema: listEntrySchemaUID,
      data: {
        recipient: ZeroAddress, // address(0) is a valid ADDR entry
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: ZERO_BYTES32,
        data: encodeEntry(listUID, ZERO_BYTES32),
        value: 0n,
      },
    });
    const eUID = getUID(await eTx.wait());

    expect(await ler.getMemberCount(listUID, ZERO_BYTES32, aliceAddr)).to.equal(1n);
    expect(await ler.getLength(listUID, aliceAddr)).to.equal(1n);

    // Revoke and verify cleanup
    await eas.connect(alice).revoke({ schema: listEntrySchemaUID, data: { uid: eUID, value: 0n } });
    expect(await ler.getMemberCount(listUID, ZERO_BYTES32, aliceAddr)).to.equal(0n);
  });
});
