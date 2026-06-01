# ADR-0048: Sepolia freeze set + proxy-ready resolvers (burn to immutable)

**Status:** Proposed (r2 — hardened after multi-agent security review)
**Date:** 2026-05-31
**Deciders:** James (freeze sign-off is human-gated)
**Permanence-tier:** Etched
**Supersedes:** ADR-0030's "no proxies on mainnet" clause (see §Mainnet reconciliation). ADR-0030 otherwise stands.
**Related:** ADR-0049 (file content identity), ADR-0032 (EAS as foundation), ADR-0037 (pinned fork), ADR-0041 (PIN/TAG), ADR-0044/0046/0047 (Lists)

## Context

The hackathon seeds **real datasets on Sepolia** that must last. EAS physics: schema UID = `keccak256(abi.encodePacked(fieldString, resolverAddress, revocable))`; attestations are immutable; **changing** a registered schema orphans its data; **adding** orphans nothing; the resolver **address** and `revocable` are baked into the UID forever.

Two consequences: freeze only schemas we're sure of (the irreversible surface), and — because we want to fix resolver bugs without changing the address in the UID — put resolvers behind **upgradeable proxies**, register the **proxy** address, then **burn** the upgrade key to make them permanently immutable before mainnet.

## Decision

### 1. Sepolia freeze set — 8 schemas, all validated solid-as-is

**ANCHOR, PROPERTY, DATA, PIN, TAG, MIRROR, LIST, LIST_ENTRY.** A first-principles + adversarial review (28 candidate cracks across the 8 schemas, each refuted by a majority of independent reviewers; plus a write-time-practicality pass) found **zero surviving reasons to change any field string, type, or revocable flag.** DATA stays `bytes32 contentHash, uint64 size` (see ADR-0049 — hash-as-data realized without a field change). **Drop BLOB + NAMING** (redundant / tooling); **defer SORT_INFO** + EFSSortOverlay (additive later, orphans nothing). `revocable`: false for ANCHOR/PROPERTY/DATA/LIST (permanent identity; revoke never erases bytes anyway, so non-revocable is GDPR-neutral and trust-correct), true for PIN/TAG/MIRROR/LIST_ENTRY (retractable).

Write-time review found **no schema-field problems** but three **resolver/convention** fixes (not freeze blockers — `string`/`bytes32` fields already flexible):
- **MIRROR uri scheme allowlist [HIGH]** — `MirrorResolver._isAllowedScheme` rejects ftp/s3/gs/rsync/dat/bittorrent, blocking legitimate already-known mirror locations (same failure shape as the 10 GB bug). Drop/widen the allowlist in resolver logic; scheme safety is a client-render concern. Field `string uri` unchanged.
- **MIRROR transportDefinition [MED]** — guarantee a low-friction path for attesters to create new `/transports/*` anchors (today only 5 exist, deploy-time). Resolver/deploy logic.
- **ANCHOR name normalization [MED]** — define a canonical name encoding (percent-encode rejected bytes + Unicode NFC) in spec + `_isValidAnchorName`, or the Schelling-point property breaks across clients ("Q&A: Episode 5"). Convention + resolver.

### 2. Proxy-ready resolvers (TransparentUpgradeableProxy + ProxyAdmin)

Refactor the 5 resolvers backing the 8 schemas (EFSIndexer, EdgeResolver, MirrorResolver, ListResolver, ListEntryResolver) — **this refactor does not yet exist in source and is the core build work**:
- Move **all per-deployment EFS state** (schema UIDs, partner refs, `EFSIndexer.DEPLOYER`, and `ListEntryResolver`'s `address(this)`-derived self-UID) out of constructors into a **guarded `initialize()`** using **ERC-7201 namespaced storage**. Today these are constructor `immutable`s — incompatible with a proxy (`address(this)` in a constructor is the *implementation*, not the proxy, so `ListEntryResolver.sol:121`'s self-UID would never match the registered UID and would brick every list entry).
- Keep `_eas` as the EAS `SchemaResolver` base's implementation-`immutable` (EAS address is a per-chain constant; survives delegatecall; re-supplied identically on every upgrade — assert this in CI).
- `_disableInitializers()` in **every** implementation constructor (Parity/Wormhole uninitialized-impl takeover class).
- **Transparent** proxy (not UUPS): upgrade authority lives in an external `ProxyAdmin`, out of resolver bytecode, which makes the burn a clean `ProxyAdmin.renounceOwnership()`. One ProxyAdmin per resolver so a bad upgrade can't cascade.

### 3. Deploy ordering — register LAST, deploy+init ATOMIC

