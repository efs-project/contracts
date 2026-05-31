import { expect } from "chai";
import { ethers } from "hardhat";
import { ListResolver, ListEntryResolver, ListReader, EAS, SchemaRegistry } from "../typechain-types";
import { Signer, ZeroAddress } from "ethers";

const ZERO_BYTES32 = "0x" + "0".repeat(64);
const NO_EXPIRATION = 0n;
const LIST_SCHEMA = "bool allowsDuplicates, bool appendOnly, uint8 targetType, bytes32 targetSchema, uint256 maxEntries";
const LIST_ENTRY_SCHEMA = "bytes32 listUID, bytes32 target"; // ADR-0046: order/label are PROPERTYs, not fields

describe("Lists — Unit Tests", function () {
  let listResolver: ListResolver;
  let listEntryResolver: ListEntryResolver;
  let listReader: ListReader;
  let eas: EAS;
  let registry: SchemaRegistry;
  let alice: Signer;
  let bob: Signer;
  let listSchemaUID: string;
  let listEntrySchemaUID: string;
  let dummySchemaUID: string; // for minting target attestations in SCHEMA-mode tests

  const enc = new ethers.AbiCoder();
  const encodeList = (ad: boolean, ao: boolean, tt: number, ts: string, me: bigint | number) =>
    enc.encode(["bool", "bool", "uint8", "bytes32", "uint256"], [ad, ao, tt, ts, me]);
  const encodeEntry = (lu: string, t: string) => enc.encode(["bytes32", "bytes32"], [lu, t]);

  const getUID = (receipt: any): string => {
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

  beforeEach(async function () {
    [alice, bob] = await ethers.getSigners();
    const aliceAddr = await alice.getAddress();

    const RegistryFactory = await ethers.getContractFactory("SchemaRegistry");
    registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();

    const EASFactory = await ethers.getContractFactory("EAS");
    eas = await EASFactory.deploy(await registry.getAddress());
    await eas.waitForDeployment();

    // Deployment order:
    // nonce+0: ListResolver
    // nonce+1: LIST schema register
    // nonce+2: LIST_ENTRY schema register
    // nonce+3: dummy schema register
    // nonce+4: ListEntryResolver
    // nonce+5: ListReader
    const n = await ethers.provider.getTransactionCount(aliceAddr);
    const futureListResolverAddr = ethers.getCreateAddress({ from: aliceAddr, nonce: n });
    const futureListEntryResolverAddr = ethers.getCreateAddress({ from: aliceAddr, nonce: n + 4 });

    listSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      [LIST_SCHEMA, futureListResolverAddr, false],
    );
    listEntrySchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      [LIST_ENTRY_SCHEMA, futureListEntryResolverAddr, true],
    );

    const LRF = await ethers.getContractFactory("ListResolver");
    listResolver = await LRF.deploy(await eas.getAddress());
    await listResolver.waitForDeployment();

    await registry.register(LIST_SCHEMA, await listResolver.getAddress(), false);
    await registry.register(LIST_ENTRY_SCHEMA, futureListEntryResolverAddr, true);

    // dummy schema for SCHEMA-mode target attestations (nonce+3)
    const dummyTx = await registry.register("string label", ZeroAddress, false);
    const dummyReceipt = await dummyTx.wait();
    for (const log of dummyReceipt!.logs) {
      try {
        const parsed = registry.interface.parseLog(log);
        if (parsed?.name === "Registered") {
          dummySchemaUID = parsed.args.uid;
          break;
        }
      } catch {
        /* ignore */
      }
    }
    if (!dummySchemaUID) throw new Error("Could not find dummySchemaUID from Registered event");

    const LERF = await ethers.getContractFactory("ListEntryResolver");
    listEntryResolver = await LERF.deploy(await eas.getAddress(), listSchemaUID);
    await listEntryResolver.waitForDeployment();

    const LReadF = await ethers.getContractFactory("ListReader");
    listReader = await LReadF.deploy(
      await eas.getAddress(),
      await listEntryResolver.getAddress(),
      listSchemaUID,
      listEntrySchemaUID,
    );
    await listReader.waitForDeployment();
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  const attestList = async (
    signer: Signer,
    allowsDuplicates: boolean,
    appendOnly: boolean,
    targetType: number,
    targetSchema = ZERO_BYTES32,
    maxEntries = 0,
  ): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: listSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: ZERO_BYTES32,
        data: encodeList(allowsDuplicates, appendOnly, targetType, targetSchema, maxEntries),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  const attestAddrEntry = async (signer: Signer, listUID: string, addr: string): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: listEntrySchemaUID,
      data: {
        recipient: addr,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: ZERO_BYTES32,
        data: encodeEntry(listUID, ZERO_BYTES32),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  const attestAnyEntry = async (signer: Signer, listUID: string, memberKey: string): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: listEntrySchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: ZERO_BYTES32,
        data: encodeEntry(listUID, memberKey),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  const mintTarget = async (label: string): Promise<string> => {
    const tx = await eas.connect(alice).attest({
      schema: dummySchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: ZERO_BYTES32,
        data: enc.encode(["string"], [label]),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  const attestSchemaEntry = async (signer: Signer, listUID: string, targetUID: string): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: listEntrySchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: ZERO_BYTES32,
        data: encodeEntry(listUID, targetUID),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  const revokeEntry = async (signer: Signer, uid: string) =>
    eas.connect(signer).revoke({ schema: listEntrySchemaUID, data: { uid, value: 0n } });

  // ── Group A: ListResolver ──────────────────────────────────────────────────

  describe("A — ListResolver field validation", function () {
    it("A1: valid ADDR-typed LIST attests", async function () {
      const uid = await attestList(alice, false, false, 1);
      expect(uid).to.not.equal(ZERO_BYTES32);
    });

    it("A2: valid SCHEMA-typed LIST attests", async function () {
      const uid = await attestList(alice, false, false, 2, dummySchemaUID);
      expect(uid).to.not.equal(ZERO_BYTES32);
    });

    it("A3: valid ANY-typed LIST attests", async function () {
      const uid = await attestList(alice, false, false, 0);
      expect(uid).to.not.equal(ZERO_BYTES32);
    });

    it("A4: revocable=true reverts", async function () {
      // EAS.Irrevocable() fires before resolver when schema=non-revocable + request=revocable.
      // The resolver's check is defensive; EAS catches it first.
      await expect(
        eas.connect(alice).attest({
          schema: listSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true, // WRONG
            refUID: ZERO_BYTES32,
            data: encodeList(false, false, 1, ZERO_BYTES32, 0),
            value: 0n,
          },
        }),
      ).to.be.reverted; // EAS Irrevocable() or resolver — either way it fails
    });

    it("A5: expirationTime != 0 reverts", async function () {
      await expect(
        eas.connect(alice).attest({
          schema: listSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: 9999999999n,
            revocable: false,
            refUID: ZERO_BYTES32,
            data: encodeList(false, false, 1, ZERO_BYTES32, 0),
            value: 0n,
          },
        }),
      ).to.be.revertedWith("LIST must not expire");
    });

    it("A6: refUID != 0 reverts", async function () {
      // EAS validates refUID exists before calling resolver — so we need a real attestation.
      const validUID = await mintTarget("ref-target"); // valid EAS attestation
      await expect(
        eas.connect(alice).attest({
          schema: listSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: validUID, // valid UID — EAS accepts, resolver rejects
            data: encodeList(false, false, 1, ZERO_BYTES32, 0),
            value: 0n,
          },
        }),
      ).to.be.revertedWith("LIST must be free-floating");
    });

    it("A7: recipient != 0 reverts", async function () {
      await expect(
        eas.connect(alice).attest({
          schema: listSchemaUID,
          data: {
            recipient: await alice.getAddress(), // WRONG
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: ZERO_BYTES32,
            data: encodeList(false, false, 1, ZERO_BYTES32, 0),
            value: 0n,
          },
        }),
      ).to.be.revertedWith("LIST must not be directed");
    });

    it("A8: targetType > 2 reverts", async function () {
      await expect(
        eas.connect(alice).attest({
          schema: listSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: ZERO_BYTES32,
            data: encodeList(false, false, 3, ZERO_BYTES32, 0), // targetType=3 invalid
            value: 0n,
          },
        }),
      ).to.be.revertedWith("invalid targetType");
    });

    it("A9: SCHEMA-typed with zero targetSchema reverts", async function () {
      await expect(
        eas.connect(alice).attest({
          schema: listSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: ZERO_BYTES32,
            data: encodeList(false, false, 2, ZERO_BYTES32, 0), // targetType=2, zero targetSchema
            value: 0n,
          },
        }),
      ).to.be.revertedWith("SCHEMA mode requires targetSchema");
    });

    it("A10: non-SCHEMA with nonzero targetSchema reverts", async function () {
      await expect(
        eas.connect(alice).attest({
          schema: listSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: ZERO_BYTES32,
            data: encodeList(false, false, 1, dummySchemaUID, 0), // ADDR with targetSchema set
            value: 0n,
          },
        }),
      ).to.be.revertedWith("non-SCHEMA mode must have zero targetSchema");
    });

    it("A11: appendOnly+allowsDuplicates+uncapped reverts", async function () {
      await expect(
        eas.connect(alice).attest({
          schema: listSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: ZERO_BYTES32,
            data: encodeList(true, true, 1, ZERO_BYTES32, 0), // unbounded multiset
            value: 0n,
          },
        }),
      ).to.be.revertedWith("appendOnly+allowsDuplicates requires maxEntries cap");
    });

    it("A12: appendOnly+allowsDuplicates+maxEntries>0 succeeds", async function () {
      const uid = await attestList(alice, true, true, 1, ZERO_BYTES32, 100);
      expect(uid).to.not.equal(ZERO_BYTES32);
    });

    it("A13: ListAttested event emitted with correct args", async function () {
      await expect(
        eas.connect(alice).attest({
          schema: listSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: ZERO_BYTES32,
            data: encodeList(false, false, 1, ZERO_BYTES32, 0),
            value: 0n,
          },
        }),
      )
        .to.emit(listResolver, "ListAttested")
        .withArgs(
          (_: any) => _ !== ZERO_BYTES32, // listUID (any non-zero)
          await alice.getAddress(),
          false,
          false,
          1,
          ZERO_BYTES32,
          0,
        );
    });
  });

  // ── Group B: ListEntryResolver ─────────────────────────────────────────────

  describe("B — ListEntryResolver enforcement", function () {
    it("B1: ADDR entry attests and increments count", async function () {
      const listUID = await attestList(alice, false, false, 1);
      const bobAddr = await bob.getAddress();
      await attestAddrEntry(alice, listUID, bobAddr);
      const identityKey = ethers.zeroPadValue(ethers.toBeHex(BigInt(bobAddr)), 32);
      expect(await listEntryResolver.getMemberCount(listUID, identityKey, await alice.getAddress())).to.equal(1n);
    });

    it("B2: address(0) as ADDR entry is valid", async function () {
      const listUID = await attestList(alice, false, false, 1);
      await attestAddrEntry(alice, listUID, ZeroAddress);
      expect(await listEntryResolver.getMemberCount(listUID, ZERO_BYTES32, await alice.getAddress())).to.equal(1n);
    });

    it("B3: ADDR entry with nonzero target reverts", async function () {
      const listUID = await attestList(alice, false, false, 1);
      const badTarget = ethers.keccak256(ethers.toUtf8Bytes("bad"));
      await expect(
        eas.connect(alice).attest({
          schema: listEntrySchemaUID,
          data: {
            recipient: await bob.getAddress(),
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: ZERO_BYTES32,
            data: encodeEntry(listUID, badTarget), // nonzero target in ADDR mode
            value: 0n,
          },
        }),
      ).to.be.revertedWithCustomError(listEntryResolver, "BadAddrMode");
    });

    it("B4: SCHEMA entry attests (target exists, schema matches)", async function () {
      const listUID = await attestList(alice, false, false, 2, dummySchemaUID);
      const targetUID = await mintTarget("doc1");
      await attestSchemaEntry(alice, listUID, targetUID);
      expect(await listEntryResolver.getMemberCount(listUID, targetUID, await alice.getAddress())).to.equal(1n);
    });

    it("B5: SCHEMA entry — target missing reverts", async function () {
      const listUID = await attestList(alice, false, false, 2, dummySchemaUID);
      const fakeUID = ethers.keccak256(ethers.toUtf8Bytes("nonexistent"));
      await expect(attestSchemaEntry(alice, listUID, fakeUID)).to.be.revertedWithCustomError(
        listEntryResolver,
        "TargetMissing",
      );
    });

    it("B6: SCHEMA entry — schema mismatch reverts", async function () {
      // Register a second dummy schema
      const tx = await registry.register("uint256 n", ZeroAddress, false);
      const otherSchemaUID = (await tx.wait())!.logs[0].topics[1];
      const listUID = await attestList(alice, false, false, 2, dummySchemaUID);
      // Mint a target with the OTHER schema
      const targetTx = await eas.connect(alice).attest({
        schema: otherSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: enc.encode(["uint256"], [42n]),
          value: 0n,
        },
      });
      const targetUID = getUID(await targetTx.wait());
      await expect(attestSchemaEntry(alice, listUID, targetUID)).to.be.revertedWithCustomError(
        listEntryResolver,
        "TargetSchemaMismatch",
      );
    });

    it("B7: SCHEMA entry with nonzero recipient reverts", async function () {
      const listUID = await attestList(alice, false, false, 2, dummySchemaUID);
      const targetUID = await mintTarget("x");
      await expect(
        eas.connect(alice).attest({
          schema: listEntrySchemaUID,
          data: {
            recipient: await bob.getAddress(), // WRONG for SCHEMA mode
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: ZERO_BYTES32,
            data: encodeEntry(listUID, targetUID),
            value: 0n,
          },
        }),
      ).to.be.revertedWithCustomError(listEntryResolver, "BadRecipient");
    });

    it("B8: ANY entry attests", async function () {
      const listUID = await attestList(alice, false, false, 0);
      const key = ethers.keccak256(ethers.toUtf8Bytes("milk"));
      await attestAnyEntry(alice, listUID, key);
      expect(await listEntryResolver.getMemberCount(listUID, key, await alice.getAddress())).to.equal(1n);
    });

    it("B9: ANY entry with zero target reverts", async function () {
      const listUID = await attestList(alice, false, false, 0);
      await expect(attestAnyEntry(alice, listUID, ZERO_BYTES32)).to.be.revertedWithCustomError(
        listEntryResolver,
        "BadAnyTarget",
      );
    });

    it("B10: ANY entry with nonzero recipient reverts", async function () {
      const listUID = await attestList(alice, false, false, 0);
      const key = ethers.keccak256(ethers.toUtf8Bytes("milk"));
      await expect(
        eas.connect(alice).attest({
          schema: listEntrySchemaUID,
          data: {
            recipient: await bob.getAddress(), // WRONG for ANY mode
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: ZERO_BYTES32,
            data: encodeEntry(listUID, key),
            value: 0n,
          },
        }),
      ).to.be.revertedWithCustomError(listEntryResolver, "BadRecipient");
    });

    it("B11: no-dupes: same recipient reverts", async function () {
      const listUID = await attestList(alice, false, false, 1); // allowsDuplicates=false
      const bobAddr = await bob.getAddress();
      await attestAddrEntry(alice, listUID, bobAddr);
      await expect(attestAddrEntry(alice, listUID, bobAddr)).to.be.revertedWithCustomError(
        listEntryResolver,
        "DuplicateIdentity",
      );
    });

    it("B12: allowsDuplicates=true: same recipient twice succeeds", async function () {
      const listUID = await attestList(alice, true, false, 1); // allowsDuplicates=true
      const bobAddr = await bob.getAddress();
      await attestAddrEntry(alice, listUID, bobAddr);
      await attestAddrEntry(alice, listUID, bobAddr); // should succeed
      const identityKey = ethers.zeroPadValue(ethers.toBeHex(BigInt(bobAddr)), 32);
      expect(await listEntryResolver.getMemberCount(listUID, identityKey, await alice.getAddress())).to.equal(2n);
    });

    it("B13: cap enforcement: exceeding maxEntries reverts", async function () {
      const listUID = await attestList(alice, false, false, 1, ZERO_BYTES32, 2); // cap=2
      const signers = await ethers.getSigners();
      await attestAddrEntry(alice, listUID, await signers[2].getAddress());
      await attestAddrEntry(alice, listUID, await signers[3].getAddress());
      await expect(attestAddrEntry(alice, listUID, await signers[4].getAddress())).to.be.revertedWithCustomError(
        listEntryResolver,
        "ListFull",
      );
    });

    it("B14: append-only: revoke reverts", async function () {
      const listUID = await attestList(alice, false, true, 1); // appendOnly=true
      const bobAddr = await bob.getAddress();
      const uid = await attestAddrEntry(alice, listUID, bobAddr);
      await expect(revokeEntry(alice, uid)).to.be.revertedWithCustomError(listEntryResolver, "ListIsAppendOnly");
    });

    it("B15: non-append-only: revoke succeeds, count decrements", async function () {
      const listUID = await attestList(alice, false, false, 1);
      const bobAddr = await bob.getAddress();
      const uid = await attestAddrEntry(alice, listUID, bobAddr);
      const identityKey = ethers.zeroPadValue(ethers.toBeHex(BigInt(bobAddr)), 32);
      await revokeEntry(alice, uid);
      expect(await listEntryResolver.getMemberCount(listUID, identityKey, await alice.getAddress())).to.equal(0n);
    });

    it("B16: swap-and-pop preserves remaining entries correctly", async function () {
      // NOTE: EAS.AlreadyRevoked() prevents testing onRevoke's pp1==0 idempotency path
      // through EAS's normal revoke() flow. Testing swap-and-pop correctness instead.
      const listUID = await attestList(alice, true, false, 1); // allowsDuplicates
      const signers = await ethers.getSigners();
      const s2 = signers[2];
      const s3 = signers[3];

      const uid1 = await attestAddrEntry(alice, listUID, await s2.getAddress()); // pos 0
      const uid2 = await attestAddrEntry(alice, listUID, await s3.getAddress()); // pos 1

      // Revoke uid1 → swap-and-pop moves uid2 to position 0
      await revokeEntry(alice, uid1);

      // uid2 should still be accessible in the array
      const records = await listEntryResolver.getEntries(listUID, await alice.getAddress(), 0n, 10n);
      expect(records.length).to.equal(1);
      expect(records[0].entryUID).to.equal(uid2);

      // Count for s2 should be 0, s3 should be 1
      const identityKey2 = ethers.zeroPadValue(ethers.toBeHex(BigInt(await s2.getAddress())), 32);
      const identityKey3 = ethers.zeroPadValue(ethers.toBeHex(BigInt(await s3.getAddress())), 32);
      const aliceAddr = await alice.getAddress();
      expect(await listEntryResolver.getMemberCount(listUID, identityKey2, aliceAddr)).to.equal(0n);
      expect(await listEntryResolver.getMemberCount(listUID, identityKey3, aliceAddr)).to.equal(1n);
    });

    it("B17: getLength tracks correctly", async function () {
      const listUID = await attestList(alice, false, false, 1);
      const signers = await ethers.getSigners();
      expect(await listEntryResolver.getLength(listUID, await alice.getAddress())).to.equal(0n);
      const uid1 = await attestAddrEntry(alice, listUID, await signers[2].getAddress());
      expect(await listEntryResolver.getLength(listUID, await alice.getAddress())).to.equal(1n);
      const uid2 = await attestAddrEntry(alice, listUID, await signers[3].getAddress());
      expect(await listEntryResolver.getLength(listUID, await alice.getAddress())).to.equal(2n);
      await revokeEntry(alice, uid1);
      expect(await listEntryResolver.getLength(listUID, await alice.getAddress())).to.equal(1n);
      await revokeEntry(alice, uid2);
      expect(await listEntryResolver.getLength(listUID, await alice.getAddress())).to.equal(0n);
    });

    it("B18: getEntries returns correct EntryRecord page", async function () {
      const listUID = await attestList(alice, false, false, 1);
      const bobAddr = await bob.getAddress();
      const uid = await attestAddrEntry(alice, listUID, bobAddr);
      const records = await listEntryResolver.getEntries(listUID, await alice.getAddress(), 0n, 10n);
      expect(records.length).to.equal(1);
      expect(records[0].entryUID).to.equal(uid);
    });

    it("B19: ListEntryAttested event emitted", async function () {
      // gas-reporter's _handleTruffleV5 can choke on attest receipts in .emit() chains,
      // so we parse the receipt directly instead.
      const listUID = await attestList(alice, false, false, 1);
      const tx = await eas.connect(alice).attest({
        schema: listEntrySchemaUID,
        data: {
          recipient: await bob.getAddress(),
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: ZERO_BYTES32,
          data: encodeEntry(listUID, ZERO_BYTES32),
          value: 0n,
        },
      });
      const receipt = await tx.wait();
      let found = false;
      for (const log of receipt!.logs) {
        try {
          const parsed = listEntryResolver.interface.parseLog(log);
          if (parsed?.name === "ListEntryAttested") {
            found = true;
            break;
          }
        } catch {
          /* ignore */
        }
      }
      expect(found, "ListEntryAttested event not found in receipt").to.be.true;
    });

    it("B20: ListEntryRevoked event emitted", async function () {
      const listUID = await attestList(alice, false, false, 1);
      const uid = await attestAddrEntry(alice, listUID, await bob.getAddress());
      await expect(revokeEntry(alice, uid)).to.emit(listEntryResolver, "ListEntryRevoked");
    });

    it("B21: cross-attester isolation", async function () {
      const listUID = await attestList(alice, false, false, 1);
      const bobAddr = await bob.getAddress();
      await attestAddrEntry(alice, listUID, bobAddr);
      // Bob attests his own entry in the same list — separate lens
      await attestAddrEntry(bob, listUID, bobAddr);
      const identityKey = ethers.zeroPadValue(ethers.toBeHex(BigInt(bobAddr)), 32);
      expect(await listEntryResolver.getMemberCount(listUID, identityKey, await alice.getAddress())).to.equal(1n);
      expect(await listEntryResolver.getMemberCount(listUID, identityKey, await bob.getAddress())).to.equal(1n);
    });

    it("B21b: on-chain attester (lens) index enumerates contributors", async function () {
      const listUID = await attestList(alice, true, false, 1); // allowsDuplicates so both can add same addr
      const aliceAddr = await alice.getAddress();
      const bobAddr = await bob.getAddress();

      // No contributors yet
      expect(await listEntryResolver.getListAttesterCount(listUID)).to.equal(0n);
      expect(await listEntryResolver.getListAttesters(listUID, 0n, 100n)).to.deep.equal([]);

      // Alice contributes → she's the first lens
      await attestAddrEntry(alice, listUID, bobAddr);
      expect(await listEntryResolver.getListAttesters(listUID, 0n, 100n)).to.deep.equal([aliceAddr]);

      // Alice's second entry does NOT duplicate her in the index
      await attestAddrEntry(alice, listUID, aliceAddr);
      expect(await listEntryResolver.getListAttesterCount(listUID)).to.equal(1n);

      // Bob contributes → second lens, appended
      const bobEntry = await attestAddrEntry(bob, listUID, bobAddr);
      expect(await listEntryResolver.getListAttesters(listUID, 0n, 100n)).to.deep.equal([aliceAddr, bobAddr]);

      // Append-only: revoking Bob's only entry does NOT remove him from the index
      // (readers filter by getLength > 0 for "active" lenses).
      await revokeEntry(bob, bobEntry);
      expect(await listEntryResolver.getLength(listUID, bobAddr)).to.equal(0n);
      expect(await listEntryResolver.getListAttesters(listUID, 0n, 100n)).to.deep.equal([aliceAddr, bobAddr]);
    });

    it("B22: cross-list isolation", async function () {
      const list1 = await attestList(alice, false, false, 1);
      const list2 = await attestList(alice, false, false, 1);
      const bobAddr = await bob.getAddress();
      await attestAddrEntry(alice, list1, bobAddr);
      const identityKey = ethers.zeroPadValue(ethers.toBeHex(BigInt(bobAddr)), 32);
      expect(await listEntryResolver.getMemberCount(list1, identityKey, await alice.getAddress())).to.equal(1n);
      expect(await listEntryResolver.getMemberCount(list2, identityKey, await alice.getAddress())).to.equal(0n);
    });

    it("B23: entry pointing at non-LIST UID reverts", async function () {
      // Mint some other attestation (not a LIST)
      const dummyUID = await mintTarget("not-a-list");
      await expect(
        eas.connect(alice).attest({
          schema: listEntrySchemaUID,
          data: {
            recipient: await bob.getAddress(),
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: ZERO_BYTES32,
            data: encodeEntry(dummyUID, ZERO_BYTES32), // dummyUID is not a LIST
            value: 0n,
          },
        }),
      ).to.be.revertedWithCustomError(listEntryResolver, "NotAList");
    });

    it("B24: revocable=false entry reverts", async function () {
      const listUID = await attestList(alice, false, false, 1);
      await expect(
        eas.connect(alice).attest({
          schema: listEntrySchemaUID,
          data: {
            recipient: await bob.getAddress(),
            expirationTime: NO_EXPIRATION,
            revocable: false, // WRONG — entries must be revocable
            refUID: ZERO_BYTES32,
            data: encodeEntry(listUID, ZERO_BYTES32),
            value: 0n,
          },
        }),
      ).to.be.revertedWithCustomError(listEntryResolver, "NotRevocable");
    });

    it("B25: expirationTime != 0 entry reverts", async function () {
      const listUID = await attestList(alice, false, false, 1);
      await expect(
        eas.connect(alice).attest({
          schema: listEntrySchemaUID,
          data: {
            recipient: await bob.getAddress(),
            expirationTime: 9999999999n,
            revocable: true,
            refUID: ZERO_BYTES32,
            data: encodeEntry(listUID, ZERO_BYTES32),
            value: 0n,
          },
        }),
      ).to.be.revertedWithCustomError(listEntryResolver, "HasExpiration");
    });

    it("B26: refUID != 0 entry reverts", async function () {
      const listUID = await attestList(alice, false, false, 1);
      // EAS validates refUID exists before calling resolver — use the listUID itself as valid refUID
      await expect(
        eas.connect(alice).attest({
          schema: listEntrySchemaUID,
          data: {
            recipient: await bob.getAddress(),
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: listUID, // valid UID — EAS accepts, resolver rejects
            data: encodeEntry(listUID, ZERO_BYTES32),
            value: 0n,
          },
        }),
      ).to.be.revertedWithCustomError(listEntryResolver, "UsesRefUID");
    });

    it("B27: a foreign schema pointing at this resolver is rejected (WrongSchema)", async function () {
      // EAS lets anyone register a new schema with this resolver as the target. Register one
      // with a DIFFERENT field string (→ different UID, same resolver, revocable) and attest
      // under it — the resolver must reject it (WrongSchema) instead of mutating membership.
      const evilDef = "bytes32 a, bytes32 b";
      const resolverAddr = await listEntryResolver.getAddress();
      await (await registry.register(evilDef, resolverAddr, true)).wait();
      const evilUID = ethers.solidityPackedKeccak256(["string", "address", "bool"], [evilDef, resolverAddr, true]);
      const listUID = await attestList(alice, true, false, 0); // ANY, dups, uncapped
      await expect(
        eas.connect(alice).attest({
          schema: evilUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: ZERO_BYTES32,
            data: encodeEntry(listUID, ethers.zeroPadValue("0x01", 32)),
            value: 0n,
          },
        }),
      ).to.be.revertedWithCustomError(listEntryResolver, "WrongSchema");
    });
  });

  // ── Group C: ListReader ────────────────────────────────────────────────────

  describe("C — ListReader", function () {
    it("C1: getMode returns correct fields", async function () {
      const listUID = await attestList(alice, false, false, 1, ZERO_BYTES32, 10);
      const mode = await listReader.getMode(listUID);
      expect(mode.exists).to.be.true;
      expect(mode.curator).to.equal(await alice.getAddress());
      expect(mode.allowsDuplicates).to.be.false;
      expect(mode.appendOnly).to.be.false;
      expect(mode.targetType).to.equal(1);
      expect(mode.maxEntries).to.equal(10);
    });

    it("C2: getMode returns exists=false for bytes32(0)", async function () {
      const mode = await listReader.getMode(ZERO_BYTES32);
      expect(mode.exists).to.be.false;
    });

    it("C3: getMode returns exists=false for non-LIST UID", async function () {
      const dummyUID = await mintTarget("not-a-list");
      const mode = await listReader.getMode(dummyUID);
      expect(mode.exists).to.be.false;
    });

    it("C4: getMode works on empty list (zero entries)", async function () {
      const listUID = await attestList(alice, true, false, 0);
      const mode = await listReader.getMode(listUID);
      expect(mode.exists).to.be.true;
      expect(mode.targetType).to.equal(0);
    });

    it("C5: length() correct after adds/removes", async function () {
      const listUID = await attestList(alice, false, false, 1);
      const aliceAddr = await alice.getAddress();
      const signers = await ethers.getSigners();
      expect(await listReader.length(listUID, aliceAddr)).to.equal(0n);
      const uid = await attestAddrEntry(alice, listUID, await signers[2].getAddress());
      expect(await listReader.length(listUID, aliceAddr)).to.equal(1n);
      await revokeEntry(alice, uid);
      expect(await listReader.length(listUID, aliceAddr)).to.equal(0n);
    });

    it("C6: entries() returns Entry[] with denormalized targetType", async function () {
      const listUID = await attestList(alice, false, false, 1); // ADDR
      const bobAddr = await bob.getAddress();
      await attestAddrEntry(alice, listUID, bobAddr);
      const es = await listReader.entries(listUID, await alice.getAddress(), 0n, 10n);
      expect(es.length).to.equal(1);
      expect(es[0].targetType).to.equal(1); // denormalized from LIST
    });

    it("C7: entries() pagination", async function () {
      const listUID = await attestList(alice, true, false, 1); // duplicates allowed
      const signers = await ethers.getSigners();
      await attestAddrEntry(alice, listUID, await signers[2].getAddress());
      const uid2 = await attestAddrEntry(alice, listUID, await signers[3].getAddress());
      const uid3 = await attestAddrEntry(alice, listUID, await signers[4].getAddress());
      const aliceAddr = await alice.getAddress();
      const page = await listReader.entries(listUID, aliceAddr, 1n, 2n);
      expect(page.length).to.equal(2);
      // Pagination returns entries in insertion order; start=1 skips the first.
      expect(page[0].entryUID).to.equal(uid2);
      expect(page[1].entryUID).to.equal(uid3);

      // A huge `len` (e.g. a "read all from start" request) must CLAMP, not revert on
      // `start + len` overflow (getEntries / getListAttesters use `len > total - start`).
      const all = await listEntryResolver.getEntries(listUID, aliceAddr, 1n, ethers.MaxUint256);
      expect(all.length).to.equal(2); // 3 entries, start=1 → clamped to 2
      const att = await listEntryResolver.getListAttesters(listUID, 0n, ethers.MaxUint256);
      expect(att.length).to.equal(1); // alice is the sole attester; no overflow revert
    });

    it("C8: countOf() correct after add/remove", async function () {
      const listUID = await attestList(alice, false, false, 1);
      const bobAddr = await bob.getAddress();
      const identityKey = ethers.zeroPadValue(ethers.toBeHex(BigInt(bobAddr)), 32);
      const aliceAddr = await alice.getAddress();
      expect(await listReader.countOf(listUID, aliceAddr, identityKey)).to.equal(0n);
      const uid = await attestAddrEntry(alice, listUID, bobAddr);
      expect(await listReader.countOf(listUID, aliceAddr, identityKey)).to.equal(1n);
      await revokeEntry(alice, uid);
      expect(await listReader.countOf(listUID, aliceAddr, identityKey)).to.equal(0n);
    });

    it("C9: targetAsAddress() returns correct address", async function () {
      const listUID = await attestList(alice, false, false, 1);
      const bobAddr = await bob.getAddress();
      const uid = await attestAddrEntry(alice, listUID, bobAddr);
      const aliceAddr = await alice.getAddress();
      expect(await listReader.targetAsAddress(listUID, aliceAddr, uid)).to.equal(bobAddr);
    });

    it("C10: targetAsAddress() reverts on SCHEMA list", async function () {
      const listUID = await attestList(alice, false, false, 2, dummySchemaUID);
      const targetUID = await mintTarget("x");
      const uid = await attestSchemaEntry(alice, listUID, targetUID);
      const aliceAddr = await alice.getAddress();
      await expect(listReader.targetAsAddress(listUID, aliceAddr, uid)).to.be.revertedWith("not ADDR-typed list");
    });

    it("C11: targetAsUID() returns correct UID", async function () {
      const listUID = await attestList(alice, false, false, 2, dummySchemaUID);
      const targetUID = await mintTarget("doc");
      const uid = await attestSchemaEntry(alice, listUID, targetUID);
      const aliceAddr = await alice.getAddress();
      expect(await listReader.targetAsUID(listUID, aliceAddr, uid)).to.equal(targetUID);
    });

    it("C12: targetAsMemberKey() returns correct key", async function () {
      const listUID = await attestList(alice, false, false, 0);
      const key = ethers.keccak256(ethers.toUtf8Bytes("milk"));
      const uid = await attestAnyEntry(alice, listUID, key);
      const aliceAddr = await alice.getAddress();
      expect(await listReader.targetAsMemberKey(listUID, aliceAddr, uid)).to.equal(key);
    });

    it("C13: targetAsAddress() reverts for revoked entry", async function () {
      const listUID = await attestList(alice, false, false, 1);
      const uid = await attestAddrEntry(alice, listUID, await bob.getAddress());
      await revokeEntry(alice, uid);
      const aliceAddr = await alice.getAddress();
      await expect(listReader.targetAsAddress(listUID, aliceAddr, uid)).to.be.revertedWith("entry revoked");
    });

    it("C14: targetAsAddress() reverts for wrong lens", async function () {
      const listUID = await attestList(alice, false, false, 1);
      const uid = await attestAddrEntry(alice, listUID, await bob.getAddress());
      // Bob is not the attester of this entry; alice is
      await expect(listReader.targetAsAddress(listUID, await bob.getAddress(), uid)).to.be.revertedWith("wrong lens");
    });
  });
});
