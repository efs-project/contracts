// Verify gate (Phase D deploy core) — docs/DEPLOYMENT.md §3 step 3, SEPOLIA_FREEZE_TABLE.md
// "Pre-registration verification". Runs AFTER deploy+init, BEFORE any schema is registered. Any
// failure throws — the orchestration aborts before the freeze gate, so no schema is ever registered
// against an unverified proxy.

import { Signer, ZeroHash, ZeroAddress } from "ethers";
import { ethers } from "hardhat";
import { EAS_ADDRESS, SCHEMA_REGISTRY_ADDRESS } from "./addresses";
import type { Create3DeployResult } from "./create3";
import { SCHEMAS, computeSchemaUID } from "./schemas";

export interface VerifyInput {
  deploys: Record<string, Create3DeployResult>; // resolver name -> result
  schemaUIDs: Record<string, string>; // schema name -> UID
  deployer: Signer;
}

async function expectRevert(p: Promise<unknown>, label: string): Promise<void> {
  try {
    await p;
  } catch {
    return; // reverted as required
  }
  throw new Error(`VERIFY GATE: ${label} did NOT revert (expected revert)`);
}

/// Run the full pre-registration verify gate. Throws on first failure.
export async function runVerifyGate(input: VerifyInput): Promise<void> {
  const { deploys, schemaUIDs, deployer } = input;

  // (1) realized == predicted per proxy. NOTE on golden vectors: step (5) below RE-DERIVES UIDs from
  //     deploy-lib/schemas.ts, so it is self-consistent, NOT a contract↔script field-string check. The
  //     authoritative field-string integrity guard is the OFF-CHAIN test/SchemaGoldenVectors.test.ts
  //     (committed UID + field-string literals at a fixed mock resolver) — it must be green at freeze
  //     time (freeze-checklist gate). On-chain, only the two self-deriving resolvers (ListEntry/Alias)
  //     embed a real field-string constant; those are cross-checked in (3).
  console.log("  [verify] realized == predicted (per proxy)...");
  for (const d of Object.values(deploys)) {
    if (d.proxy.toLowerCase() !== d.predicted.toLowerCase()) {
      throw new Error(`VERIFY GATE: ${d.resolver} realized ${d.proxy} != predicted ${d.predicted}`);
    }
  }

  // (2) initialize() locked: a 2nd call on each proxy reverts, and (when an impl handle is available) the
  //     IMPL's direct initialize reverts (_disableInitializers in the base constructor).
  //     PR #24 P2 (50yr-review): the Safe propose path now reads each live proxy's EIP-1967 implementation
  //     slot (buildDeploysFromOnchain) and passes it here, so the impl-direct check runs on the Safe
  //     ceremony too — closing the gap where Safe-path impls (deployed inside the Batch-1 MultiSend, not
  //     via the checked create3 helper) were never verified initializer-locked before register. `d.impl`
  //     is only empty in degenerate cases (none on the real paths); the check is skipped iff absent.
  console.log("  [verify] initialize() locked (2nd proxy call + impl direct call revert)...");
  for (const d of Object.values(deploys)) {
    const proxy = await ethers.getContractAt(d.resolver, d.proxy, deployer);
    // 2nd initialize on the proxy — argument shape varies per resolver; any args revert on `initializer`.
    // Assert the revert with a STATIC call (eth_call), NOT a tx send. A state-changing send only surfaces
    // a revert if the node rejects it at send time: Hardhat's in-process node does (so this gate passed in
    // CI/local), but an external RPC node (the anvil devnet, and live Sepolia/mainnet) mines the reverting
    // tx with a status-0 receipt and ethers v6 `contract.initialize(...)` resolves on broadcast — a FALSE
    // NEGATIVE here, and on an external node the send form cannot even distinguish a locked proxy from an
    // unlocked one (both resolve). `staticCall` reverts iff the call reverts, deterministically on every
    // node, so the lock check is meaningful on the real freeze path (external RPC), not just in-process.
    const reinit = (proxy as any).initialize.fragment;
    const dummyArgs = reinit.inputs.map((i: any) => dummyForType(i.type));
    await expectRevert((proxy as any).initialize.staticCall(...dummyArgs), `${d.resolver} proxy 2nd initialize`);
    if (d.impl) {
      const impl = await ethers.getContractAt(d.resolver, d.impl, deployer);
      await expectRevert((impl as any).initialize.staticCall(...dummyArgs), `${d.resolver} impl direct initialize`);
    }
  }

  // (3) self-UID getters == computed == to-be-registered (the ListEntry-class bug guard). Each of
  //     these resolvers derives the schema UID it enforces from its OWN baked-in field-string constant
  //     + its (proxy) address; reading the getter back catches a stale/edited resolver artifact whose
  //     constant disagrees with schemaUIDs before the irreversible register (PR #24 P2).
  console.log("  [verify] self-UID getters (List/ListEntry/Alias) == computed UID...");
  const list = await ethers.getContractAt("ListResolver", deploys.ListResolver.proxy, deployer);
  const onchainListUID: string = await list.listSchemaUID();
  assertEq(onchainListUID, schemaUIDs.LIST, "ListResolver.listSchemaUID");

  const listEntry = await ethers.getContractAt("ListEntryResolver", deploys.ListEntryResolver.proxy, deployer);
  const onchainListEntryUID: string = await listEntry.listEntrySchemaUID();
  assertEq(onchainListEntryUID, schemaUIDs.LIST_ENTRY, "ListEntryResolver.listEntrySchemaUID");

  const aliasR = await ethers.getContractAt("AliasResolver", deploys.AliasResolver.proxy, deployer);
  const onchainRedirectUID: string = await aliasR.redirectSchemaUID();
  assertEq(onchainRedirectUID, schemaUIDs.REDIRECT, "AliasResolver.redirectSchemaUID");

  // (3b) init-supplied cross-reference UIDs (PR #24 50yr-review, M-1). (3) above only checks the two
  //      SELF-DERIVED UIDs (ListEntry/Alias). The UIDs threaded INTO initialize() as typing/config
  //      cross-references were unchecked — a mis-threaded init arg would register a correct schema UID
  //      yet wire the WRONG typing target into permanent resolver behavior (e.g. REDIRECTs validating
  //      sameAs endpoints against a wrong DATA UID, or the kernel matching attestations against a wrong
  //      ANCHOR/PROPERTY/DATA UID). The gate is the thing meant to catch a future init-arg refactor, so
  //      assert every stored cross-ref against the same schemaUIDs map before the irreversible register.
  console.log("  [verify] init-supplied cross-ref UIDs (kernel + edge + alias) == computed...");
  const indexer = await ethers.getContractAt("EFSIndexer", deploys.EFSIndexer.proxy, deployer);
  assertEq(await indexer.ANCHOR_SCHEMA_UID(), schemaUIDs.ANCHOR, "EFSIndexer.ANCHOR_SCHEMA_UID");
  assertEq(await indexer.PROPERTY_SCHEMA_UID(), schemaUIDs.PROPERTY, "EFSIndexer.PROPERTY_SCHEMA_UID");
  assertEq(await indexer.DATA_SCHEMA_UID(), schemaUIDs.DATA, "EFSIndexer.DATA_SCHEMA_UID");
  const edge = await ethers.getContractAt("EdgeResolver", deploys.EdgeResolver.proxy, deployer);
  assertEq(await edge.PIN_SCHEMA_UID(), schemaUIDs.PIN, "EdgeResolver.PIN_SCHEMA_UID");
  assertEq(await edge.TAG_SCHEMA_UID(), schemaUIDs.TAG, "EdgeResolver.TAG_SCHEMA_UID");
  assertEq(await aliasR.dataSchemaUID(), schemaUIDs.DATA, "AliasResolver.dataSchemaUID");
  assertEq(await aliasR.anchorSchemaUID(), schemaUIDs.ANCHOR, "AliasResolver.anchorSchemaUID");

  // (3c) one-shot partner WIRING addresses (PR #24 P2) — checked IFF the indexer is already wired.
  //      (3b) checks the UID cross-refs; this checks the ADDRESSES set by EFSIndexer.wireContracts() —
  //      a ONE-SHOT setter (`edgeResolver == address(0)` guard). A stale/hand-edited wire that consumed
  //      the slot with a WRONG EdgeResolver/MirrorResolver/SchemaRegistry passes every UID check above,
  //      lets the 9 permanent schemas register, and only THEN breaks irrecoverably: PIN/TAG writes
  //      revert forever when the real EdgeResolver calls back and fails `msg.sender == edgeResolver`.
  //      Ordering note: the Safe path (Batch 1 wires) and the EOA --after-freeze-gate resume are ALREADY
  //      wired when this gate runs, so the check fires; the EOA `full` path wires in step 4 AFTER this
  //      gate, so here it is correctly unwired and skipped — orchestrate.ts asserts it explicitly
  //      post-wire (assertIndexerWiring) before its register.
  if ((await indexer.edgeResolver()) !== ZeroAddress) {
    console.log("  [verify] EFSIndexer partner wiring (edgeResolver / mirrorResolver / schemaRegistry)...");
    await assertIndexerWiring(deploys, deployer);
  }

  // (4) proxy.getEAS() == EAS for every resolver.
  console.log("  [verify] getEAS() == canonical EAS (per proxy)...");
  for (const d of Object.values(deploys)) {
    const proxy = await ethers.getContractAt(d.resolver, d.proxy, deployer);
    const eas: string = await proxy.getEAS();
    assertEq(eas, EAS_ADDRESS, `${d.resolver}.getEAS()`);
  }

  // (5) Golden-vector recompute: every UID in schemaUIDs equals computeSchemaUID(field, proxy, rev).
  console.log("  [verify] golden-vector field strings -> UIDs...");
  const proxyByResolver: Record<string, string> = {};
  for (const d of Object.values(deploys)) proxyByResolver[d.resolver] = d.proxy;
  for (const s of SCHEMAS) {
    const expected = computeSchemaUID(s.fieldString, proxyByResolver[s.resolver], s.revocable);
    assertEq(schemaUIDs[s.name], expected, `golden-vector ${s.name}`);
    if (schemaUIDs[s.name] === ZeroHash) throw new Error(`VERIFY GATE: ${s.name} UID is zero`);
  }

  console.log("  [verify] GATE GREEN ✓");
}

