# Filesystem-Operations Capability Audit (pre-launch freeze window)

**Date:** 2026-06-20
**Question asked:** Do we have solid plans for renaming, moving, deleting, symlinks/shortcuts, hardlinks, absolute-vs-relative paths — and anything else a filesystem needs? Should we change the frozen schemas or contracts to make the design good for the long term *while we still can* (schemas frozen on Sepolia but redeployable since no one uses them yet)?

**Method:** 7 parallel expert subagents (one per operation + a POSIX-completeness sweep + a frozen-field economist), then 2 adversarial reviewers (a "you'll regret this" critic and an additivity-claim verifier). Every structural claim is grounded in `file:line` / ADR. This doc is the synthesis.

---

## TL;DR

**Recommend zero changes to the 9 frozen field strings or revocable flags. They are right for the long term.** Every filesystem operation either works today by composing existing primitives, or extends *additively* later (new schema / new view contract / pre-burn proxy upgrade) without orphaning data. The "redeploy while we still can" window is **mostly not the binding constraint** — only a tiny set of things actually close at first durable use, and none of them is a capability gap.

The real to-do list is **documentation and spec reservations**, plus **two opportunistic-now proxy tweaks** you can fold into the redeploy you're already doing. Nothing here is a launch blocker; everything is on a clear, classified path.

---

## The framing that matters: three tiers of "still changeable"

"While we still can" is not one deadline — it's three. A schema's EAS UID = `keccak256(fieldString, resolverProxyAddress, revocable)` ([schemas.ts:85-87](packages/hardhat/deploy-lib/schemas.ts)). The six resolvers run behind **upgradeable proxies** until "burn" (ProxyAdmin ownership renounced). That gives three distinct change budgets:

| Tier | What it covers | Deadline | Cost |
|---|---|---|---|
| **(a) Free forever — additive** | A *new* schema, a *new*/redeployed view contract (`EFSRouter`, `EFSFileView`, `ListReader`), a new `/transports/*` anchor, a new PROPERTY key, a new REDIRECT `kind` convention | never closes | orphans nothing |
| **(b) Free until burn — proxy upgrade** | Resolver *logic*: `MAX_ANCHOR_DEPTH`, anchor-name length cap, `expirationTime` policy, new typed REDIRECT-kind write-guards, reverse indexes in the kernel, read-time followers placed in a resolver | the **burn**, not the freeze | redeploy an impl behind the existing proxy; address + UIDs unchanged |
| **(c) Free only now — true one-way door** | The **9 field strings**, the **9 revocable flags**, and **which resolver-proxy address backs each schema** | **first durable attestation** | irreversible; orphans all prior data |

The only things you are about to lose forever are the tier-(c) items — and the audit's finding is that **all nine field strings and flags are correct**, so tier (c) requires *no* action. Almost everything people think of as "we'd better lock this in now" is actually tier (a) or (b).

> **Confirmed directly during review:** `MAX_ANCHOR_DEPTH = 32` is a `public constant` in implementation bytecode ([EFSIndexer.sol:141](packages/hardhat/contracts/EFSIndexer.sol)) behind the upgradeable proxy — so it is **tier (b), free until burn**, not a hard freeze door. One reviewer initially mis-classified it as irreversible; the proxy mechanics say otherwise. It's still worth deciding now (below), just not under freeze pressure.

---

## Capability status — what works, what's missing

