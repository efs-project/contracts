// Verify gate (Phase D deploy core) — docs/DEPLOYMENT.md §3 step 3, SEPOLIA_FREEZE_TABLE.md
// "Pre-registration verification". Runs AFTER deploy+init, BEFORE any schema is registered. Any
// failure throws — the orchestration aborts before the freeze gate, so no schema is ever registered
// against an unverified proxy.

import { Signer, ZeroHash } from "ethers";
import { ethers } from "hardhat";
import { EAS_ADDRESS } from "./addresses";
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
  //     PR #24 P2: a Phase-1 Safe propose resume deploys no impls (no remaining batch consumes them), so
  //     `d.impl` is empty there — the impl-direct check is skipped. The impl's _disableInitializers lock
  //     is a static property of the impl bytecode (checked directly on every Phase-0 deploy and by the
  //     golden-vector test); it cannot regress on a resume where the live proxies are already deployed.
  //     The proxy 2nd-initialize lock — the gate that actually protects the to-be-registered proxies —
  //     always runs.
  console.log("  [verify] initialize() locked (2nd proxy call + impl direct call revert)...");
  for (const d of Object.values(deploys)) {
    const proxy = await ethers.getContractAt(d.resolver, d.proxy, deployer);
    // 2nd initialize on the proxy — argument shape varies per resolver; any args revert on `initializer`.
    const reinit = (proxy as any).initialize.fragment;
    const dummyArgs = reinit.inputs.map((i: any) => dummyForType(i.type));
    await expectRevert((proxy as any).initialize(...dummyArgs), `${d.resolver} proxy 2nd initialize`);
    if (d.impl) {
      const impl = await ethers.getContractAt(d.resolver, d.impl, deployer);
      await expectRevert((impl as any).initialize(...dummyArgs), `${d.resolver} impl direct initialize`);
    }
  }

  // (3) self-UID getters == computed == to-be-registered (the ListEntry-class bug guard).
  console.log("  [verify] self-UID getters (ListEntry/Alias) == computed UID...");
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