/// Assert the partner wiring BETWEEN EFSIndexer and its resolvers matches the deployed proxies +
/// canonical registry, in BOTH directions. Separate from runVerifyGate because the EOA `full` path
/// wires AFTER the step-3 gate (so the gate skips it as unwired), whereas the Safe path + the EOA
/// --after-freeze-gate resume are already wired when the gate runs. Call wherever wiring is present and
/// BEFORE the irreversible register: the gate calls it when wired; orchestrate.ts calls it post-wire in
/// `full` mode. (PR #24 P2 — guards against a wrong one-shot wire registering schemas that then can
/// never accept PIN/TAG/MIRROR writes.)
///
/// Both directions matter: `EFSIndexer.wireContracts` and each resolver's `initialize` set their
/// partner refs INDEPENDENTLY, so checking only EFSIndexer's forward pointers would still pass if a
/// stale/edited Batch 1 initialized EdgeResolver/MirrorResolver with the WRONG indexer/registry. The
/// register-last would then permanently bind PIN/TAG/MIRROR to resolvers whose writes call the wrong
/// indexer/registry. The reciprocal assertions below close that gap (PR #24 P2, second pass).
export async function assertIndexerWiring(
  deploys: Record<string, Create3DeployResult>,
  deployer: Signer,
): Promise<void> {
  const indexer = await ethers.getContractAt("EFSIndexer", deploys.EFSIndexer.proxy, deployer);
  // Forward: EFSIndexer -> resolvers / registry.
  assertEq(await indexer.edgeResolver(), deploys.EdgeResolver.proxy, "EFSIndexer.edgeResolver()");
  assertEq(await indexer.mirrorResolver(), deploys.MirrorResolver.proxy, "EFSIndexer.mirrorResolver()");
  assertEq(await indexer.schemaRegistry(), SCHEMA_REGISTRY_ADDRESS, "EFSIndexer.schemaRegistry()");

  // Reciprocal: each resolver -> EFSIndexer / registry. A resolver initialized with the wrong indexer
  // or registry would index/validate writes against the wrong contract even when the forward wiring is
  // correct — so assert the back-references too before treating the pre-register gate as green.
  const edge = await ethers.getContractAt("EdgeResolver", deploys.EdgeResolver.proxy, deployer);
  assertEq(await edge.indexer(), deploys.EFSIndexer.proxy, "EdgeResolver.indexer()");
  assertEq(await edge.schemaRegistry(), SCHEMA_REGISTRY_ADDRESS, "EdgeResolver.schemaRegistry()");
  const mirror = await ethers.getContractAt("MirrorResolver", deploys.MirrorResolver.proxy, deployer);
  assertEq(await mirror.indexer(), deploys.EFSIndexer.proxy, "MirrorResolver.indexer()");
}

function assertEq(got: string, want: string, label: string): void {
  if (got.toLowerCase() !== want.toLowerCase()) {
    throw new Error(`VERIFY GATE: ${label} mismatch — got ${got}, want ${want}`);
  }
}

function dummyForType(type: string): unknown {
  if (type === "address") return "0x000000000000000000000000000000000000dEaD";
  if (type === "bool") return false;
  if (type.startsWith("bytes32")) return ZeroHash;
  if (type.startsWith("uint") || type.startsWith("int")) return 1n;
  if (type === "string") return "x";
  if (type === "bytes") return "0x";
  // Interface/contract types are ABI-encoded as address.
  return "0x000000000000000000000000000000000000dEaD";
}
