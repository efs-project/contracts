# EFS Lists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement LIST + LIST_ENTRY schemas (ADR-0044) — two new EAS schemas with resolvers that enforce write-time shape constraints (dedup, append-only, typed) and a stateless ListReader view contract.

**Architecture:** ListResolver validates LIST attestation fields only (no state). ListEntryResolver is the enforcement engine with wide EntryRecord[] storage (inline identityKey+weight for O(N) on-chain reads). ListReader is a stateless view contract reading from EAS + ListEntryResolver.

**Tech Stack:** Solidity 0.8.26, Hardhat, EAS SchemaResolver base, TypeScript tests with Chai/Ethers v6

---

## Schema strings (FROZEN — do not change)

```
LIST:       "bool allowsDuplicates, bool appendOnly, uint8 targetType, bytes32 targetSchema, uint32 maxEntries"
            revocable: false
LIST_ENTRY: "bytes32 listUID, bytes32 target, int256 weight"
            revocable: true
```

ABI-encoded lengths: LIST = 160 bytes (5×32), LIST_ENTRY = 96 bytes (3×32)

## Deployment order (test + prod)

```
nonce+0: Deploy ListResolver(eas)
nonce+1: Register LIST schema → LIST_SCHEMA_UID
nonce+2: Register LIST_ENTRY schema (with pre-computed ListEntryResolver addr)
nonce+3: Deploy ListEntryResolver(eas, LIST_SCHEMA_UID)
nonce+4: Deploy ListReader(eas, listEntryResolverAddr, LIST_SCHEMA_UID, LIST_ENTRY_SCHEMA_UID)
```

Pre-computed schema UIDs:
```ts
LIST_SCHEMA_UID = keccak256(LIST_SCHEMA, listResolverAddr, false)
LIST_ENTRY_SCHEMA_UID = keccak256(LIST_ENTRY_SCHEMA, listEntryResolverAddr, true)
```

---

## Task 1: Conformance test (FAILING skeleton)

**Files:**
- Create: `packages/hardhat/test/Lists.conformance.test.ts`

- [ ] **Step 1: Write the complete failing conformance test**

```ts
// packages/hardhat/test/Lists.conformance.test.ts
import { expect } from "chai";
import { ethers } from "hardhat";
import { EAS, SchemaRegistry } from "../typechain-types";
import { Signer, ZeroAddress } from "ethers";

const ZERO_BYTES32 = "0x" + "0".repeat(64);
const NO_EXPIRATION = 0n;
const LIST_SCHEMA = "bool allowsDuplicates, bool appendOnly, uint8 targetType, bytes32 targetSchema, uint32 maxEntries";
const LIST_ENTRY_SCHEMA = "bytes32 listUID, bytes32 target, int256 weight";
const EXPECTED_LIST_DATA_LEN = 160; // 5 × 32
const EXPECTED_ENTRY_DATA_LEN = 96; // 3 × 32

describe("Lists — Conformance (worked example lifecycle)", function () {
  let eas: EAS;
  let registry: SchemaRegistry;
  let alice: Signer; // curator
  let bob: Signer;   // listed address

  let listSchemaUID: string;
  let listEntrySchemaUID: string;
  let listEntryResolverAddr: string;

  const enc = new ethers.AbiCoder();

  const encodeList = (
    allowsDuplicates: boolean, appendOnly: boolean,
    targetType: number, targetSchema: string, maxEntries: number
  ) => enc.encode(["bool","bool","uint8","bytes32","uint32"],
                  [allowsDuplicates, appendOnly, targetType, targetSchema, maxEntries]);

  const encodeEntry = (listUID: string, target: string, weight: bigint) =>
    enc.encode(["bytes32","bytes32","int256"], [listUID, target, weight]);

  const getUID = (receipt: any): string => {
    const iface = eas.interface;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed?.name === "Attested") return parsed.args.uid;
      } catch { /* ignore */ }
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
      ["string","address","bool"], [LIST_SCHEMA, futureListResolverAddr, false]
    );
    listEntrySchemaUID = ethers.solidityPackedKeccak256(
      ["string","address","bool"], [LIST_ENTRY_SCHEMA, listEntryResolverAddr, true]
    );

    const LR = await ethers.getContractFactory("ListResolver");
    const listResolver = await LR.deploy(await eas.getAddress());
    await listResolver.waitForDeployment();
    expect(await listResolver.getAddress()).to.equal(futureListResolverAddr);

    await registry.register(LIST_SCHEMA, await listResolver.getAddress(), false);
    await registry.register(LIST_ENTRY_SCHEMA, listEntryResolverAddr, true);

    const LER = await ethers.getContractFactory("ListEntryResolver");
    const listEntryResolver = await LER.deploy(await eas.getAddress(), listSchemaUID);
    await listEntryResolver.waitForDeployment();
    expect(await listEntryResolver.getAddress()).to.equal(listEntryResolverAddr);
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
        data: encodeEntry(listUID, ZERO_BYTES32, 0n),
        value: 0n,
      },
    });
    const e1UID = getUID(await e1Tx.wait());

    // Verify membership via ListEntryResolver.getMemberCount
    const ler = await ethers.getContractAt("ListEntryResolver", listEntryResolverAddr);
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
          data: encodeEntry(listUID, ZERO_BYTES32, 0n),
          value: 0n,
        },
      })
    ).to.be.revertedWith("duplicate identity");

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
        data: encodeEntry(listUID, ZERO_BYTES32, 0n),
        value: 0n,
      },
    });
    const e3UID = getUID(await e3Tx.wait());
    expect(await ler.getMemberCount(listUID, identityKeyBob, aliceAddr)).to.equal(1n);

    // Step 6: Stale revoke of e1 (already removed) — must be a no-op, not a revert
    await expect(
      eas.connect(alice).revoke({ schema: listEntrySchemaUID, data: { uid: e1UID, value: 0n } })
    ).to.not.be.reverted;
    // State unchanged after stale revoke
    expect(await ler.getMemberCount(listUID, identityKeyBob, aliceAddr)).to.equal(1n);

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
        data: encodeEntry(listUID, ZERO_BYTES32, 0n),
        value: 0n,
      },
    });
    const eUID = getUID(await eTx.wait());
    const ler = await ethers.getContractAt("ListEntryResolver", listEntryResolverAddr);

    expect(await ler.getMemberCount(listUID, ZERO_BYTES32, aliceAddr)).to.equal(1n);
    expect(await ler.getLength(listUID, aliceAddr)).to.equal(1n);

    // Revoke and verify cleanup
    await eas.connect(alice).revoke({ schema: listEntrySchemaUID, data: { uid: eUID, value: 0n } });
    expect(await ler.getMemberCount(listUID, ZERO_BYTES32, aliceAddr)).to.equal(0n);
  });
});
```

