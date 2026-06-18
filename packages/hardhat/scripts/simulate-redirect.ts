import { expect } from "chai";
import { ethers } from "hardhat";
import { AliasResolver, EFSIndexer } from "../typechain-types";

/**
 * EFS REDIRECT Simulation (ADR-0050)
 *
 * Exercises the REDIRECT schema + AliasResolver end-to-end against a deployed EFS
 * stack — the safety net before the PERMANENT on-chain schema freeze. REDIRECT is the
 * "this points at that" primitive: canonical/dedup (sameAs), version supersession
 * (supersededBy), and path symlinks (symlink).
 *
 * REDIRECT schema (FROZEN): "bytes32 target, uint16 kind". refUID = the SOURCE.
 * Kind taxonomy (resolver + client logic, NOT in the UID):
 *   0 = sameAs       (source + target both DATA)
 *   1 = supersededBy (source + target both DATA)
 *   2 = symlink      (source ANCHOR; target ANCHOR or DATA)
 *   3+ = reserved    (recorded, NOT type-checked; only target!=0 and target!=source enforced)
 *
 * Coverage:
 *   - Happy paths: every kind accepted via a REAL eas.attest (RedirectAttested event /
 *     nonzero UID), plus a successful revoke and the self-derived-schema-UID match.
 *   - Write-time guard reverts: every AliasResolver custom error.
 *   - Read-time resolution (ADR-0050 §"Write-time guards vs read-time resolution"):
 *     a SMALL client-side reference resolver, NOT on-chain — demonstrates the frozen
 *     kind taxonomy composes (supersededBy chain, sameAs cycle determinism, symlink
 *     one-hop, depth cap, reserved-kind skip, untrusted-attester skip).
 *
 * Run: npx hardhat run scripts/simulate-redirect.ts --network localhost
 * Refs: ADR-0050.
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

// Wrap a reverting attest/revoke in chai's revertedWithCustomError matcher and fold the
// result into the same PASS/FAIL tally as assert(). chai's hardhat matchers are auto-loaded
// by hardhat.config, so `expect(...).to.be.revertedWithCustomError` is available here.
async function assertReverts(
  label: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  promise: Promise<any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contract: any,
  errorName: string,
) {
  try {
    await expect(promise).to.be.revertedWithCustomError(contract, errorName);
    console.log(`  ${PASS} ${label} — reverts ${errorName}`);
    passed++;
  } catch (e) {
    console.log(`  ${FAIL} ${label} — expected revert ${errorName}: ${(e as Error).message.split("\n")[0]}`);
    failed++;
  }
}

async function main() {
  console.log("════════════════════════════════════════");
  console.log("  EFS REDIRECT Simulation (ADR-0050)");
  console.log("  sameAs · supersededBy · symlink · reserved");
  console.log("════════════════════════════════════════\n");

  const [deployer, alice, bob] = await ethers.getSigners();

  // ── Connect to deployed contracts ────────────────────────────────────────────
  const indexer = (await ethers.getContract("Indexer", deployer)) as unknown as EFSIndexer;
  const aliasResolver = (await ethers.getContract("AliasResolver", deployer)) as unknown as AliasResolver;

  const easAddr = await indexer.getEAS();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const eas = (await ethers.getContractAt(
    "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol:IEAS",
    easAddr,
  )) as any;

  // Schema UIDs — read from BOTH the indexer and the resolver and prove they agree.
  const redirectSchemaUID = await aliasResolver.redirectSchemaUID();
  const dataSchemaUID = await indexer.DATA_SCHEMA_UID();
  const anchorSchemaUID = await indexer.ANCHOR_SCHEMA_UID();
  const propertySchemaUID = await indexer.PROPERTY_SCHEMA_UID(); // a non-DATA / non-ANCHOR "other" schema
  const resolverDataUID = await aliasResolver.dataSchemaUID();
  const resolverAnchorUID = await aliasResolver.anchorSchemaUID();
  const aliasResolverAddr = await aliasResolver.getAddress();

  console.log(`AliasResolver:     ${aliasResolverAddr}`);
  console.log(`EAS:               ${easAddr}`);
  console.log(`REDIRECT schema:   ${redirectSchemaUID}`);
  console.log(`DATA schema:       ${dataSchemaUID}`);
  console.log(`ANCHOR schema:     ${anchorSchemaUID}\n`);

  const enc = new ethers.AbiCoder();
  const { ZeroHash, ZeroAddress } = ethers;

  // Session suffix so re-running doesn't collide on ANCHOR names (DuplicateFileName).
  const S = Date.now().toString(36);

  // ── Helpers ──────────────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  const encodeRedirect = (target: string, kind: number) => enc.encode(["bytes32", "uint16"], [target, kind]);

  // DATA is an empty attestation (pure identity, ADR-0049): non-revocable, no payload, standalone.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mintData = async (signer: any): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: dataSchemaUID,
      data: { recipient: ZeroAddress, expirationTime: 0n, revocable: false, refUID: ZeroHash, data: "0x", value: 0n },
    });
    return getUID(await tx.wait());
  };

  // ANCHOR field string is "string name, bytes32 forSchema" (forSchema, not schemaUID). Anchors
  // are non-revocable. We attach them to root so the indexer's path checks are satisfied; names
  // get the session suffix so the script is re-runnable.
  const rootUID = await indexer.rootAnchorUID();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mintAnchor = async (signer: any, name: string, parent: string = rootUID): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: 0n,
        revocable: false,
        refUID: parent,
        data: enc.encode(["string", "bytes32"], [name, ZeroHash]),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  // An attestation under some OTHER (non-DATA / non-ANCHOR) schema, used as a symlink target that
  // is neither ANCHOR nor DATA. PROPERTY ("string value", non-revocable, PropertyResolver accepts
  // any payload) is the cleanest stand-in available on the deployed stack.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mintOther = async (signer: any): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: propertySchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: 0n,
        revocable: false,
        refUID: ZeroHash,
        data: enc.encode(["string"], [`redirect-sim-other-${S}`]),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  // Attest a REDIRECT: refUID = source, payload = (target, kind), revocable=true, no expiry.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const attestRedirect = async (signer: any, source: string, target: string, kind: number) => {
    const tx = await eas.connect(signer).attest({
      schema: redirectSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: 0n,
        revocable: true,
        refUID: source,
        data: encodeRedirect(target, kind),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  // ── Section 0: self-derived schema UID matches the registered one ─────────────

  console.log("Section 0: self-derived REDIRECT schema UID");

  assert("resolver dataSchemaUID() == indexer DATA_SCHEMA_UID()", resolverDataUID === dataSchemaUID);
  assert("resolver anchorSchemaUID() == indexer ANCHOR_SCHEMA_UID()", resolverAnchorUID === anchorSchemaUID);
  // The proxy-derived UID = keccak256(packed(REDIRECT_DEFINITION, proxyAddr, true)). If it diverged
  // (the impl-vs-proxy self-UID bug, ADR-0048) onAttest would reject every genuine REDIRECT with
  // WrongSchema — so a successful attest below also proves this, but assert it directly here too.
  const offChainUID = ethers.solidityPackedKeccak256(
    ["string", "address", "bool"],
    ["bytes32 target, uint16 kind", aliasResolverAddr, true],
  );
  assert("redirectSchemaUID() == off-chain proxy-derived UID", redirectSchemaUID === offChainUID);

  // ── Section 1: happy paths (real attests succeed) ─────────────────────────────

  console.log("\nSection 1: happy paths");

  // sameAs (kind 0): DATA -> DATA
  {
    const src = await mintData(alice);
    const dst = await mintData(alice);
    const uid = await attestRedirect(alice, src, dst, 0);
    assert("sameAs (kind 0) DATA→DATA accepted (nonzero UID)", uid !== ZeroHash, uid);
  }

  // supersededBy (kind 1): DATA -> DATA
  {
    const src = await mintData(alice);
    const dst = await mintData(alice);
    const uid = await attestRedirect(alice, src, dst, 1);
    assert("supersededBy (kind 1) DATA→DATA accepted (nonzero UID)", uid !== ZeroHash, uid);
  }

  // symlink (kind 2): ANCHOR -> ANCHOR
  {
    const src = await mintAnchor(alice, `link-aa-${S}`);
    const dst = await mintAnchor(alice, `dest-aa-${S}`);
    const uid = await attestRedirect(alice, src, dst, 2);
    assert("symlink (kind 2) ANCHOR→ANCHOR accepted (nonzero UID)", uid !== ZeroHash, uid);
  }

  // symlink (kind 2): ANCHOR -> DATA
  {
    const src = await mintAnchor(alice, `link-ad-${S}`);
    const dst = await mintData(alice);
    const uid = await attestRedirect(alice, src, dst, 2);
    assert("symlink (kind 2) ANCHOR→DATA accepted (nonzero UID)", uid !== ZeroHash, uid);
  }

  // reserved (kind 3): DATA -> DATA (recorded, not type-checked).
  {
    const src = await mintData(alice);
    const dst = await mintData(alice);
    const uid = await attestRedirect(alice, src, dst, 3);
    assert("reserved (kind 3) DATA→DATA accepted (nonzero UID)", uid !== ZeroHash, uid);
  }

  // reserved (kind 3) with MISMATCHED types still passes — typing is skipped for kind>=3, only
  // target!=0 and target!=source are enforced. Source = OTHER schema, target = ANCHOR.
  {
    const src = await mintOther(alice);
    const dst = await mintAnchor(alice, `reserved-mismatch-${S}`);
    const uid = await attestRedirect(alice, src, dst, 3);
    assert("reserved (kind 3) OTHER→ANCHOR (mismatched types) still accepted", uid !== ZeroHash, uid);
  }

  // Revoke a REDIRECT (revocable=true → onRevoke returns true).
  {
    const src = await mintData(alice);
    const dst = await mintData(alice);
    const uid = await attestRedirect(alice, src, dst, 0);
    let revokeOk = true;
    try {
      await eas.connect(alice).revoke({ schema: redirectSchemaUID, data: { uid, value: 0n } });
    } catch {
      revokeOk = false;
    }
    assert("revoke of a REDIRECT succeeds (onRevoke true)", revokeOk);
  }

  // ── Section 2: write-time guard reverts (every AliasResolver custom error) ─────

  console.log("\nSection 2: write-time guards (reverts)");

  // ZeroTarget: target == 0x00..0
  {
    const src = await mintData(alice);
    await assertReverts(
      "ZeroTarget (target == 0)",
      attestRedirect(alice, src, ZeroHash, 0),
      aliasResolver,
      "ZeroTarget",
    );
  }

  // SelfLoop: target == source
  {
    const src = await mintData(alice);
    await assertReverts("SelfLoop (target == source)", attestRedirect(alice, src, src, 0), aliasResolver, "SelfLoop");
  }

  // SourceNotData: sameAs/supersededBy with a non-DATA source (ANCHOR source).
  {
    const src = await mintAnchor(alice, `notdata-src-${S}`);
    const dst = await mintData(alice);
    await assertReverts(
      "SourceNotData (sameAs, ANCHOR source)",
      attestRedirect(alice, src, dst, 0),
      aliasResolver,
      "SourceNotData",
    );
  }

  // TargetNotData: sameAs/supersededBy with a non-DATA target (ANCHOR target).
  {
    const src = await mintData(alice);
    const dst = await mintAnchor(alice, `notdata-tgt-${S}`);
    await assertReverts(
      "TargetNotData (supersededBy, ANCHOR target)",
      attestRedirect(alice, src, dst, 1),
      aliasResolver,
      "TargetNotData",
    );
  }

  // SourceNotAnchor: symlink with a non-ANCHOR source (DATA source).
  {
    const src = await mintData(alice);
    const dst = await mintAnchor(alice, `sym-dest-${S}`);
    await assertReverts(
      "SourceNotAnchor (symlink, DATA source)",
      attestRedirect(alice, src, dst, 2),
      aliasResolver,
      "SourceNotAnchor",
    );
  }

  // TargetNotAnchorOrData: symlink with a target that is neither ANCHOR nor DATA (OTHER schema).
  {
    const src = await mintAnchor(alice, `sym-link-${S}`);
    const dst = await mintOther(alice);
    await assertReverts(
      "TargetNotAnchorOrData (symlink, OTHER target)",
      attestRedirect(alice, src, dst, 2),
      aliasResolver,
      "TargetNotAnchorOrData",
    );
  }

  // NotRevocable: attest a REDIRECT with revocable=false.
  {
    const src = await mintData(alice);
    const dst = await mintData(alice);
    const promise = eas.connect(alice).attest({
      schema: redirectSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: 0n,
        revocable: false,
        refUID: src,
        data: encodeRedirect(dst, 0),
        value: 0n,
      },
    });
    await assertReverts("NotRevocable (revocable=false)", promise, aliasResolver, "NotRevocable");
  }

  // HasExpiration: attest with expirationTime != 0 (far-future passes EAS's own check, reaches the guard).
  {
    const src = await mintData(alice);
    const dst = await mintData(alice);
    const promise = eas.connect(alice).attest({
      schema: redirectSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: 9_999_999_999n,
        revocable: true,
        refUID: src,
        data: encodeRedirect(dst, 0),
        value: 0n,
      },
    });
    await assertReverts("HasExpiration (expirationTime != 0)", promise, aliasResolver, "HasExpiration");
  }

  // WrongSchema: register a FOREIGN schema pointing at the AliasResolver, then attest under it.
  // EAS lets anyone register a new schema with this resolver; onAttest must reject it (otherwise
  // the foreign schema would bypass all write-time typing). BadPayload is unreachable from EAS for
  // genuine REDIRECTs (EAS enforces field shape), so it is covered together here: the foreign
  // schema's payload would also trip BadPayload, but WrongSchema fires first — so we assert
  // WrongSchema only. (BadPayload is additionally covered in test/AliasResolver.test.ts.)
  {
    const registryAddr = await eas.getSchemaRegistry();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registry = (await ethers.getContractAt(
      "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol:ISchemaRegistry",
      registryAddr,
    )) as any;

    // A foreign field string (NOT the frozen REDIRECT definition), pointed at the AliasResolver,
    // revocable=true. Suffix the field string so re-runs register a fresh UID rather than colliding.
    const foreignDef = `bytes32 target, uint16 kind, uint256 nonce_${S}`;
    await (await registry.connect(alice).register(foreignDef, aliasResolverAddr, true)).wait();
    // Derive the foreign schema UID deterministically rather than parsing the Registered event:
    // EAS computes a schema UID as keccak256(abi.encodePacked(schema, resolver, revocable)) — the
    // SAME formula AliasResolver uses to self-derive its own REDIRECT UID. (Event parsing is
    // unreliable here: the ISchemaRegistry typechain ABI may omit the Registered fragment, so
    // parseLog finds nothing and the UID comes back zero.)
    const foreignSchemaUID = ethers.keccak256(
      ethers.solidityPacked(["string", "address", "bool"], [foreignDef, aliasResolverAddr, true]),
    );
    // Confirm the registry actually has it (registered with this resolver), so the attest below
    // reaches AliasResolver.onAttest rather than tripping EAS's own InvalidSchema first.
    const foreignRec = await registry.getSchema(foreignSchemaUID);
    assert(
      "foreign schema registered against AliasResolver",
      foreignRec.uid === foreignSchemaUID && foreignRec.resolver.toLowerCase() === aliasResolverAddr.toLowerCase(),
      foreignSchemaUID,
    );

    const src = await mintData(alice);
    const dst = await mintData(alice);
    // Encode a valid-length REDIRECT payload so we get past EAS into onAttest; the schema UID is
    // foreign, so onAttest reverts WrongSchema before any typing.
    const promise = eas.connect(alice).attest({
      schema: foreignSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: 0n,
        revocable: true,
        refUID: src,
        data: encodeRedirect(dst, 0),
        value: 0n,
      },
    });
    await assertReverts("WrongSchema (foreign schema → AliasResolver)", promise, aliasResolver, "WrongSchema");
  }

  // ── Section 3: read-time resolution (CLIENT convention, NOT on-chain/frozen) ───
  //
  // ADR-0050 §"Write-time guards vs read-time resolution": multi-hop resolution lives in the
  // client/SDK, NOT in the resolver and NOT in the frozen schema. The function below is a SMALL
  // TS reference resolver over an IN-MEMORY edge set (the redirects we just created) — it does NOT
  // build an on-chain index. Its only purpose is to show the frozen kind taxonomy composes.

  console.log("\nSection 3: read-time resolution (client convention, ADR-0050)");

  const D_MAX = 16;

  type Redirect = { source: string; target: string; kind: number; attester: string };
  const edges: Redirect[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recordEdge = async (signer: any, source: string, target: string, kind: number) => {
    await attestRedirect(signer, source, target, kind);
    edges.push({ source, target, kind, attester: (await signer.getAddress()).toLowerCase() });
  };

  /**
   * Reference resolver. Follows supersededBy (1) then sameAs (0) edges from `start`:
   *   - one-hop symlink (2) follow (a symlink resolves to its immediate target, no chaining)
   *   - depth cap D_MAX terminates runaway chains
   *   - sameAs is symmetric/canonicalizing: on a cycle, resolve to the lowest UID in the cycle
   *     (deterministic regardless of entry point)
   *   - kind >= 3 reserved edges are NEVER auto-followed
   *   - edges from an attester not in `trusted` are skipped
   */
  const resolve = (start: string, trusted: Set<string>): string => {
    let current = start;
    const seen = new Set<string>([current]);
    for (let depth = 0; depth < D_MAX; depth++) {
      // supersededBy takes precedence: a superseded DATA is replaced by its successor.
      const sup = edges.find(e => e.source === current && e.kind === 1 && trusted.has(e.attester));
      if (sup) {
        if (seen.has(sup.target)) break;
        seen.add(sup.target);
        current = sup.target;
        continue;
      }
      // sameAs: canonicalize. Collect the connected sameAs component reachable from `current`
      // (treat sameAs as undirected for cycle determinism) and jump to its lowest UID.
      const outSame = edges.find(e => e.source === current && e.kind === 0 && trusted.has(e.attester));
      if (outSame) {
        const component = new Set<string>([current]);
        const stack = [current];
        while (stack.length) {
          const node = stack.pop() as string;
          for (const e of edges) {
            if (e.kind !== 0 || !trusted.has(e.attester)) continue;
            if (e.source === node && !component.has(e.target)) {
              component.add(e.target);
              stack.push(e.target);
            }
            if (e.target === node && !component.has(e.source)) {
              component.add(e.source);
              stack.push(e.source);
            }
          }
        }
        // lowest-UID-in-cycle determinism.
        const canonical = [...component].sort()[0];
        if (canonical === current) break;
        current = canonical;
        break; // sameAs canonicalization is terminal
      }
      break; // no followable edge from `current`
    }
    return current;
  };

  const oneHopSymlink = (start: string, trusted: Set<string>): string => {
    const sym = edges.find(e => e.source === start && e.kind === 2 && trusted.has(e.attester));
    return sym ? sym.target : start;
  };

  const aliceTrusted = new Set<string>([(await alice.getAddress()).toLowerCase()]);

  // 3a: supersededBy chain A <- B <- C ⇒ resolving C yields A.
  {
    const A = await mintData(alice);
    const B = await mintData(alice);
    const C = await mintData(alice);
    await recordEdge(alice, B, A, 1); // B supersededBy A
    await recordEdge(alice, C, B, 1); // C supersededBy B
    assert("3a supersededBy chain C→B→A resolves to A", resolve(C, aliceTrusted) === A, A);
  }

  // 3b: 2-node sameAs cycle ⇒ deterministic resolution to the lowest UID from either entry point.
  {
    const X = await mintData(alice);
    const Y = await mintData(alice);
    await recordEdge(alice, X, Y, 0); // X sameAs Y
    await recordEdge(alice, Y, X, 0); // Y sameAs X (cycle)
    const lowest = [X, Y].sort()[0];
    assert("3b sameAs cycle resolves to lowest UID from X", resolve(X, aliceTrusted) === lowest, lowest);
    assert(
      "3b sameAs cycle resolves to lowest UID from Y (deterministic)",
      resolve(Y, aliceTrusted) === lowest,
      lowest,
    );
  }

  // 3c: one-hop symlink follow (ANCHOR → ANCHOR), and symlinks are not chained.
  {
    const linkA = await mintAnchor(alice, `sym3c-a-${S}`);
    const linkB = await mintAnchor(alice, `sym3c-b-${S}`);
    const dest = await mintAnchor(alice, `sym3c-dest-${S}`);
    await recordEdge(alice, linkA, linkB, 2); // linkA → linkB
    await recordEdge(alice, linkB, dest, 2); // linkB → dest
    assert(
      "3c one-hop symlink follow does NOT chain (linkA → linkB only)",
      oneHopSymlink(linkA, aliceTrusted) === linkB,
      linkB,
    );
  }

  // 3d: depth cap terminates (long supersededBy chain longer than D_MAX is truncated, not hung).
  {
    let prev = await mintData(alice);
    const head = prev;
    for (let i = 0; i < D_MAX + 4; i++) {
      const next = await mintData(alice);
      await recordEdge(alice, prev, next, 1); // prev supersededBy next
      prev = next;
    }
    const out = resolve(head, aliceTrusted);
    // Terminates without hanging; cannot have advanced more than D_MAX hops past head.
    assert("3d depth cap terminates a chain longer than D_MAX", out !== head);
  }

  // 3e: reserved kind (>=3) is never auto-followed.
  {
    const src = await mintData(alice);
    const dst = await mintData(alice);
    await recordEdge(alice, src, dst, 3); // reserved
    assert("3e reserved kind (3) is NOT auto-followed", resolve(src, aliceTrusted) === src, src);
  }

  // 3f: a redirect from an UNTRUSTED attester is skipped.
  {
    const src = await mintData(alice);
    const dst = await mintData(alice);
    await recordEdge(bob, src, dst, 1); // bob (untrusted) supersededBy
    assert("3f untrusted-attester redirect is skipped", resolve(src, aliceTrusted) === src, src);
    const bobTrusted = new Set<string>([(await bob.getAddress()).toLowerCase()]);
    assert("3f same redirect followed when bob IS trusted", resolve(src, bobTrusted) === dst, dst);
  }

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
