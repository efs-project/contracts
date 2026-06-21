import { ethers } from "hardhat";
import { EFSIndexer, AliasResolver, ListReader } from "../typechain-types";
import { SCHEMAS, computeSchemaUID, ResolverName } from "../deploy-lib/schemas";

/**
 * EFS Freeze-Set Conformance Simulation (ADR-0048)
 *
 * The deploy-safety tripwire. Asserts that the LIVE deployed stack registers EXACTLY the nine
 * frozen EAS schemas — ANCHOR, PROPERTY, DATA, PIN, TAG, MIRROR, LIST, LIST_ENTRY, REDIRECT —
 * each with the byte-identical field string, revocable flag, and resolver proxy that hash into its
 * permanent UID. Without this, the other simulate scripts can pass green against a stack that is
 * silently MISSING a schema (e.g. LIST/LIST_ENTRY/REDIRECT) — they'd simply never exercise it.
 *
 * For each frozen schema this checks three things agree:
 *   1. the on-chain self-derived UID getter (indexer / resolver),
 *   2. the UID recomputed off-chain from the frozen field string + live resolver proxy + revocable,
 *   3. the EAS SchemaRegistry record (uid, resolver, revocable, field string).
 * Plus: all nine UIDs are nonzero and pairwise distinct, and SORT_INFO is NOT registered (deferred).
 *
 * The frozen definitions are imported from deploy-lib/schemas.ts (the single source of truth), so a
 * drift between this gate and the freeze table is impossible by construction.
 *
 * Run: npx hardhat run scripts/simulate-freeze-set.ts --network localhost
 * Refs: ADR-0048, docs/SEPOLIA_FREEZE_TABLE.md, deploy-lib/schemas.ts
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
  console.log("  EFS Freeze-Set Conformance (ADR-0048)");
  console.log("  9 schemas: live UID == golden == registry");
  console.log("════════════════════════════════════════\n");

  const [deployer] = await ethers.getSigners();

  const indexer = (await ethers.getContract("Indexer", deployer)) as unknown as EFSIndexer;
  const aliasResolver = (await ethers.getContract("AliasResolver", deployer)) as unknown as AliasResolver;
  const listReader = (await ethers.getContract("ListReader", deployer)) as unknown as ListReader;

  // The live resolver-proxy address baked into each FROZEN-NINE schema's UID, keyed by the schemas.ts
  // ResolverName. WhiteoutResolver (the additive post-freeze WHITEOUT schema, ADR-0055) is NOT part of
  // this frozen-nine conformance check, so it is intentionally absent — the loop below filters to
  // `frozenNine`, which never indexes it. Hence a Partial map.
  const proxies: Partial<Record<ResolverName, string>> = {
    EFSIndexer: await indexer.getAddress(),
    EdgeResolver: await (await ethers.getContract("EdgeResolver", deployer)).getAddress(),
    MirrorResolver: await (await ethers.getContract("MirrorResolver", deployer)).getAddress(),
    ListResolver: await (await ethers.getContract("ListResolver", deployer)).getAddress(),
    ListEntryResolver: await (await ethers.getContract("ListEntryResolver", deployer)).getAddress(),
    AliasResolver: await aliasResolver.getAddress(),
  };

  // The on-chain self-derived UID getter for each frozen schema name.
  const liveUID: Record<string, () => Promise<string>> = {
    ANCHOR: () => indexer.ANCHOR_SCHEMA_UID(),
    PROPERTY: () => indexer.PROPERTY_SCHEMA_UID(),
    DATA: () => indexer.DATA_SCHEMA_UID(),
    PIN: () => indexer.PIN_SCHEMA_UID(),
    TAG: () => indexer.TAG_SCHEMA_UID(),
    MIRROR: () => indexer.MIRROR_SCHEMA_UID(),
    LIST: () => listReader.LIST_SCHEMA_UID(),
    LIST_ENTRY: () => listReader.LIST_ENTRY_SCHEMA_UID(),
    REDIRECT: () => aliasResolver.redirectSchemaUID(),
  };

  const easAddress = await indexer.getEAS();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const eas = (await ethers.getContractAt(
    "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol:IEAS",
    easAddress,
  )) as any;
  const registryAddr = await eas.getSchemaRegistry();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registry = (await ethers.getContractAt(
    "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol:ISchemaRegistry",
    registryAddr,
  )) as any;

  // The FROZEN nine (ADR-0048) are the schemas NOT on the WhiteoutResolver — WHITEOUT (ADR-0055) is an
  // additive post-freeze schema on a separate proxy, so it is excluded from the frozen-nine conformance
  // check (it has its own self-UID getter asserted in the deploy verify gate, not here).
  const frozenNine = SCHEMAS.filter(s => s.resolver !== "WhiteoutResolver");
  assert("freeze set has exactly 9 schemas (schemas.ts)", frozenNine.length === 9, `got ${frozenNine.length}`);

  const seen = new Map<string, string>(); // uid -> schema name (distinctness check)

  for (const s of frozenNine) {
    console.log(`\n── ${s.name} ──`);
    const computed = computeSchemaUID(s.fieldString, proxies[s.resolver]!, s.revocable);
    const onChain = await liveUID[s.name]();

    // 1. on-chain self-derived UID == off-chain golden recomputation.
    assert(`${s.name}: live UID == golden recomputation`, onChain.toLowerCase() === computed.toLowerCase(), onChain);

    // 2. nonzero.
    assert(`${s.name}: UID is nonzero`, onChain !== ethers.ZeroHash);

    // 3. pairwise distinct.
    const dup = seen.get(onChain.toLowerCase());
    assert(`${s.name}: UID is distinct`, dup === undefined, dup ? `collides with ${dup}` : "unique");
    seen.set(onChain.toLowerCase(), s.name);

    // 4. registered in the EAS SchemaRegistry with the exact frozen shape.
    const rec = await registry.getSchema(onChain);
    assert(`${s.name}: registered in EAS registry`, rec.uid.toLowerCase() === onChain.toLowerCase(), rec.uid);
    assert(
      `${s.name}: registry resolver == ${s.resolver} proxy`,
      rec.resolver.toLowerCase() === proxies[s.resolver]!.toLowerCase(),
      rec.resolver,
    );
    assert(`${s.name}: registry revocable == ${s.revocable}`, rec.revocable === s.revocable, String(rec.revocable));
    assert(`${s.name}: registry field string is frozen def`, rec.schema === s.fieldString, `"${rec.schema}"`);
  }

  // SORT_INFO is DEFERRED (ADR-0048; schemas.ts): it must NOT be registered in this freeze set.
  console.log(`\n── SORT_INFO (deferred) ──`);
  const sortInfoUID = await indexer.SORT_INFO_SCHEMA_UID();
  if (sortInfoUID === ethers.ZeroHash) {
    assert("SORT_INFO is unset on the indexer (deferred)", true, "zero UID");
  } else {
    const rec = await registry.getSchema(sortInfoUID);
    assert(
      "SORT_INFO is NOT registered in the freeze set (deferred)",
      rec.uid === ethers.ZeroHash,
      `indexer reports ${sortInfoUID}, registry record ${rec.uid}`,
    );
  }

  console.log("\n════════════════════════════════════════");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log("════════════════════════════════════════\n");

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
