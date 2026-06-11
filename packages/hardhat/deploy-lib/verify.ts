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

  // (1) Golden-vector: the contract field-string constants must match deploy-lib/schemas.ts, so the
  //     UIDs we computed equal what the contracts self-derive. We assert the two self-deriving
  //     resolvers below; the rest are covered by the golden-vector test (test/Deploy.fork.test.ts).
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