| Operation | Works today? | Mechanism / gap | Fix tier for the gap |
|---|---|---|---|
| **Rename file** | ✅ (own content) | New name ANCHOR + re-PIN the DATA + revoke old PIN; batchable atomically in one `multiAttest`. Old anchor persists forever as a harmless husk (anchors non-revocable). | — |
| **Rename inherited file** | ⚠️ | Can add the new name but **cannot suppress** the inherited old name → shows under both. Needs **WHITEOUT** (ADR-0055). | (a) additive schema |
| **Rename folder** | ⚠️ expensive | No reparent (children bind to parent by immutable `refUID`); today = rebuild the whole subtree (~3N+3F attestations). Cheap path = read-time symlink follow. | (a) additive view |
| **Move file** | ✅ (own content) | Re-PIN under the new folder's anchor + ancestor-walk visibility TAGs + revoke old PIN. DATA / mirrors / properties preserved (path-independent). | — |
| **Move folder** | ⚠️ expensive | Same subtree-rebuild cost as folder rename, or future REDIRECT-symlink follow. | (a) additive view |
| **Delete** | ✅ | Revoke the placement PIN (→ unreachable) and/or mirrors. DATA/ANCHOR/PROPERTY are non-revocable → **"unreachable," never "gone."** Default reads exclude revoked (ADR-0051), honored by view + router. | — |
| **Delete inherited / system content from your view** | ⚠️ | Can't revoke someone else's attestation; lenses are additive-only. Needs **WHITEOUT** cross-lens negative mask (ADR-0055). | (a) additive schema |
| **Symlink / shortcut** | ⚠️ half-built | REDIRECT `kind=2` is frozen and write-time-typed by AliasResolver, **but no contract follows it at read time** ([EFSRouter `_findDataAtPath`](packages/hardhat/contracts/EFSRouter.sol) reads only the DATA-pin slot). On-chain clients get nothing until a follower ships. | (a) additive view + spec |
| **Hardlink** | ✅ native | Same DATA UID under many anchors = many PINs (PIN slot keyed on `(definition, attester, targetSchema)`, not on DATA). First-class and documented. | — |
| **Copy** | ✅ | Mint new DATA + new PIN (don't share the DATA → independent future edits). | — |
| **Versioning** | ✅ write / ⚠️ read | REDIRECT `supersededBy` (kind=1) chains DATA→DATA; "shortcut to latest" needs the same read-time follower as symlink. | (a) additive view |
| **Absolute paths** | ✅ | Container-relative-from-a-`bytes32` model: top segment classifies into address / schemaUID / attestationUID / anchor-name (ADR-0033), each seeding a parent; walk is identical. Path nodes are immutable + permanent; only their lens-scoped *content* varies. | — |
| **Relative paths (`.`/`..`)** | ❌ deliberate | `.`/`..` rejected as anchor names (ADR-0025). Everything is relative-to-a-bytes32-container natively; `../x` = `getParent` + `resolveAnchor` client-side. Sound non-goal — just undocumented. | doc |
| **URL portability** | ⚠️ | Router address is in the `web3://<router>/…` URL; a router redeploy rots URLs. No router-independent canonical form yet (ENS `efs.eth` proposed). | (a) additive (ENS + seed) |

**Cross-cutting "what else" sweep** (copy, stat/size/contentType/mtime/ctime/owner, mkdir/rmdir/list/dir-metadata, xattrs/tags, search, events, federation, snapshots, atomicity, quotas) all came back **supported-today or cleanly additive**. The only true *absences* are permissions (deliberate — permissionless write + lens-scoped read + client-side encryption; do **not** add a write-gate field) and the overlayfs whiteout (decided as the additive WHITEOUT schema).

---

## What to actually do — classified, none are field-string changes

### NOW — doc/spec only, before durable seeding
1. **WHITEOUT "negative-terminal" reservation + seeding ban.** The one binding pre-freeze act (ADR-0055): the REDIRECT read-time resolution spec being pinned now must leave room for a *stop-don't-follow* terminal, and no whiteout may be encoded via any sentinel (reserved `kind`, `weight<0` TAG, sentinel PIN, tombstone DATA) into durable data. No contract change. This is the single most important interaction to confirm before launch — because a positive-only resolution order frozen now could otherwise contradict lens-local delete/rename later.
2. **Pin the REDIRECT read-time resolution spec + conformance vectors** (depth cap, cycle = lowest-UID-in-SCC, lens precedence, kind-following) **before any redirect is seeded** (ADR-0050 action item 2). Frozen fields are fine; this gates *minting redirects*, not the freeze.
3. **Pin the `contentHash`/`size`/`cid` self-describing encoding** (multibase-multihash / CID, not bare keccak hex) **before any durable hash is minted.** PROPERTY is non-revocable → an early bare digest is permanent and algorithm-ambiguous. Schema (`string value`) is fine; this is a convention gate.
4. **Document three things for users/clients:** (a) deletion = *unreachable, not erased* (DATA/ANCHOR/PROPERTY persist forever — a trust/legal expectation for an archival system); (b) a cross-attester hardlink must re-attest a MIRROR + `contentType` under the placing lens, or the file resolves to unreachable bytes (lens-scoped mirror resolution); (c) no relative paths — the bytes32 container is the cursor.

### OPPORTUNISTIC NOW — fold into the redeploy you're already doing (technically tier-b, free until burn)
5. **Raise `MAX_ANCHOR_DEPTH = 32` — it is anomalously low.** A dedicated OS/filesystem survey (2026-06-20) found **no modern filesystem imposes an explicit depth cap at all** — depth is an emergent consequence of path-length limits, never a declared maximum. ext4, XFS, Btrfs, ZFS, APFS, NTFS: *no depth limit*. The only confirmed hard depth cap in the wild is ISO 9660's 8 levels (a 1988 CD-ROM format, since lifted). Real path-length ceilings imply far deeper trees than 32: Linux `PATH_MAX` 4096 B ⇒ ~2048 levels of minimal components; Windows long-path mode 32,767 chars ⇒ ~16,000 levels; macOS `PATH_MAX` 1024 B. EFS's 32 is a hard *creation* revert (`AnchorTooDeep`, [EFSIndexer.sol:426](packages/hardhat/contracts/EFSIndexer.sol)) that would reject deep trees every real OS legally holds — directly violating the mirror-external-filesystems goal. (Real trees stay shallow in practice — worst cited `node_modules` ≈11 levels, Java/Hive 4–6 — but the cap must not reject what an OS *can* address.)

   **Why a cap exists at all:** to bound gas on the ancestor-chain walks (`_propagateContains`, `_indexGlobal`) — linear in depth, amortized-O(1) in steady state via early-break (ADR-0021). That purpose is best served by a **depth counter** (a path-byte-length cap, as real OSes use, does *not* bound the walk — 2048 single-char components = 2048 iterations). So keep the counter form; just raise the number. Gas is the only cost and it stays well under block limit: ~2.1K gas/level ⇒ ~537K at 256, ~2.1M at 1024 (a one-time cost borne only by whoever creates a pathologically deep chain).

   **✅ DECIDED & DONE (2026-06-20): raised to 1024** ([ADR-0058](docs/adr/0058-raise-max-anchor-depth-and-no-name-length-cap.md), supersedes ADR-0021). Clean power of two, ~90× the deepest real-world tree ever cited, gas-safe (~2.1M worst-case one-time, self-paid), keeps the depth-counter form. Free-until-burn proxy upgrade, folded into the redeploy. (256 was the conservative fallback; 32/128/256 all rejected as they'd reject legal real-OS trees.)
6. **Anchor-name length cap — ✅ DECIDED AGAINST (2026-06-20):** do NOT cap ([ADR-0058](docs/adr/0058-raise-max-anchor-depth-and-no-name-length-cap.md)). It's not required for correctness; a natural ceiling already exists (validation + calldata cost is O(length), so absurd names exceed block gas and revert, self-paid); lens-scoping means a huge name only burdens viewers who trust its creator (no public grief surface); and display truncation is a client concern (ADR-0056 principle). Generosity future-proofs legitimate long Schelling-point names (hashes, CIDs, descriptors). Note: every real OS *does* cap per-component names at ~255, so a name >255 can't round-trip *out* to a conventional filesystem — but that's a client/export concern and mirror-*in* never produces one. A generous 8192-byte backstop (matching `MAX_URI_LENGTH`) remains available if pure anti-bloat is ever wanted; deliberately not added now.

### PRE-BURN — decide before immutability, not before freeze
7. **`expirationTime == 0` stance.** Every resolver rejects expiry today; keep it for v1 (avoids a third active/revoked/expired filter state). Explicitly revisit allowing expiry on **MIRROR** specifically (already revocable; expired ≈ revoked) before burn. It's resolver logic (tier b), so the deadline is burn.
8. **Event-versioning slot** for subgraph consumers (event ABIs harden at burn).
9. **SORT_INFO** registration — verified genuinely additive (the kernel stores it zeroed and the overlay reaches the kernel through *permissionless* `index()`, not the authorized path). Register the 10th schema whenever sorting is ready.

### DEFER — post-launch additive, no freeze impact
- WHITEOUT schema + `WhiteoutResolver` + `EFSFileView` redeploy.
- Read-time symlink/redirect follower in the redeployable `EFSFileView`/`EFSRouter` (so on-chain clients aren't each re-implementing graph-walking).
- On-chain reverse content index (find-DATA-by-hash; enumerate-hardlinks / link-count). The kernel already keeps forward reverse-reference indices; this is a view or pre-burn kernel upgrade.
- ENS `efs.eth` router naming for URL portability across router redeploys.

### One sign-off worth making explicit
**The revocable-flag symmetry is the most load-bearing schema decision in the set:** value/identity schemas non-revocable (ANCHOR, DATA, LIST, PROPERTY); claim/edge schemas revocable (PIN, TAG, MIRROR, LIST_ENTRY, REDIRECT) (ADR-0052). It's what makes shared values safe (can't be yanked from bindings) and deletion possible (revoke the edge). Every flip is a tier-(c) one-way door. They currently all match the principle — worth a deliberate human "yes, confirmed" against the table before first durable use.

---

## Bottom line

The frozen 9-schema surface is **future-proof as-is**, and the FS-operations lens confirms the repo's earlier "zero freeze-blockers" verdict. The architecture's payoff — minimal core identity/edge schemas with everything optional pushed into PROPERTYs, sibling schemas, and open `bytes32`/enum vocabularies — is exactly what makes the minimalism safe: DATA is empty (nothing can be missing), MIRROR/TAG/REDIRECT/ANCHOR carry open vocabularies (new kinds need no new UID), and LIST_ENTRY already proved a field can be *extracted* into a PROPERTY (ADR-0046). The only items that genuinely close at launch (field strings, flags, resolver bindings) are all correct. Everything else is additive-forever or free-until-burn. **Don't spend the freeze window on schema changes — spend it on the four NOW doc/spec reservations, and opportunistically bump `MAX_ANCHOR_DEPTH` + add the name-length cap into the redeploy.**