The dangerous window is registering before the proxy is live+initialized+verified. Correct order:
1. Deploy each **implementation** (need not be deterministic).
2. **Deploy proxy + call `initialize()` in ONE transaction** (CreateX `deployCreate3AndInit`, or ERC1967Proxy with init calldata in its constructor) at a **CREATE3** address (depends only on factory + salt → reproducible, cross-chain-parity-capable). `initialize()` hardcodes/asserts the expected owner so a front-run cannot install a foreign one.
3. **Verify** (hard CI gate, abort on any mismatch): realized addr == predicted; initializer locked (2nd call reverts); impl `initialize()` reverts directly; on-chain self-derived UID == `keccak256(goldenFieldString, realizedProxyAddr, revocable)` == the UID about to be registered; `wireContracts()`/`setTransportsAnchor()`/`setSortsAnchor()` set and locked; golden-vector field-string test (contract constant byte-identical to deploy script — no UID drift).
4. **Human freeze-table / FREEZE_LEDGER sign-off** (James).
5. **Register** schemas in EAS with `resolver = proxy` (last, cheapest, idempotent — `AlreadyExists` reverts harmlessly). Assert `getSchema(uid).resolver == proxy` and no conflicting prior registration.
6. **Live smoke:** one real attestation through *every* schema (onAttest no revert + expected index written) + one revoke through every revocable schema.

CREATE3 caveats: pin CreateX factory address+bytecode per chain; same deployer EOA for parity; **zkSync-class chains excluded** from address/UID parity (different derivation).

### 4. Burn to immutable (the end state)

Upgradeability is **temporary dev scaffolding** — a safety net for fixing bugs found during the hackathon without orphaning seed data. The end state is **permanently immutable, resolver-gated, trusted** resolvers. Burning = `ProxyAdmin.renounceOwnership()` per proxy: the address (and UID) stay stable forever, only upgrades become impossible; normal delegatecall to the frozen impl still works.

**Burn is the single most irreversible action in the project** (a post-burn bug is unfixable forever). It is gated on a full pre-burn checklist (see `docs/SEPOLIA_FREEZE_TABLE.md`), the essence of which is: refactor verified in source; immutables purged from the proxy path; self-UID matches the proxy; initializer locked; `_disableInitializers` confirmed; **full invariant suite green against the deployed bytecode at the real proxy addresses** (every rejection branch, revoke, swap-and-pop, cardinality supersession, append-only invariants — not just the happy path); a real vN-1→vN upgrade exercised on a fork *with state* (proves no silent storage corruption is being frozen in); **≥14-day soak** on Sepolia with the real client and zero reverts on valid input; mainnet-fork dry run; human sign-off; then burn as the LAST action; then post-burn verify (`ProxyAdmin.owner() == 0`, ex-owner `upgradeAndCall` reverts, attestations still succeed).

### 5. Mainnet reconciliation (supersedes ADR-0030's no-proxy clause)

ADR-0030 said "mainnet contracts are permanent, no proxies." This ADR refines that: **proxies are permitted iff the upgrade key is provably burned before the first mainnet attestation.** That delivers ADR-0030's credible-neutrality (immutable, no admin) *and* cross-chain UID parity (same CREATE3 proxy address on Sepolia and mainnet) *and* a dev-iteration window. Mainnet burn-authority hygiene: upgrade authority = multisig during soak; burn = a separate deliberate multisig tx after a timelock. (Sepolia: single key, documented as a testnet-only deviation.)

### 6. Permanence — the FREEZE_LEDGER

Commit a permanent, append-only `FREEZE_LEDGER` (markdown + JSON) so a cold reader 100 years out can recompute every UID and verify the burn from repo artifacts alone: per resolver — CreateX salt + factory address, predicted + realized proxy address, implementation address + bytecode keccak256, proxy + ProxyAdmin address, exact field string, UID-derivation inputs (fieldString / proxyAddr / revocable), EAS + SchemaRegistry addresses + chainId, and the registration / initialize / burn tx hashes (+ `owner==0` confirmation block).

## Single admin key (Sepolia)

A single key James controls owns the ProxyAdmins during the Sepolia upgradeable window. Acceptable for a testnet hackathon, documented as a deviation. Use `Ownable2Step` so EOA→multisig is a safe single transfer with no redeploy. Not burned/renounced until the pre-burn checklist passes.

## Consequences

- **Easier:** resolver logic iterates freely behind stable UIDs during dev; the burn yields trusted, immutable, resolver-gated data with the address/UID and all seed data intact; mainnet inherits the same addresses/UIDs via CREATE3.
- **Harder:** the build adds a real refactor (constructors→initializers, ERC-7201), CREATE3 + CreateX tooling and OZ upgradeable deps, a full invariant suite, a soak, and a disciplined burn runbook. None optional.
- **Revisit:** mainnet multisig/timelock specifics; an upgradeable cross-address dedup index before burn.

## Action items

1. [ ] Refactor 5 resolvers: immutables→ERC-7201 storage in guarded `initialize()`; `_disableInitializers()` in impls; move `ListEntryResolver` self-UID derivation into `initialize()`.
2. [ ] Single-source each schema field string (contract constant generated from / golden-vector-tested against the deploy script).
3. [ ] Rewrite deploy: impl → atomic CREATE3 proxy+init → verify gate → freeze sign-off → register-last → live smoke.
4. [ ] Full invariant/property test suite + storage-layout CI gate (`validateUpgrade`); fork-based vN-1→vN upgrade-with-state test.
5. [ ] Resolver/convention fixes: widen MIRROR uri schemes; permissionless `/transports/*` creation; canonical ANCHOR name encoding.
6. [ ] Write the burn runbook + FREEZE_LEDGER; set ADR-0030 status to "Superseded in part by ADR-0048."
7. [ ] Deploy to Sepolia, prove the round-trip, fill the freeze table for James's sign-off **before** registration.
