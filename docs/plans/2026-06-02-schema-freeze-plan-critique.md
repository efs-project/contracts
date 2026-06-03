# Critique synthesis — schema-freeze build plan

Multi-lens expert review (7 viewpoints) of `2026-06-02-schema-freeze-build-plan.md`, each finding adversarially verified against the actual contracts/EAS source. **84 agents; 66 findings confirmed (4 critical, 27 high, 32 med, 3 low); 11 over-stated findings refuted/downgraded.**

## Verdict

**The architecture holds; the plan needs a revision pass.** 5/7 lenses said "needs-rework," but every "needs-rework" is about the plan's *precision, completeness, sequencing, and test rigor* — **none overturned a decision** (empty DATA, REDIRECT/`uint16`, proxy→burn, register-last all stand). The scariest single claim — "the `_eas`-immutable-under-delegatecall mechanism is unsound" — was **refuted** by the verifier as "technically incorrect; misunderstands Solidity immutable mechanics." So the foundation is sound; this is a plan-quality pass, exactly what a critique should produce.

## Confirmed themes (the 66 cluster into ~10 real issues)

### CRITICAL / HIGH — must fix before executing

1. **Split into 3 sequential Etched PRs (WIP-limit).** [critical, 3 lenses] DATA reshape · proxy refactor · REDIRECT are three distinct Etched subsystems; bundling violates `agent-workflow.md`'s one-Etched-PR-per-subsystem rule and risks coherence loss if a deploy fails mid-refactor. **Sequence: (A) DATA reshape alone → soak → (B) proxy refactor → soak → (C) REDIRECT.** *This is a Tier-1 decision for James.*

2. **ListEntry self-UID must be VERIFIED on-chain, not computed twice off-chain.** [critical, 5 lenses — most-flagged] Add a `public listEntrySchemaUID()` getter (Phase 2.10); the golden-vector test must **read the deployed proxy's getter after `initialize()`** and assert it equals both the registered UID and the local computation. Computing off-chain on both sides would false-green while the resolver reverts every LIST_ENTRY. Add a mutation/false-green guard.

3. **Empty-DATA `abi.decode` will revert + event break + deploy-script mismatch.** [critical/high] `EFSIndexer.onAttest` still `abi.decode(data,(bytes32,uint64))` at line ~370 → reverts on zero-length data; must be explicitly deleted. `DataCreated(…, bytes32 contentHash)` event loses its field → breaks downstream indexers/subgraphs; need an explicit event migration. `01_indexer.ts:49` still registers the old DATA string; must change to empty. (Phase 3 currently underspecifies all three.)

4. **DATA-reshape ripple is unowned.** [high, 2 lenses] EFSRouter upload flow, EFSFileView, `08_seed_demo_tree`, the nextjs UI, and the **separate production client repo** all read `contentHash`/`dataByContentKey`. Plan says "flag for James" but creates no tasks. Need explicit consumer-fix sub-tasks + a Tier-2 cross-repo question for the production client.

5. **CREATE3 underspecified.** [high, create3 lens] `create3.ts` helper + `ICreateX.sol` don't exist; exact `deployCreate3AndInit` signature unconfirmed; salt pinning unspecified; CreateX availability on Sepolia/target chains unverified. Need a pre-Phase-6 spike (confirm CreateX on Sepolia, fetch the signature, define+freeze per-resolver salts as committed constants, document the ADR-0037-pin coordination). *(Note: the "CREATE3 breaks the pinned-fork pin" alarm was refuted — CREATE3 is fork-block-independent.)*

6. **Storage-layout + upgrade-with-state testing under-scoped.** [high, test lens] `validateUpgrade` CI gate has no implementation step; the upgrade-with-state corruption test (the 50-year guard) lives only in the pre-burn checklist, not the build. Add an early Phase (1.5/2.11): wire `validateUpgrade`, and a fork test that deploys v0 + state → upgrades to v1 → asserts indices read back byte-identical.

7. **SORT_INFO deferral leaves dangling wiring.** [high] `EFSIndexer.wireContracts` still takes/sets `_sortInfoSchemaUID`; deferring SORT_INFO registration without reconciling the wiring leaves a zero/half-wired slot. Decide: keep as data-only state (set later) or remove the param.

8. **Guard the `_eas` immutable across upgrades.** [high] Design is sound, but every future impl must re-supply the same EAS; add a verify-gate + CI assertion `proxy.getEAS() == EXPECTED_EAS_FOR_CHAIN` post-deploy and post-upgrade.

9. **Anchor-name canonical encoding must land before freeze.** [high] Phase 5.2 is sequenced too late; it's Durable and affects the Schelling-point property — move before Phase 7.3.

10. **Missing: rollback procedure + redirect read-resolution implementation.** [high] (a) No unwind if a deploy phase fails mid-way after partial registration — add an explicit halt-before-register + rollback doc. (b) Plan writes the redirect-resolution *spec* (7.2) but never implements *following* in router/client — add a task, or explicitly defer following to post-freeze (writing redirects is enough to freeze the schema).

### MED/LOW (32+3) — fold into r2 without belaboring
Field-string single-source getter symmetry across all resolvers; live-smoke to also exercise rejection branches; explicit PIN-supersession-behind-proxy test; OwnableUpgradeable init-order; EIP-170 bytecode-size check on the now-bigger EFSIndexer; per-resolver ERC-7201 slot constants; etc.

## Refuted / downgraded by verification (11) — do NOT act on
- "`_eas` constructor-immutable is unsound under delegatecall" — **wrong**; immutables live in impl bytecode, resolve under delegatecall; EAS calls via CALL so `onlyEAS` holds.
- "ERC-7201 collides with existing mappings" — already accounted for (namespaced slots derived away from slot 0).
- "CREATE3 breaks the pinned-fork pin" — CREATE3 is fork-block-independent.
- "MIRROR allowlist widening changes the schema UID" — conflates resolver bytecode with the UID (resolver *address* is in the UID, not its code).
- "ListResolver proxy is over-engineering" — for EFS, address-change orphans data, so proxying even stateless resolvers is justified.
- + 6 more scope/over-statement downgrades.

## Net
Sound foundation. The revision (plan r2) folds in the 10 themes; the one thing needing James now is **theme 1 — approve the 3-PR split** (it reshapes the plan's structure). Everything else is mechanical plan-tightening.