- [ ] **Step 2: Verify it fails to compile (contracts don't exist yet)**

```bash
cd /Users/james/Code/Claude/contracts/.claude/worktrees/zen-wozniak-493b4b/packages/hardhat
npx hardhat compile 2>&1 | head -20
```

Expected: compilation errors about missing contracts.

- [ ] **Step 3: Commit the failing test**

```bash
git add packages/hardhat/test/Lists.conformance.test.ts
git commit -m "$(cat <<'EOF'
test(lists): add conformance test — failing until resolvers implemented

Port the worked-example lifecycle from designs/custom-lists.md verbatim:
attest LIST → attest entry → dup-reject → revoke → re-add → stale-revoke no-op.
Adds the address(0) / identityKey==bytes32(0) vector from the design doc.

Permanence-tier: Etched
Refs: ADR-0044

Co-authored-by: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: ListResolver.sol (field validation, no state)

**Files:**
- Create: `packages/hardhat/contracts/ListResolver.sol`

- [ ] **Step 1: Write ListResolver.sol**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { SchemaResolver } from "@ethereum-attestation-service/eas-contracts/contracts/resolver/SchemaResolver.sol";
import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";

/**
 * @title ListResolver
 * @dev Resolver for the EFS LIST schema (ADR-0044). Validates field shape at attest time.
 *      Maintains no state — all enforcement state lives in ListEntryResolver.
 *
 *      LIST schema: "bool allowsDuplicates, bool appendOnly, uint8 targetType, bytes32 targetSchema, uint32 maxEntries"
 *      revocable: false (LIST is permanent — identity of a list, like DATA)
 */
contract ListResolver is SchemaResolver {
    uint256 private constant EXPECTED_LIST_DATA_LEN = 160; // 5 × 32

    event ListAttested(
        bytes32 indexed listUID,
        address indexed attester,
        bool    allowsDuplicates,
        bool    appendOnly,
        uint8   indexed targetType,
        bytes32 targetSchema,
        uint32  maxEntries
    );

    constructor(IEAS eas) SchemaResolver(eas) {}

    function onAttest(Attestation calldata a, uint256) internal override returns (bool) {
        require(a.data.length == EXPECTED_LIST_DATA_LEN, "bad LIST payload");
        require(!a.revocable,               "LIST must be non-revocable");
        require(a.expirationTime == 0,      "LIST must not expire");
        require(a.refUID == bytes32(0),     "LIST must be free-floating");
        require(a.recipient == address(0),  "LIST must not be directed");

        (
            bool allowsDuplicates,
            bool appendOnly,
            uint8 targetType,
            bytes32 targetSchema,
            uint32 maxEntries
        ) = abi.decode(a.data, (bool, bool, uint8, bytes32, uint32));

        require(targetType <= 2, "invalid targetType");

        if (targetType == 2 /* SCHEMA */) {
            require(targetSchema != bytes32(0), "SCHEMA mode requires targetSchema");
        } else {
            require(targetSchema == bytes32(0), "non-SCHEMA mode must have zero targetSchema");
        }

        // Reject the only unbounded combination: append-only + duplicates-allowed + uncapped
        if (appendOnly && allowsDuplicates) {
            require(maxEntries != 0, "appendOnly+allowsDuplicates requires maxEntries cap");
        }

        emit ListAttested(a.uid, a.attester, allowsDuplicates, appendOnly, targetType, targetSchema, maxEntries);
        return true;
    }

    // onRevoke is unreachable — LIST is non-revocable. Implemented to satisfy abstract base.
    function onRevoke(Attestation calldata, uint256) internal override returns (bool) {
        return true;
    }
}
```

- [ ] **Step 2: Compile**

```bash
cd /Users/james/Code/Claude/contracts/.claude/worktrees/zen-wozniak-493b4b/packages/hardhat
npx hardhat compile 2>&1 | tail -5
```

Expected: compiles cleanly (test still fails — ListEntryResolver missing).

- [ ] **Step 3: Commit**

```bash
git add packages/hardhat/contracts/ListResolver.sol
git commit -m "$(cat <<'EOF'
feat(lists): add ListResolver — LIST schema field validation

Validates: non-revocable, no expiry, free-floating, not directed,
targetType<=2, (targetType,targetSchema) coherence, rejects
appendOnly+allowsDuplicates+uncapped. Emits ListAttested.

Permanence-tier: Etched
Refs: ADR-0044

Co-authored-by: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: ListEntryResolver.sol (enforcement engine)

**Files:**
- Create: `packages/hardhat/contracts/ListEntryResolver.sol`

- [ ] **Step 1: Write ListEntryResolver.sol**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { SchemaResolver } from "@ethereum-attestation-service/eas-contracts/contracts/resolver/SchemaResolver.sol";
import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";

/**
 * @title ListEntryResolver
 * @dev Resolver for the EFS LIST_ENTRY schema (ADR-0044). Write-time enforcement engine.
 *
 *      LIST_ENTRY schema: "bytes32 listUID, bytes32 target, int256 weight"
 *      revocable: true (rejected by resolver when LIST.appendOnly == true)
 *
 *      Storage is "wide" — EntryRecord[] stores identityKey+weight inline so on-chain
 *      consumers iterate without per-entry eas.getAttestation(). Mirrors ADR-0041's
 *      TagEntry[] widening for the same block-gas-limit reason.
 *
 *      Per-mode encoding (enforced at write time):
 *        ADDR (1): recipient = address (incl. 0); target must be bytes32(0)
 *        SCHEMA (2): target = attestation UID (must exist, schema must match); recipient = 0
 *        ANY (0):  target = opaque nonzero bytes32 member key; recipient = 0
 */
contract ListEntryResolver is SchemaResolver {
    // ── Errors ──────────────────────────────────────────────────────────────────
    error BadPayload();
    error NotRevocable();
    error HasExpiration();
    error UsesRefUID();
    error MissingListUID();
    error NotAList();
    error BadAddrMode();
    error BadRecipient();
    error BadSchemaTarget();
    error TargetMissing();
    error TargetSchemaMismatch();
    error BadAnyTarget();
    error DuplicateIdentity();
    error ListFull();
    error ListIsAppendOnly();
    error UnknownList();

    // ── Events ──────────────────────────────────────────────────────────────────
    event ListEntryAttested(
        bytes32 indexed listUID,
        address indexed attester,
        bytes32 indexed identityKey,
        bytes32 entryUID,
        uint8   targetType,
        int256  weight
    );

    event ListEntryRevoked(
        bytes32 indexed listUID,
        address indexed attester,
        bytes32 indexed identityKey,
        bytes32 entryUID,
        uint8   targetType
    );

    // ── Constants ───────────────────────────────────────────────────────────────
    uint256 private constant EXPECTED_ENTRY_DATA_LEN = 96; // 3 × 32
    bytes32 public immutable LIST_SCHEMA_UID;

    // ── Storage: LIST declaration cache ─────────────────────────────────────────
    struct CachedListDecl {
        bool    exists;
        bool    allowsDuplicates;
        bool    appendOnly;
        uint8   targetType;
        bytes32 targetSchema;
        uint32  maxEntries;
    }

    // LIST is non-revocable → cache is valid forever after first touch
    mapping(bytes32 listUID => CachedListDecl) private _decl;

    // ── Storage: Wide entry records ──────────────────────────────────────────────
    // identityKey semantics:
    //   ADDR:   bytes32(uint256(uint160(recipient)))  ← zero if address(0), valid
    //   SCHEMA: target (the attestation UID)
    //   ANY:    target (the opaque member key, nonzero)
    struct EntryRecord {
        bytes32 entryUID;
        bytes32 identityKey;
        int256  weight;
    }

    mapping(bytes32 listUID => mapping(address attester => EntryRecord[])) private _entries;

    // O(1) membership + no-dupes counter
    mapping(bytes32 listUID => mapping(bytes32 identityKey => mapping(address attester => uint256))) private _entryCount;

    // Swap-and-pop index: entryUID → (position in _entries[list][attester]) + 1
    mapping(bytes32 entryUID => uint256) private _entryPosPlusOne;

    // ── Constructor ─────────────────────────────────────────────────────────────
    constructor(IEAS eas, bytes32 listSchemaUID) SchemaResolver(eas) {
        require(listSchemaUID != bytes32(0), "listSchemaUID is zero");
        LIST_SCHEMA_UID = listSchemaUID;
    }

    // ── Resolver hooks ──────────────────────────────────────────────────────────

    function onAttest(Attestation calldata a, uint256) internal override returns (bool) {
        if (a.data.length != EXPECTED_ENTRY_DATA_LEN) revert BadPayload();

        // Lifecycle invariants (ADR-0044, closes external review BLOCKING B3)
        if (!a.revocable)         revert NotRevocable();
        if (a.expirationTime != 0) revert HasExpiration();
        if (a.refUID != bytes32(0)) revert UsesRefUID();

        (bytes32 listUID, bytes32 target, int256 weight) =
            abi.decode(a.data, (bytes32, bytes32, int256));
        if (listUID == bytes32(0)) revert MissingListUID();

        // Hydrate + cache LIST declaration (LIST is immutable; cache valid forever)
        CachedListDecl memory d = _decl[listUID];
        if (!d.exists) {
            Attestation memory L = _eas.getAttestation(listUID);
            if (L.schema != LIST_SCHEMA_UID) revert NotAList();
            (d.allowsDuplicates, d.appendOnly, d.targetType, d.targetSchema, d.maxEntries) =
                abi.decode(L.data, (bool, bool, uint8, bytes32, uint32));
            d.exists = true;
            _decl[listUID] = d;
        }

        // Per-mode encoding + identity-key derivation
        bytes32 identityKey;

        if (d.targetType == 1 /* ADDR */) {
            if (target != bytes32(0)) revert BadAddrMode(); // address lives in recipient
            // address(0) is a valid ADDR entry — identityKey = bytes32(0) is permitted
            identityKey = bytes32(uint256(uint160(a.recipient)));

        } else if (d.targetType == 2 /* SCHEMA */) {
            if (a.recipient != address(0)) revert BadRecipient();
            if (target == bytes32(0))      revert BadSchemaTarget();
            Attestation memory t = _eas.getAttestation(target);
            if (t.uid == bytes32(0))       revert TargetMissing();
            if (t.schema != d.targetSchema) revert TargetSchemaMismatch();
            // No revocation check — entries are immune to target lifecycle (ADR-0044)
            identityKey = target;

        } else /* ANY (0) */ {
            if (a.recipient != address(0)) revert BadRecipient();
            if (target == bytes32(0))      revert BadAnyTarget(); // must be nonzero member key
            identityKey = target;
        }

        // No-duplicates enforcement (per-attester lens)
        if (!d.allowsDuplicates) {
            if (_entryCount[listUID][identityKey][a.attester] != 0) revert DuplicateIdentity();
        }

        // Cap enforcement (per-attester)
        if (d.maxEntries != 0) {
            if (_entries[listUID][a.attester].length >= d.maxEntries) revert ListFull();
        }

        // Append wide record + index
        _entries[listUID][a.attester].push(EntryRecord({
            entryUID:    a.uid,
            identityKey: identityKey,
            weight:      weight
        }));
        _entryPosPlusOne[a.uid] = _entries[listUID][a.attester].length;
        _entryCount[listUID][identityKey][a.attester] += 1;

        emit ListEntryAttested(listUID, a.attester, identityKey, a.uid, d.targetType, weight);
        return true;
    }

    function onRevoke(Attestation calldata a, uint256) internal override returns (bool) {
        if (a.data.length != EXPECTED_ENTRY_DATA_LEN) revert BadPayload();

        // Idempotency check FIRST — stale revoke (entryUID not indexed) → silent no-op
        uint256 pp1 = _entryPosPlusOne[a.uid];
        if (pp1 == 0) return true;

        (bytes32 listUID, , ) = abi.decode(a.data, (bytes32, bytes32, int256));

        CachedListDecl memory d = _decl[listUID];
        if (!d.exists) revert UnknownList(); // should never fire — onAttest ran first

        // Append-only: reject revocation entirely
        if (d.appendOnly) revert ListIsAppendOnly();

        // Swap-and-pop. Read identityKey inline from array record — no side map needed.
        uint256 idx = pp1 - 1;
        EntryRecord[] storage arr = _entries[listUID][a.attester];
        bytes32 identityKey = arr[idx].identityKey;
        uint256 last = arr.length - 1;
        if (idx != last) {
            arr[idx] = arr[last];
            _entryPosPlusOne[arr[idx].entryUID] = idx + 1;
        }
        arr.pop();
        delete _entryPosPlusOne[a.uid];
        _entryCount[listUID][identityKey][a.attester] -= 1;

        emit ListEntryRevoked(listUID, a.attester, identityKey, a.uid, d.targetType);
        return true;
    }

    // ── View functions (used by ListReader) ─────────────────────────────────────

    function getLength(bytes32 listUID, address attester) external view returns (uint256) {
        return _entries[listUID][attester].length;
    }

    function getEntries(
        bytes32 listUID,
        address attester,
        uint256 start,
        uint256 len
    ) external view returns (EntryRecord[] memory) {
        EntryRecord[] storage arr = _entries[listUID][attester];
        uint256 total = arr.length;
        if (total == 0 || start >= total) return new EntryRecord[](0);
        if (start + len > total) len = total - start;
        EntryRecord[] memory res = new EntryRecord[](len);
        for (uint256 i = 0; i < len; i++) res[i] = arr[start + i];
        return res;
    }

    function getMemberCount(
        bytes32 listUID,
        bytes32 identityKey,
        address attester
    ) external view returns (uint256) {
        return _entryCount[listUID][identityKey][attester];
    }
}
```

- [ ] **Step 2: Compile**

```bash
cd /Users/james/Code/Claude/contracts/.claude/worktrees/zen-wozniak-493b4b/packages/hardhat
npx hardhat compile 2>&1 | tail -5
```

Expected: compiles cleanly.

- [ ] **Step 3: Run conformance test**

```bash
cd /Users/james/Code/Claude/contracts/.claude/worktrees/zen-wozniak-493b4b/packages/hardhat
npx hardhat test test/Lists.conformance.test.ts --network hardhat 2>&1 | tail -20
```

Expected: both tests pass.

- [ ] **Step 4: Run full existing suite (no regressions)**

```bash
cd /Users/james/Code/Claude/contracts/.claude/worktrees/zen-wozniak-493b4b/packages/hardhat
npx hardhat test --network hardhat 2>&1 | tail -10
```

Expected: all pre-existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/hardhat/contracts/ListEntryResolver.sol
git commit -m "$(cat <<'EOF'
feat(lists): add ListEntryResolver — write-time enforcement engine

Wide EntryRecord[] storage (entryUID, identityKey, weight inline) for O(N)
on-chain iteration without per-entry eas.getAttestation(). Enforces: lifecycle
invariants (revocable, expirationTime, refUID), per-mode encoding (ADDR via
recipient, SCHEMA via target+schema match, ANY via nonzero opaque key),
no-dupes via _entryCount, cap via maxEntries, append-only via onRevoke reject.
Idempotent stale revokes. Conformance test passes.

Permanence-tier: Etched
Refs: ADR-0044

Co-authored-by: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: IListReader.sol + ListReader.sol

**Files:**
- Create: `packages/hardhat/contracts/interfaces/IListReader.sol`
- Create: `packages/hardhat/contracts/ListReader.sol`

- [ ] **Step 1: Write IListReader.sol**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IListReader {
    struct ListMode {
        bool    exists;
        address curator;       // LIST.attester
        bool    allowsDuplicates;
        bool    appendOnly;
        uint8   targetType;    // 0=ANY, 1=ADDR, 2=SCHEMA
        bytes32 targetSchema;  // nonzero iff targetType==SCHEMA
        uint32  maxEntries;
    }

    struct Entry {
        bytes32 entryUID;
        uint8   targetType;    // denormalized from LIST.targetType
        bytes32 identityKey;   // recipient(ADDR), UID(SCHEMA), member-key(ANY)
        int256  weight;
    }

    /// Decode LIST attestation directly from EAS. Schema-checked BEFORE data decode.
    /// Works for empty lists. Returns exists=false for non-LIST UIDs.
    function getMode(bytes32 listUID) external view returns (ListMode memory);

    /// Number of active entries for (list, attester). O(1).
    function length(bytes32 listUID, address attester) external view returns (uint256);

    /// Page of active entries (insertion order). No per-entry eas.getAttestation() —
    /// all fields read inline from EntryRecord[]. Pagination is NOT snapshot-isolated.
    function entries(bytes32 listUID, address attester, uint256 start, uint256 len)
        external view returns (Entry[] memory);

    /// O(1) membership check. Compare to 0 explicitly — no isMember bool (ADR-0044 §5).
    /// identityKey: bytes32(uint160(addr)) for ADDR, UID for SCHEMA, member key for ANY.
    function countOf(bytes32 listUID, address attester, bytes32 identityKey)
        external view returns (uint256);

    // ── Typed accessors (safe-by-construction) ──────────────────────────────────
    // Each requires: LIST_ENTRY schema, attester==curator, active, entryListUID==listUID, mode match.
    // curator must come from getMode().curator or a contract constant, NEVER from caller.

    function targetAsAddress(bytes32 listUID, address curator, bytes32 entryUID)
        external view returns (address);

    function targetAsUID(bytes32 listUID, address curator, bytes32 entryUID)
        external view returns (bytes32);

    function targetAsMemberKey(bytes32 listUID, address curator, bytes32 entryUID)
        external view returns (bytes32);

    // ── Identity-key derivation helpers (pure) ──────────────────────────────────
    function identityKeyForAddress(address a) external pure returns (bytes32);
    function identityKeyForUID(bytes32 uid)   external pure returns (bytes32);
    function identityKeyForMemberKey(bytes32 k) external pure returns (bytes32);
}
```

- [ ] **Step 2: Write ListReader.sol**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { IListReader } from "./interfaces/IListReader.sol";
import { ListEntryResolver } from "./ListEntryResolver.sol";

/**
 * @title ListReader
 * @dev Stateless view contract over ListEntryResolver + EAS. Redeployable without
 *      changing any schema UID (address not baked into any schema). ADR-0044 §5.
 *
 *      getMode() reads LIST attestation directly from EAS (schema-check BEFORE decode).
 *      entries() reads EntryRecord[] from resolver storage — zero per-entry EAS calls.
 *      Typed accessors are safe-by-construction: validate schema, curator, active, listUID, mode.
 */
contract ListReader is IListReader {
    IEAS public immutable eas;
    ListEntryResolver public immutable resolver;
    bytes32 public immutable LIST_SCHEMA_UID;
    bytes32 public immutable LIST_ENTRY_SCHEMA_UID;

    constructor(
        IEAS _eas,
        ListEntryResolver _resolver,
        bytes32 listSchemaUID,
        bytes32 listEntrySchemaUID
    ) {
        require(address(_eas) != address(0),      "eas is zero");
        require(address(_resolver) != address(0), "resolver is zero");
        require(listSchemaUID != bytes32(0),       "listSchemaUID is zero");
        require(listEntrySchemaUID != bytes32(0),  "listEntrySchemaUID is zero");
        eas             = _eas;
        resolver        = _resolver;
        LIST_SCHEMA_UID = listSchemaUID;
        LIST_ENTRY_SCHEMA_UID = listEntrySchemaUID;
    }

    // ── IListReader implementation ───────────────────────────────────────────────

    function getMode(bytes32 listUID) external view override returns (ListMode memory m) {
        Attestation memory L = eas.getAttestation(listUID);
        // Schema-check BEFORE data decode (closes SF2 — prevents fake-mode attack)
        if (L.uid == bytes32(0) || L.schema != LIST_SCHEMA_UID) {
            return m; // exists=false (zero struct)
        }
        (m.allowsDuplicates, m.appendOnly, m.targetType, m.targetSchema, m.maxEntries) =
            abi.decode(L.data, (bool, bool, uint8, bytes32, uint32));
        m.exists  = true;
        m.curator = L.attester;
    }

    function length(bytes32 listUID, address attester) external view override returns (uint256) {
        return resolver.getLength(listUID, attester);
    }

    function entries(
        bytes32 listUID,
        address attester,
        uint256 start,
        uint256 len
    ) external view override returns (Entry[] memory) {
        // Need targetType from LIST for denormalization
        Attestation memory L = eas.getAttestation(listUID);
        uint8 targetType = 0;
        if (L.uid != bytes32(0) && L.schema == LIST_SCHEMA_UID) {
            (, , targetType, , ) = abi.decode(L.data, (bool, bool, uint8, bytes32, uint32));
        }

        ListEntryResolver.EntryRecord[] memory raw = resolver.getEntries(listUID, attester, start, len);
        Entry[] memory res = new Entry[](raw.length);
        for (uint256 i = 0; i < raw.length; i++) {
            res[i] = Entry({
                entryUID:    raw[i].entryUID,
                targetType:  targetType,
                identityKey: raw[i].identityKey,
                weight:      raw[i].weight
            });
        }
        return res;
    }

    function countOf(
        bytes32 listUID,
        address attester,
        bytes32 identityKey
    ) external view override returns (uint256) {
        return resolver.getMemberCount(listUID, identityKey, attester);
    }

    // ── Typed accessors ──────────────────────────────────────────────────────────

    function targetAsAddress(
        bytes32 listUID,
        address curator,
        bytes32 entryUID
    ) external view override returns (address) {
        Attestation memory e = _validateEntry(listUID, curator, entryUID);
        (, , uint8 mode) = _getListMode(listUID);
        require(mode == 1, "not ADDR-typed list");
        // For ADDR mode, identityKey = bytes32(uint160(recipient)); recipient is in e.recipient
        return e.recipient;
    }

    function targetAsUID(
        bytes32 listUID,
        address curator,
        bytes32 entryUID
    ) external view override returns (bytes32) {
        Attestation memory e = _validateEntry(listUID, curator, entryUID);
        (, , uint8 mode) = _getListMode(listUID);
        require(mode == 2, "not SCHEMA-typed list");
        (, bytes32 target, ) = abi.decode(e.data, (bytes32, bytes32, int256));
        return target;
    }

    function targetAsMemberKey(
        bytes32 listUID,
        address curator,
        bytes32 entryUID
    ) external view override returns (bytes32) {
        Attestation memory e = _validateEntry(listUID, curator, entryUID);
        (, , uint8 mode) = _getListMode(listUID);
        require(mode == 0, "not ANY-typed list");
        (, bytes32 target, ) = abi.decode(e.data, (bytes32, bytes32, int256));
        return target;
    }

    // ── Identity-key helpers ─────────────────────────────────────────────────────

    function identityKeyForAddress(address a) external pure override returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function identityKeyForUID(bytes32 uid) external pure override returns (bytes32) {
        return uid;
    }

    function identityKeyForMemberKey(bytes32 k) external pure override returns (bytes32) {
        return k;
    }

    // ── Internal helpers ─────────────────────────────────────────────────────────

    /// @dev Validates a single LIST_ENTRY attestation. Reverts unless:
    ///      1. schema == LIST_ENTRY_SCHEMA_UID
    ///      2. attester == curator (trusted lens)
    ///      3. revocationTime == 0 (active)
    ///      4. decoded entryListUID == listUID (belongs to this list)
    function _validateEntry(
        bytes32 listUID,
        address curator,
        bytes32 entryUID
    ) internal view returns (Attestation memory e) {
        e = eas.getAttestation(entryUID);
        require(e.schema == LIST_ENTRY_SCHEMA_UID, "not a list entry");
        require(e.attester == curator,             "wrong curator lens");
        require(e.revocationTime == 0,             "entry revoked");
        (bytes32 entryListUID, , ) = abi.decode(e.data, (bytes32, bytes32, int256));
        require(entryListUID == listUID,            "entry not in this list");
    }

    /// @dev Read targetType from LIST attestation.
    function _getListMode(bytes32 listUID) internal view returns (bool, bool, uint8) {
        Attestation memory L = eas.getAttestation(listUID);
        require(L.uid != bytes32(0) && L.schema == LIST_SCHEMA_UID, "not a list");
        (bool allowsDups, bool appendOnly, uint8 targetType, , ) =
            abi.decode(L.data, (bool, bool, uint8, bytes32, uint32));
        return (allowsDups, appendOnly, targetType);
    }
}
```

- [ ] **Step 3: Compile**

```bash
cd /Users/james/Code/Claude/contracts/.claire/worktrees/zen-wozniak-493b4b/packages/hardhat
npx hardhat compile 2>&1 | tail -5
```

Expected: compiles cleanly.

- [ ] **Step 4: Commit**

```bash
git add packages/hardhat/contracts/interfaces/IListReader.sol packages/hardhat/contracts/ListReader.sol
git commit -m "$(cat <<'EOF'
feat(lists): add IListReader interface + ListReader stateless view contract

getMode() schema-checks before decode (closes SF2 anti-fake-mode attack).
entries() reads EntryRecord[] inline — zero per-entry EAS calls.
Typed accessors validate schema+curator+active+listUID+mode (closes
same-list wrong-lens injection). countOf() only (no isMember bool).

Permanence-tier: Etched (ABI — do not change without new schema UID)
Refs: ADR-0044

Co-authored-by: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Full unit tests

**Files:**
- Create: `packages/hardhat/test/Lists.unit.test.ts`

- [ ] **Step 1: Write comprehensive unit tests**

Tests must cover (write them all in this file):

**Group A — ListResolver (LIST schema validation)**
- A1: valid LIST (ADDR-typed) attests successfully
- A2: valid LIST (SCHEMA-typed with targetSchema) attests
- A3: valid LIST (ANY-typed) attests
- A4: revocable=true reverts ("LIST must be non-revocable")
- A5: expirationTime != 0 reverts
- A6: refUID != 0 reverts
- A7: recipient != 0 reverts
- A8: targetType > 2 reverts
- A9: SCHEMA-typed with zero targetSchema reverts
- A10: non-SCHEMA with nonzero targetSchema reverts
- A11: appendOnly+allowsDuplicates+maxEntries==0 reverts
- A12: appendOnly+allowsDuplicates+maxEntries>0 succeeds
- A13: ListAttested event emitted with correct args

**Group B — ListEntryResolver (enforcement)**
- B1: ADDR entry (recipient=addr, target=0) attests and increments count
- B2: ADDR entry with address(0) — valid
- B3: ADDR entry with nonzero target reverts ("bad addr mode")
- B4: SCHEMA entry (target=UID, schema match) attests
- B5: SCHEMA entry target missing reverts
- B6: SCHEMA entry schema mismatch reverts
- B7: SCHEMA entry with nonzero recipient reverts
- B8: ANY entry (target=nonzero key) attests
- B9: ANY entry with zero target reverts
- B10: ANY entry with nonzero recipient reverts
- B11: no-dupes: second ADDR entry with same recipient reverts
- B12: duplicates allowed: second entry succeeds
- B13: cap enforcement: exceeding maxEntries reverts
- B14: append-only: revoke reverts
- B15: non-append-only: revoke succeeds, count decrements
- B16: stale revoke (twice): second revoke is no-op (not revert)
- B17: getLength tracks correctly through add/remove
- B18: getEntries returns correct EntryRecord page
- B19: ListEntryAttested event emitted
- B20: ListEntryRevoked event emitted
- B21: cross-attester isolation: alice's count unaffected by bob's entry
- B22: cross-list isolation: entry in list1 doesn't affect list2 count
- B23: LIST with wrong schema reverts ("not a list")
- B24: revocable=false entry reverts ("must be revocable")
- B25: expirationTime != 0 entry reverts
- B26: refUID != 0 entry reverts

**Group C — ListReader**
- C1: getMode returns correct fields for valid LIST
- C2: getMode returns exists=false for bytes32(0)
- C3: getMode returns exists=false for non-LIST UID
- C4: getMode works on LIST with zero entries (empty list)
- C5: length() correct after adds/removes
- C6: entries() returns Entry[] with denormalized targetType
- C7: entries() pagination (start/len)
- C8: countOf() correct after add/remove
- C9: targetAsAddress() returns correct address for ADDR entry
- C10: targetAsAddress() reverts on SCHEMA-typed list
- C11: targetAsUID() returns correct UID for SCHEMA entry
- C12: targetAsMemberKey() returns correct key for ANY entry
- C13: targetAsAddress() reverts for revoked entry
- C14: targetAsAddress() reverts for wrong curator

Write the test file with a beforeEach that sets up ListResolver, ListEntryResolver, ListReader similarly to the conformance test, plus additional helpers for each schema type. Full code required — no placeholders.

Template structure (expand with all test cases):

```ts
import { expect } from "chai";
import { ethers } from "hardhat";
import { ListResolver, ListEntryResolver, ListReader, EAS, SchemaRegistry } from "../typechain-types";
import { Signer, ZeroAddress } from "ethers";

const ZERO_BYTES32 = "0x" + "0".repeat(64);
const NO_EXPIRATION = 0n;
const LIST_SCHEMA = "bool allowsDuplicates, bool appendOnly, uint8 targetType, bytes32 targetSchema, uint32 maxEntries";
const LIST_ENTRY_SCHEMA = "bytes32 listUID, bytes32 target, int256 weight";

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
  const encodeList = (ad: boolean, ao: boolean, tt: number, ts: string, me: number) =>
    enc.encode(["bool","bool","uint8","bytes32","uint32"], [ad, ao, tt, ts, me]);
  const encodeEntry = (lu: string, t: string, w: bigint) =>
    enc.encode(["bytes32","bytes32","int256"], [lu, t, w]);

  const getUID = (receipt: any): string => {
    for (const log of receipt.logs) {
      try {
        const p = eas.interface.parseLog(log);
        if (p?.name === "Attested") return p.args.uid;
      } catch {}
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

    // nonce+0: ListResolver, +1: LIST reg, +2: LIST_ENTRY reg, +3: dummy schema reg, +4: ListEntryResolver
    const n = await ethers.provider.getTransactionCount(aliceAddr);
    const futureListResolverAddr = ethers.getCreateAddress({ from: aliceAddr, nonce: n });
    const futureListEntryResolverAddr = ethers.getCreateAddress({ from: aliceAddr, nonce: n + 4 });

    listSchemaUID = ethers.solidityPackedKeccak256(
      ["string","address","bool"], [LIST_SCHEMA, futureListResolverAddr, false]
    );
    listEntrySchemaUID = ethers.solidityPackedKeccak256(
      ["string","address","bool"], [LIST_ENTRY_SCHEMA, futureListEntryResolverAddr, true]
    );

    const LRF = await ethers.getContractFactory("ListResolver");
    listResolver = await LRF.deploy(await eas.getAddress());
    await listResolver.waitForDeployment();

    await registry.register(LIST_SCHEMA, await listResolver.getAddress(), false);
    await registry.register(LIST_ENTRY_SCHEMA, futureListEntryResolverAddr, true);

    // dummy schema for SCHEMA-mode target attestations
    const dummyTx = await registry.register("string label", ZeroAddress, false);
    dummySchemaUID = (await dummyTx.wait())!.logs[0].topics[1];

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
    maxEntries = 0
  ): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: listSchemaUID,
      data: {
        recipient: ZeroAddress, expirationTime: NO_EXPIRATION,
        revocable: false, refUID: ZERO_BYTES32,
        data: encodeList(allowsDuplicates, appendOnly, targetType, targetSchema, maxEntries),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  const attestAddrEntry = async (
    signer: Signer, listUID: string, addr: string, weight = 0n
  ): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: listEntrySchemaUID,
      data: {
        recipient: addr, expirationTime: NO_EXPIRATION,
        revocable: true, refUID: ZERO_BYTES32,
        data: encodeEntry(listUID, ZERO_BYTES32, weight),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  const attestAnyEntry = async (
    signer: Signer, listUID: string, memberKey: string, weight = 0n
  ): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: listEntrySchemaUID,
      data: {
        recipient: ZeroAddress, expirationTime: NO_EXPIRATION,
        revocable: true, refUID: ZERO_BYTES32,
        data: encodeEntry(listUID, memberKey, weight),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  const mintTarget = async (label: string): Promise<string> => {
    const tx = await eas.connect(alice).attest({
      schema: dummySchemaUID,
      data: {
        recipient: ZeroAddress, expirationTime: NO_EXPIRATION,
        revocable: false, refUID: ZERO_BYTES32,
        data: enc.encode(["string"], [label]), value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  const attestSchemaEntry = async (
    signer: Signer, listUID: string, targetUID: string, weight = 0n
  ): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: listEntrySchemaUID,
      data: {
        recipient: ZeroAddress, expirationTime: NO_EXPIRATION,
        revocable: true, refUID: ZERO_BYTES32,
        data: encodeEntry(listUID, targetUID, weight),
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
      await expect(eas.connect(alice).attest({
        schema: listSchemaUID,
        data: {
          recipient: ZeroAddress, expirationTime: NO_EXPIRATION,
          revocable: true, // WRONG
          refUID: ZERO_BYTES32,
          data: encodeList(false, false, 1, ZERO_BYTES32, 0),
          value: 0n,
        },
      })).to.be.revertedWith("LIST must be non-revocable");
    });

    it("A5: expirationTime != 0 reverts", async function () {
      await expect(eas.connect(alice).attest({
        schema: listSchemaUID,
        data: {
          recipient: ZeroAddress, expirationTime: 9999999999n,
          revocable: false, refUID: ZERO_BYTES32,
          data: encodeList(false, false, 1, ZERO_BYTES32, 0),
          value: 0n,
        },
      })).to.be.revertedWith("LIST must not expire");
    });

    it("A6: refUID != 0 reverts", async function () {
      const someUID = ethers.keccak256(ethers.toUtf8Bytes("dummy"));
      await expect(eas.connect(alice).attest({
        schema: listSchemaUID,
        data: {
          recipient: ZeroAddress, expirationTime: NO_EXPIRATION,
          revocable: false, refUID: someUID, // WRONG
          data: encodeList(false, false, 1, ZERO_BYTES32, 0),
          value: 0n,
        },
      })).to.be.revertedWith("LIST must be free-floating");
    });

    it("A7: recipient != 0 reverts", async function () {
      await expect(eas.connect(alice).attest({
        schema: listSchemaUID,
        data: {
          recipient: await alice.getAddress(), // WRONG
          expirationTime: NO_EXPIRATION,
          revocable: false, refUID: ZERO_BYTES32,
          data: encodeList(false, false, 1, ZERO_BYTES32, 0),
          value: 0n,
        },
      })).to.be.revertedWith("LIST must not be directed");
    });

    it("A8: targetType > 2 reverts", async function () {
      await expect(eas.connect(alice).attest({
        schema: listSchemaUID,
        data: {
          recipient: ZeroAddress, expirationTime: NO_EXPIRATION,
          revocable: false, refUID: ZERO_BYTES32,
          data: encodeList(false, false, 3, ZERO_BYTES32, 0), // targetType=3 invalid
          value: 0n,
        },
      })).to.be.revertedWith("invalid targetType");
    });

    it("A9: SCHEMA-typed with zero targetSchema reverts", async function () {
      await expect(eas.connect(alice).attest({
        schema: listSchemaUID,
        data: {
          recipient: ZeroAddress, expirationTime: NO_EXPIRATION,
          revocable: false, refUID: ZERO_BYTES32,
          data: encodeList(false, false, 2, ZERO_BYTES32, 0), // targetType=2, zero targetSchema
          value: 0n,
        },
      })).to.be.revertedWith("SCHEMA mode requires targetSchema");
    });

    it("A10: non-SCHEMA with nonzero targetSchema reverts", async function () {
      await expect(eas.connect(alice).attest({
        schema: listSchemaUID,
        data: {
          recipient: ZeroAddress, expirationTime: NO_EXPIRATION,
          revocable: false, refUID: ZERO_BYTES32,
          data: encodeList(false, false, 1, dummySchemaUID, 0), // ADDR with targetSchema set
          value: 0n,
        },
      })).to.be.revertedWith("non-SCHEMA mode must have zero targetSchema");
    });

    it("A11: appendOnly+allowsDuplicates+uncapped reverts", async function () {
      await expect(eas.connect(alice).attest({
        schema: listSchemaUID,
        data: {
          recipient: ZeroAddress, expirationTime: NO_EXPIRATION,
          revocable: false, refUID: ZERO_BYTES32,
          data: encodeList(true, true, 1, ZERO_BYTES32, 0), // unbounded multiset
          value: 0n,
        },
      })).to.be.revertedWith("appendOnly+allowsDuplicates requires maxEntries cap");
    });

    it("A12: appendOnly+allowsDuplicates+maxEntries>0 succeeds", async function () {
      const uid = await attestList(alice, true, true, 1, ZERO_BYTES32, 100);
      expect(uid).to.not.equal(ZERO_BYTES32);
    });

    it("A13: ListAttested event emitted with correct args", async function () {
      await expect(eas.connect(alice).attest({
        schema: listSchemaUID,
        data: {
          recipient: ZeroAddress, expirationTime: NO_EXPIRATION,
          revocable: false, refUID: ZERO_BYTES32,
          data: encodeList(false, false, 1, ZERO_BYTES32, 0),
          value: 0n,
        },
      }))
        .to.emit(listResolver, "ListAttested")
        .withArgs(
          (_: any) => _ !== ZERO_BYTES32, // listUID (any non-zero)
          await alice.getAddress(),
          false, false, 1, ZERO_BYTES32, 0
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
      await expect(eas.connect(alice).attest({
        schema: listEntrySchemaUID,
        data: {
          recipient: await bob.getAddress(), expirationTime: NO_EXPIRATION,
          revocable: true, refUID: ZERO_BYTES32,
          data: encodeEntry(listUID, badTarget, 0n), // nonzero target in ADDR mode
          value: 0n,
        },
      })).to.be.revertedWithCustomError(listEntryResolver, "BadAddrMode");
    });

    it("B4: SCHEMA entry attests (target exists, schema matches)", async function () {
      const listUID = await attestList(alice, false, false, 2, dummySchemaUID);
      const targetUID = await mintTarget("doc1");
      await attestSchemaEntry(alice, listUID, targetUID);
      const identityKey = targetUID;
      expect(await listEntryResolver.getMemberCount(listUID, identityKey, await alice.getAddress())).to.equal(1n);
    });

    it("B5: SCHEMA entry — target missing reverts", async function () {
      const listUID = await attestList(alice, false, false, 2, dummySchemaUID);
      const fakeUID = ethers.keccak256(ethers.toUtf8Bytes("nonexistent"));
      await expect(attestSchemaEntry(alice, listUID, fakeUID))
        .to.be.revertedWithCustomError(listEntryResolver, "TargetMissing");
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
          recipient: ZeroAddress, expirationTime: NO_EXPIRATION,
          revocable: false, refUID: ZERO_BYTES32,
          data: enc.encode(["uint256"], [42n]), value: 0n,
        },
      });
      const targetUID = getUID(await targetTx.wait());
      await expect(attestSchemaEntry(alice, listUID, targetUID))
        .to.be.revertedWithCustomError(listEntryResolver, "TargetSchemaMismatch");
    });

    it("B7: SCHEMA entry with nonzero recipient reverts", async function () {
      const listUID = await attestList(alice, false, false, 2, dummySchemaUID);
      const targetUID = await mintTarget("x");
      await expect(eas.connect(alice).attest({
        schema: listEntrySchemaUID,
        data: {
          recipient: await bob.getAddress(), // WRONG for SCHEMA mode
          expirationTime: NO_EXPIRATION, revocable: true, refUID: ZERO_BYTES32,
          data: encodeEntry(listUID, targetUID, 0n), value: 0n,
        },
      })).to.be.revertedWithCustomError(listEntryResolver, "BadRecipient");
    });

    it("B8: ANY entry attests", async function () {
      const listUID = await attestList(alice, false, false, 0);
      const key = ethers.keccak256(ethers.toUtf8Bytes("milk"));
      await attestAnyEntry(alice, listUID, key);
      expect(await listEntryResolver.getMemberCount(listUID, key, await alice.getAddress())).to.equal(1n);
    });

    it("B9: ANY entry with zero target reverts", async function () {
      const listUID = await attestList(alice, false, false, 0);
      await expect(attestAnyEntry(alice, listUID, ZERO_BYTES32))
        .to.be.revertedWithCustomError(listEntryResolver, "BadAnyTarget");
    });

    it("B10: ANY entry with nonzero recipient reverts", async function () {
      const listUID = await attestList(alice, false, false, 0);
      const key = ethers.keccak256(ethers.toUtf8Bytes("milk"));
      await expect(eas.connect(alice).attest({
        schema: listEntrySchemaUID,
        data: {
          recipient: await bob.getAddress(), // WRONG for ANY mode
          expirationTime: NO_EXPIRATION, revocable: true, refUID: ZERO_BYTES32,
          data: encodeEntry(listUID, key, 0n), value: 0n,
        },
      })).to.be.revertedWithCustomError(listEntryResolver, "BadRecipient");
    });

    it("B11: no-dupes: same recipient reverts", async function () {
      const listUID = await attestList(alice, false, false, 1); // allowsDuplicates=false
      const bobAddr = await bob.getAddress();
      await attestAddrEntry(alice, listUID, bobAddr);
      await expect(attestAddrEntry(alice, listUID, bobAddr))
        .to.be.revertedWithCustomError(listEntryResolver, "DuplicateIdentity");
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
      await expect(attestAddrEntry(alice, listUID, await signers[4].getAddress()))
        .to.be.revertedWithCustomError(listEntryResolver, "ListFull");
    });

    it("B14: append-only: revoke reverts", async function () {
      const listUID = await attestList(alice, false, true, 1); // appendOnly=true
      const bobAddr = await bob.getAddress();
      const uid = await attestAddrEntry(alice, listUID, bobAddr);
      await expect(revokeEntry(alice, uid))
        .to.be.revertedWithCustomError(listEntryResolver, "ListIsAppendOnly");
    });

    it("B15: non-append-only: revoke succeeds, count decrements", async function () {
      const listUID = await attestList(alice, false, false, 1);
      const bobAddr = await bob.getAddress();
      const uid = await attestAddrEntry(alice, listUID, bobAddr);
      const identityKey = ethers.zeroPadValue(ethers.toBeHex(BigInt(bobAddr)), 32);
      await revokeEntry(alice, uid);
      expect(await listEntryResolver.getMemberCount(listUID, identityKey, await alice.getAddress())).to.equal(0n);
    });

    it("B16: stale revoke (twice) is no-op, not revert", async function () {
      const listUID = await attestList(alice, false, false, 1);
      const bobAddr = await bob.getAddress();
      const uid = await attestAddrEntry(alice, listUID, bobAddr);
      await revokeEntry(alice, uid);
      await expect(revokeEntry(alice, uid)).to.not.be.reverted; // idempotent
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
      const uid = await attestAddrEntry(alice, listUID, bobAddr, 42n);
      const records = await listEntryResolver.getEntries(listUID, await alice.getAddress(), 0n, 10n);
      expect(records.length).to.equal(1);
      expect(records[0].entryUID).to.equal(uid);
      expect(records[0].weight).to.equal(42n);
    });

    it("B19: ListEntryAttested event emitted", async function () {
      const listUID = await attestList(alice, false, false, 1);
      await expect(attestAddrEntry(alice, listUID, await bob.getAddress()))
        .to.emit(listEntryResolver, "ListEntryAttested");
    });

    it("B20: ListEntryRevoked event emitted", async function () {
      const listUID = await attestList(alice, false, false, 1);
      const uid = await attestAddrEntry(alice, listUID, await bob.getAddress());
      await expect(revokeEntry(alice, uid))
        .to.emit(listEntryResolver, "ListEntryRevoked");
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
      await expect(eas.connect(alice).attest({
        schema: listEntrySchemaUID,
        data: {
          recipient: await bob.getAddress(), expirationTime: NO_EXPIRATION,
          revocable: true, refUID: ZERO_BYTES32,
          data: encodeEntry(dummyUID, ZERO_BYTES32, 0n), // dummyUID is not a LIST
          value: 0n,
        },
      })).to.be.revertedWithCustomError(listEntryResolver, "NotAList");
    });

    it("B24: revocable=false entry reverts", async function () {
      const listUID = await attestList(alice, false, false, 1);
      await expect(eas.connect(alice).attest({
        schema: listEntrySchemaUID,
        data: {
          recipient: await bob.getAddress(), expirationTime: NO_EXPIRATION,
          revocable: false, // WRONG — entries must be revocable
          refUID: ZERO_BYTES32,
          data: encodeEntry(listUID, ZERO_BYTES32, 0n), value: 0n,
        },
      })).to.be.revertedWithCustomError(listEntryResolver, "NotRevocable");
    });

    it("B25: expirationTime != 0 entry reverts", async function () {
      const listUID = await attestList(alice, false, false, 1);
      await expect(eas.connect(alice).attest({
        schema: listEntrySchemaUID,
        data: {
          recipient: await bob.getAddress(), expirationTime: 9999999999n,
          revocable: true, refUID: ZERO_BYTES32,
          data: encodeEntry(listUID, ZERO_BYTES32, 0n), value: 0n,
        },
      })).to.be.revertedWithCustomError(listEntryResolver, "HasExpiration");
    });

    it("B26: refUID != 0 entry reverts", async function () {
      const listUID = await attestList(alice, false, false, 1);
      const someUID = ethers.keccak256(ethers.toUtf8Bytes("ref"));
      await expect(eas.connect(alice).attest({
        schema: listEntrySchemaUID,
        data: {
          recipient: await bob.getAddress(), expirationTime: NO_EXPIRATION,
          revocable: true, refUID: someUID, // WRONG
          data: encodeEntry(listUID, ZERO_BYTES32, 0n), value: 0n,
        },
      })).to.be.revertedWithCustomError(listEntryResolver, "UsesRefUID");
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
      await attestAddrEntry(alice, listUID, bobAddr, 7n);
      const es = await listReader.entries(listUID, await alice.getAddress(), 0n, 10n);
      expect(es.length).to.equal(1);
      expect(es[0].targetType).to.equal(1); // denormalized from LIST
      expect(es[0].weight).to.equal(7n);
    });

    it("C7: entries() pagination", async function () {
      const listUID = await attestList(alice, true, false, 1); // duplicates allowed
      const signers = await ethers.getSigners();
      await attestAddrEntry(alice, listUID, await signers[2].getAddress(), 1n);
      await attestAddrEntry(alice, listUID, await signers[3].getAddress(), 2n);
      await attestAddrEntry(alice, listUID, await signers[4].getAddress(), 3n);
      const aliceAddr = await alice.getAddress();
      const page = await listReader.entries(listUID, aliceAddr, 1n, 2n);
      expect(page.length).to.equal(2);
      expect(page[0].weight).to.equal(2n);
      expect(page[1].weight).to.equal(3n);
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
      await expect(listReader.targetAsAddress(listUID, aliceAddr, uid))
        .to.be.revertedWith("not ADDR-typed list");
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
      await expect(listReader.targetAsAddress(listUID, aliceAddr, uid))
        .to.be.revertedWith("entry revoked");
    });

    it("C14: targetAsAddress() reverts for wrong curator", async function () {
      const listUID = await attestList(alice, false, false, 1);
      const uid = await attestAddrEntry(alice, listUID, await bob.getAddress());
      // Bob is not the curator; alice is
      await expect(listReader.targetAsAddress(listUID, await bob.getAddress(), uid))
        .to.be.revertedWith("wrong curator lens");
    });
  });
});
```

- [ ] **Step 2: Run all tests**

```bash
cd /Users/james/Code/Claude/contracts/.claude/worktrees/zen-wozniak-493b4b/packages/hardhat
npx hardhat test test/Lists.unit.test.ts --network hardhat 2>&1 | tail -30
```

Expected: all tests pass.

- [ ] **Step 3: Run full suite (regression check)**

```bash
cd /Users/james/Code/Claude/contracts/.claude/worktrees/zen-wozniak-493b4b/packages/hardhat
npx hardhat test --network hardhat 2>&1 | tail -15
```

- [ ] **Step 4: Commit**

```bash
git add packages/hardhat/test/Lists.unit.test.ts
git commit -m "$(cat <<'EOF'
test(lists): full unit test suite — all 3 modes, all option combos

Groups A (ListResolver), B (ListEntryResolver), C (ListReader). Covers:
dup-reject, append-only reject, cap, lifecycle rejects, cross-list injection
reject, getMode on empty/non-LIST UIDs, typed accessors safe-by-construction.

Refs: ADR-0044

Co-authored-by: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: E2E simulate-lists.ts

**Files:**
- Create: `packages/hardhat/scripts/simulate-lists.ts`
- Modify: `packages/hardhat/package.json` (add simulate:lists script)

- [ ] **Step 1: Write simulate-lists.ts**

```ts
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
async function main() {
  const PASS = "✅ PASS";
  const FAIL = "❌ FAIL";
  let passed = 0;
  let failed = 0;
  const assert = (label: string, condition: boolean, detail = "") => {
    if (condition) { console.log(`  ${PASS} ${label}${detail ? ` — ${detail}` : ""}`); passed++; }
    else           { console.log(`  ${FAIL} ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
  };

  console.log("════════════════════════════════════════");
  console.log("  EFS Lists Simulation");
  console.log("  ADDR · SCHEMA · ANY · lenses");
  console.log("════════════════════════════════════════\n");

  const [deployer, alice, bob] = await ethers.getSigners();
  const aliceAddr = await alice.getAddress();
  const bobAddr   = await bob.getAddress();

  // Connect to deployed contracts
  const indexer = (await ethers.getContract("Indexer", deployer)) as unknown as EFSIndexer;
  const easAddr  = await indexer.getEAS();
  const eas      = await ethers.getContractAt(
    "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol:IEAS", easAddr
  ) as any;

  const listEntryResolver = (await ethers.getContract("ListEntryResolver", deployer)) as unknown as ListEntryResolver;
  const listReader        = (await ethers.getContract("ListReader", deployer)) as unknown as ListReader;

  const listSchemaUID      = await listEntryResolver.LIST_SCHEMA_UID();
  // Get LIST_ENTRY_SCHEMA_UID from ListReader
  const listEntrySchemaUID = await (listReader as any).LIST_ENTRY_SCHEMA_UID();

  console.log(`ListEntryResolver: ${await listEntryResolver.getAddress()}`);
  console.log(`ListReader:        ${await listReader.getAddress()}`);
  console.log(`LIST_SCHEMA_UID:   ${listSchemaUID}`);
  console.log(`LIST_ENTRY_SCHEMA_UID: ${listEntrySchemaUID}\n`);

  const enc = new ethers.AbiCoder();
  const S = Date.now().toString(36); // session suffix for uniqueness

  const encodeList = (ad: boolean, ao: boolean, tt: number, ts: string, me: number) =>
    enc.encode(["bool","bool","uint8","bytes32","uint32"], [ad, ao, tt, ts, me]);
  const encodeEntry = (lu: string, t: string, w: bigint) =>
    enc.encode(["bytes32","bytes32","int256"], [lu, t, w]);

  const getUID = (receipt: any): string => {
    const iface = eas.interface;
    for (const log of receipt.logs) {
      try { const p = iface.parseLog(log); if (p?.name === "Attested") return p.args.uid; } catch {}
    }
    throw new Error("No Attested event");
  };

  // ── Section 1: ADDR-typed allowlist ───────────────────────────────────────

  console.log("Section 1: ADDR-typed NFT allowlist");

  const list1Tx = await eas.connect(alice).attest({
    schema: listSchemaUID,
    data: {
      recipient: ethers.ZeroAddress, expirationTime: 0n,
      revocable: false, refUID: ethers.ZeroHash,
      data: encodeList(false, false, 1, ethers.ZeroHash, 0), value: 0n,
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
      recipient: bobAddr, expirationTime: 0n,
      revocable: true, refUID: ethers.ZeroHash,
      data: encodeEntry(allowlistUID, ethers.ZeroHash, 0n), value: 0n,
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

  // Stale revoke is a no-op
  try {
    await eas.connect(alice).revoke({ schema: listEntrySchemaUID, data: { uid: bobEntryUID, value: 0n } });
    assert("stale revoke is no-op (did not revert)", true);
  } catch {
    assert("stale revoke is no-op (did not revert)", false);
  }

  // ── Section 2: SCHEMA-typed ranked list ───────────────────────────────────

  console.log("\nSection 2: SCHEMA-typed Letterboxd film list");

  // Get DATA schema UID for SCHEMA-typed entries (films are DATA attestations)
  const dataSchemaUID = await indexer.DATA_SCHEMA_UID();
  const anchorSchemaUID = await indexer.ANCHOR_SCHEMA_UID();

  const filmListTx = await eas.connect(alice).attest({
    schema: listSchemaUID,
    data: {
      recipient: ethers.ZeroAddress, expirationTime: 0n,
      revocable: false, refUID: ethers.ZeroHash,
      data: encodeList(false, false, 2, dataSchemaUID, 10), value: 0n,
    },
  });
  const filmListUID = getUID(await filmListTx.wait());

  // Mint a fake DATA attestation to use as a film
  const filmTx = await eas.connect(alice).attest({
    schema: dataSchemaUID,
    data: {
      recipient: ethers.ZeroAddress, expirationTime: 0n,
      revocable: false, refUID: ethers.ZeroHash,
      data: enc.encode(["bytes32","uint64"], [ethers.keccak256(ethers.toUtf8Bytes(`film-${S}`)), 1000n]),
      value: 0n,
    },
  });
  const filmUID = getUID(await filmTx.wait());

  const addFilmTx = await eas.connect(alice).attest({
    schema: listEntrySchemaUID,
    data: {
      recipient: ethers.ZeroAddress, expirationTime: 0n,
      revocable: true, refUID: ethers.ZeroHash,
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
      recipient: ethers.ZeroAddress, expirationTime: 0n,
      revocable: false, refUID: ethers.ZeroHash,
      data: encodeList(false, false, 0, ethers.ZeroHash, 0), value: 0n,
    },
  });
  const shopListUID = getUID(await shopListTx.wait());

  const milkKey = ethers.keccak256(enc.encode(["string","string"], ["efs-list-intrinsic", "milk"]));
  const eggKey  = ethers.keccak256(enc.encode(["string","string"], ["efs-list-intrinsic", "eggs"]));

  await eas.connect(alice).attest({
    schema: listEntrySchemaUID,
    data: {
      recipient: ethers.ZeroAddress, expirationTime: 0n,
      revocable: true, refUID: ethers.ZeroHash,
      data: encodeEntry(shopListUID, milkKey, 1n), value: 0n,
    },
  });
  await eas.connect(alice).attest({
    schema: listEntrySchemaUID,
    data: {
      recipient: ethers.ZeroAddress, expirationTime: 0n,
      revocable: true, refUID: ethers.ZeroHash,
      data: encodeEntry(shopListUID, eggKey, 2n), value: 0n,
    },
  });

  const shopLen = await listReader.length(shopListUID, aliceAddr);
  assert("shopping list has 2 items", shopLen === 2n);
  assert("milk is in list", await listReader.countOf(shopListUID, aliceAddr, milkKey) === 1n);
  assert("eggs are in list", await listReader.countOf(shopListUID, aliceAddr, eggKey) === 1n);

  // ── Section 4: Lens switching ─────────────────────────────────────────────

  console.log("\nSection 4: Lens switching (per-attester views)");

  const sharedListTx = await eas.connect(alice).attest({
    schema: listSchemaUID,
    data: {
      recipient: ethers.ZeroAddress, expirationTime: 0n,
      revocable: false, refUID: ethers.ZeroHash,
      data: encodeList(false, false, 1, ethers.ZeroHash, 0), value: 0n,
    },
  });
  const sharedListUID = getUID(await sharedListTx.wait());
  const signers = await ethers.getSigners();
  const carol = signers[2];
  const carolAddr = await carol.getAddress();

  // Alice adds Bob; Bob adds Carol (each attester's own lens)
  await eas.connect(alice).attest({
    schema: listEntrySchemaUID,
    data: {
      recipient: bobAddr, expirationTime: 0n, revocable: true, refUID: ethers.ZeroHash,
      data: encodeEntry(sharedListUID, ethers.ZeroHash, 0n), value: 0n,
    },
  });
  await eas.connect(bob).attest({
    schema: listEntrySchemaUID,
    data: {
      recipient: carolAddr, expirationTime: 0n, revocable: true, refUID: ethers.ZeroHash,
      data: encodeEntry(sharedListUID, ethers.ZeroHash, 0n), value: 0n,
    },
  });

  const identityKeyCarol = ethers.zeroPadValue(ethers.toBeHex(BigInt(carolAddr)), 32);
  assert("Alice's lens: Bob is listed", await listReader.countOf(sharedListUID, aliceAddr, identityKeyBob) === 1n);
  assert("Alice's lens: Carol is NOT listed", await listReader.countOf(sharedListUID, aliceAddr, identityKeyCarol) === 0n);
  assert("Bob's lens: Carol is listed", await listReader.countOf(sharedListUID, bobAddr, identityKeyCarol) === 1n);
  assert("Bob's lens: Bob is NOT listed (different attester)", await listReader.countOf(sharedListUID, bobAddr, identityKeyBob) === 0n);

  // ── Summary ────────────────────────────────────────────────────────────────

  console.log(`\n════════════════════════════════════════`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`════════════════════════════════════════`);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Add yarn script to packages/hardhat/package.json**

In the `"scripts"` section, add:
```json
"simulate:lists": "hardhat run scripts/simulate-lists.ts --network localhost",
```

- [ ] **Step 3: Add to root package.json**

In the root `package.json` (if it exists), add:
```json
"hardhat:simulate:lists": "yarn workspace @se-2/hardhat simulate:lists",
```

- [ ] **Step 4: Commit**

```bash
git add packages/hardhat/scripts/simulate-lists.ts packages/hardhat/package.json
git commit -m "$(cat <<'EOF'
feat(lists): add simulate-lists.ts e2e script + yarn script

Exercises all 3 list modes (ADDR/SCHEMA/ANY), add/remove/reorder,
countOf/entries/targetAs* accessors, and lens switching from a
client/third-party-dev POV. Wire via yarn workspace simulate:lists.

Refs: ADR-0044

Co-authored-by: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Deploy script (09_lists.ts)

**Files:**
- Create: `packages/hardhat/deploy/09_lists.ts`

- [ ] **Step 1: Write 09_lists.ts**

```ts
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { Contract } from "ethers";

const LIST_SCHEMA      = "bool allowsDuplicates, bool appendOnly, uint8 targetType, bytes32 targetSchema, uint32 maxEntries";
const LIST_ENTRY_SCHEMA = "bytes32 listUID, bytes32 target, int256 weight";

// CREATE2 salts — deterministic resolver addresses across Sepolia/mainnet
const LIST_RESOLVER_SALT       = "0x6566732d6c6973742d7265736f6c7665722d763100000000000000000000000000"; // "efs-list-resolver-v1" padded
const LIST_ENTRY_RESOLVER_SALT = "0x6566732d6c6973742d656e7472792d7265736f6c7665722d763100000000000000"; // "efs-list-entry-resolver-v1" padded

const deploy09Lists: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;
  const ethers = hre.ethers;

  // Only run on localhost/hardhat (and Sepolia when ready)
  const network = hre.network.name;
  if (!["localhost", "hardhat", "sepolia"].includes(network)) {
    console.log(`Skipping Lists deploy on ${network}`);
    return;
  }

  console.log("Deploying EFS Lists contracts...");

  // Get EAS from already-deployed Indexer
  let easAddress: string;
  try {
    const indexer = await hre.ethers.getContract<Contract>("Indexer", deployer);
    easAddress = await indexer.getEAS();
  } catch {
    // Fallback for test environments
    easAddress = "0xC2679fBD37d54388Ce493F1DB75320D236e1815e"; // Sepolia EAS
  }

  const schemaRegistry = await ethers.getContractAt(
    "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol:ISchemaRegistry",
    "0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0"
  );

  // 1. Deploy ListResolver (CREATE2 for deterministic address)
  const listResolverDeploy = await deploy("ListResolver", {
    from: deployer,
    args: [easAddress],
    deterministicDeployment: LIST_RESOLVER_SALT,
    log: true,
    autoMine: true,
  });
  const listResolverAddr = listResolverDeploy.address;
  console.log(`ListResolver: ${listResolverAddr}`);

  // 2. Pre-compute LIST_SCHEMA_UID
  const listSchemaUID = ethers.solidityPackedKeccak256(
    ["string", "address", "bool"],
    [LIST_SCHEMA, listResolverAddr, false]
  );
  console.log(`LIST_SCHEMA_UID (pre-computed): ${listSchemaUID}`);

  // 3. Deploy ListEntryResolver (CREATE2, needs LIST_SCHEMA_UID)
  const listEntryResolverDeploy = await deploy("ListEntryResolver", {
    from: deployer,
    args: [easAddress, listSchemaUID],
    deterministicDeployment: LIST_ENTRY_RESOLVER_SALT,
    log: true,
    autoMine: true,
  });
  const listEntryResolverAddr = listEntryResolverDeploy.address;
  console.log(`ListEntryResolver: ${listEntryResolverAddr}`);

  // 4. Pre-compute LIST_ENTRY_SCHEMA_UID
  const listEntrySchemaUID = ethers.solidityPackedKeccak256(
    ["string", "address", "bool"],
    [LIST_ENTRY_SCHEMA, listEntryResolverAddr, true]
  );
  console.log(`LIST_ENTRY_SCHEMA_UID (pre-computed): ${listEntrySchemaUID}`);

  // 5. Register LIST schema
  try {
    const tx = await schemaRegistry.register(LIST_SCHEMA, listResolverAddr, false);
    await tx.wait();
    console.log("Registered LIST schema");
  } catch {
    console.log("LIST schema already registered (skipping)");
  }

  // 6. Register LIST_ENTRY schema
  try {
    const tx = await schemaRegistry.register(LIST_ENTRY_SCHEMA, listEntryResolverAddr, true);
    await tx.wait();
    console.log("Registered LIST_ENTRY schema");
  } catch {
    console.log("LIST_ENTRY schema already registered (skipping)");
  }

  // 7. Deploy ListReader (stateless — redeployable, no CREATE2 needed)
  await deploy("ListReader", {
    from: deployer,
    args: [easAddress, listEntryResolverAddr, listSchemaUID, listEntrySchemaUID],
    log: true,
    autoMine: true,
  });
  console.log("ListReader deployed");

  // 8. FREEZE INVARIANT: assert schema UID matches expected constant
  // On devnet this catches drift early; on mainnet this is the freeze gate.
  const listEntryResolver = await hre.ethers.getContract<Contract>("ListEntryResolver", deployer);
  const actualListSchemaUID = await listEntryResolver.LIST_SCHEMA_UID();
  if (actualListSchemaUID !== listSchemaUID) {
    throw new Error(
      `LIST_SCHEMA_UID mismatch!\n` +
      `Expected: ${listSchemaUID}\n` +
      `Got:      ${actualListSchemaUID}\n` +
      `Resolver address changed — bump salt or check nonce.`
    );
  }
  console.log("✓ LIST_SCHEMA_UID freeze invariant holds");
  console.log(`\nSchema UIDs:\n  LIST:       ${listSchemaUID}\n  LIST_ENTRY: ${listEntrySchemaUID}`);
};

export default deploy09Lists;
deploy09Lists.tags = ["Lists"];
deploy09Lists.dependencies = ["Indexer"];
```

- [ ] **Step 2: Test deploy runs cleanly**

```bash
cd /Users/james/Code/Claude/contracts/.claude/worktrees/zen-wozniak-493b4b
yarn fork &
sleep 5
yarn deploy 2>&1 | grep -E "(Lists|ListResolver|ListEntryResolver|ListReader|SCHEMA_UID|✓)"
```

- [ ] **Step 3: Verify deployedContracts.ts updated**

```bash
cd /Users/james/Code/Claude/contracts/.claude/worktrees/zen-wozniak-493b4b
git diff packages/nextjs/contracts/deployedContracts.ts | head -40
```

Expected: ListResolver, ListEntryResolver, ListReader appear in deployed contracts.

- [ ] **Step 4: Commit**

```bash
git add packages/hardhat/deploy/09_lists.ts packages/nextjs/contracts/deployedContracts.ts
git commit -m "$(cat <<'EOF'
feat(lists): deploy script 09_lists.ts with CREATE2 freeze discipline

CREATE2-deploys ListResolver+ListEntryResolver with deterministic salts.
Registers LIST (revocable:false) + LIST_ENTRY (revocable:true) schemas.
Deploy-time assert: LIST_SCHEMA_UID matches pre-computed constant.
Updates deployedContracts.ts.

Permanence-tier: Etched
Refs: ADR-0044, ADR-0037

Co-authored-by: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Debug UI (packages/nextjs)

Reuse the folder-browser shell. Add minimal but usable list browsing.

**Files:**
- Create: `packages/nextjs/app/lists/page.tsx` — list creation + browse
- Create: `packages/nextjs/app/lists/[listUID]/page.tsx` — list detail + entries
- Modify: `packages/nextjs/app/page.tsx` or nav — add Lists link

- [ ] **Step 1: Create list browse/create page**

The page should:
1. Show a form to create a new LIST (targetType select, allowsDuplicates checkbox, appendOnly checkbox, maxEntries)
2. Show recent lists the connected wallet has curated (use `ListAttested` events)
3. Link to each list's detail page

- [ ] **Step 2: Create list detail page**

The detail page should:
1. Call `listReader.getMode(listUID)` and display list configuration
2. Paginate `listReader.entries(listUID, curator, 0, 50)` 
3. Show each entry: identityKey, weight, targetType (decoded via typed accessor if ADDR/SCHEMA)
4. Form to add new entry (mode-dependent fields)
5. Revoke button per entry
6. Lens switcher: input box for different curator address

- [ ] **Step 3: Type-check**

```bash
cd /Users/james/Code/Claude/contracts/.claire/worktrees/zen-wozniak-493b4b
yarn next:check-types 2>&1 | tail -10
```

- [ ] **Step 4: Commit**

```bash
git add packages/nextjs/app/lists/
git commit -m "$(cat <<'EOF'
feat(lists): basic debug UI — create/browse/view lists

List creation form (all modes), entry listing with typed display,
lens switcher, add/revoke entries. Reuses folder-browser shell patterns.

Refs: ADR-0044

Co-authored-by: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Spec updates

**Files:**
- Modify: `specs/overview.md` (schema table 7→9)
- Modify: `specs/02-Data-Models-and-Schemas.md` (add LIST + LIST_ENTRY sections)
- Modify: `specs/06-Lists-and-Collections.md` (full rewrite for shipped primitive)
- Modify: `docs/adr/0044-list-and-list-entry-schemas.md` (Status: Accepted + Migration UIDs)

- [ ] **Step 1: Pull origin/main (specs may have moved)**

```bash
cd /Users/james/Code/Claude/contracts/.claude/worktrees/zen-wozniak-493b4b
git fetch origin main
```

- [ ] **Step 2: Update specs/overview.md schema table**

Change "Seven EAS schemas" → "Nine EAS schemas" and add LIST + LIST_ENTRY rows:

```markdown
| LIST | no | List declaration (`allowsDuplicates`, `appendOnly`, `targetType`, `targetSchema`, `maxEntries`). Free-floating, like DATA. |
| LIST_ENTRY | yes | Membership edge. One entry in one list. `listUID` + `target` + `weight`. Resolver enforces all declared shape at write time. |
```

- [ ] **Step 3: Update specs/02-Data-Models-and-Schemas.md**

Add sections for LIST and LIST_ENTRY after the SORT_INFO section, documenting fields, resolver behavior, per-mode encoding, and the ADR-0041 reconciliation (pointing to ADR-0044).

- [ ] **Step 4: Rewrite specs/06-Lists-and-Collections.md**

Replace the speculative pre-implementation content with an accurate description of the shipped LIST+LIST_ENTRY primitive, referencing the worked examples and consumer patterns from designs/custom-lists.md.

- [ ] **Step 5: Update ADR-0044 status and Migration section**

Change `Status: Proposed` → `Status: Accepted` and fill in the Migration section with real addresses and schema UIDs from the deploy.

- [ ] **Step 6: Commit**

```bash
git add specs/ docs/adr/0044-list-and-list-entry-schemas.md
git commit -m "$(cat <<'EOF'
docs(lists): update specs overview+02+06 for 9 schemas; accept ADR-0044

Adds LIST/LIST_ENTRY rows to overview and specs/02. Rewrites specs/06
to describe the shipped primitive. Flips ADR-0044 to Accepted and fills
Migration section with deployed resolver addresses and schema UIDs.

Refs: ADR-0044

Co-authored-by: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

- [ ] `yarn hardhat:test` — all tests pass (conformance + unit + pre-existing)
- [ ] `yarn hardhat:simulate` — existing e2e passes
- [ ] `yarn workspace @se-2/hardhat simulate:lists` — lists e2e passes (after `yarn fork && yarn deploy`)
- [ ] `yarn next:check-types` — TypeScript clean
- [ ] `git diff --exit-code packages/nextjs/contracts/deployedContracts.ts` — pin holds

---

## Designer fidelity review surfaces

After Task 3 (ListEntryResolver): share contract code for design fidelity check before proceeding to UI.
After Task 6 (E2E): share simulate-lists output.
After Task 8 (UI): screenshot/recording of list creation and entry browsing.
