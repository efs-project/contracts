# Sepolia frozen-UID table (sign-off gate)

> **Human gate (ADR-0048).** James signs off on this table **before** any schema is registered on Sepolia. Once registered with data, each row's shape is permanent: changing a field string, type, `revocable`, or the resolver address orphans that schema's data.
>
> `UID = keccak256(abi.encodePacked(fieldString, resolverAddress, revocable))`. The resolver address is the **proxy** (never the implementation). Addresses + UIDs are filled after the atomic CREATE3 deploy+init (ADR-0048 step 2) and the verify gate (step 3); this table is signed at step 4, before register-last (step 5).

## The 9 schemas to freeze

A first-principles + adversarial durability review (28 candidate cracks, all refuted) and a write-time-practicality pass validated 8 schemas; DATA is reshaped to pure identity (ADR-0049) and REDIRECT is added as a first-class primitive (ADR-0050).

| # | Schema | Field string (exact) | revocable | Resolver (proxy) | Schema UID |
|---|---|---|---|---|---|
| 1 | ANCHOR | `string name, bytes32 forSchema` | `false` | EFSIndexer proxy `0xc4DeaBB482C2FA74690629eEa662efb166BD658a` | `0xf818abd74da70345c8acd7087e6ce69fd48eaf4e79c1931e5c6b08fb148c921a` |
| 2 | PROPERTY | `string value` | `false` | EFSIndexer proxy `0xc4DeaBB482C2FA74690629eEa662efb166BD658a` | `0xa1f54f2d395c24077e374d9a2d835a2d2fcb3b4c3e019f63525bee3424f1c246` |
| 3 | DATA | `` (empty — pure identity) | `false` | EFSIndexer proxy `0xc4DeaBB482C2FA74690629eEa662efb166BD658a` | `0xa3400cecc384d66d84f502fd91e56dc0321edccde9ef8e49d303ba63cc841b3c` |
| 4 | PIN | `bytes32 definition` | `true` | EdgeResolver proxy `0xD6643DB36B20895E3E46aD08cdD4ED4BC1dBB7F1` | `0x5aaabaea19accff34c604f6f1b0dd2361a0a9ba64f7746ea6b3ed95d4047d878` |
| 5 | TAG | `bytes32 definition, int256 weight` | `true` | EdgeResolver proxy `0xD6643DB36B20895E3E46aD08cdD4ED4BC1dBB7F1` | `0x0c41f8ee209fdbea4de3942c488a4098dd5a8bb1afce117857c5493002dd0e87` |
| 6 | MIRROR | `bytes32 transportDefinition, string uri` | `true` | MirrorResolver proxy `0xd4991Ced6D460A3794E9120dC6C19975092982b9` | `0x9573ea8100bda88cc09ba275d8307b309c42ae82cca7f96ccf0e3eef4b5ea58d` |
| 7 | LIST | `bool allowsDuplicates, bool appendOnly, uint8 targetType, bytes32 targetSchema, uint256 maxEntries` | `false` | ListResolver proxy `0x678883253e0edA926aC48F23655967e78E7d464C` | `0x2e2801910184228802919fcc6f20c7e6c9e9c12fb8ae7a1f4e516cd3eeec6a59` |
| 8 | LIST_ENTRY | `bytes32 listUID, bytes32 target` | `true` | ListEntryResolver proxy `0x7a14832E355d5937019C3D0b72bd11F2dbD5e513` | `0x9a22c62bf63ef3a04412c124747df97d9f9e81376fa202d4ed514d0a5e6c9af1` |
| 9 | REDIRECT | `bytes32 target, uint16 kind` | `true` | AliasResolver proxy `0xB07225842d6513239a3519ae052B5bc7EBf18996` | `0x5dca2fcc2c39c8629616b175a38c5e71d641b3019a3cb4ca790cc8fd32c9b8e0` |

**PROPERTY (ADR-0052):** `revocable: false`. PROPERTY is a non-revocable *interned value* — dumb shared content (an "anchor for a string"), not a claim. Many PINs can point at one value (best-effort dedup); nobody owns the value. Revocability and removal live in the **PIN** (the binding), not the value — revoke or supersede the PIN to unbind/change a property; the shared value is untouched. Non-revocability is what makes a value safely shareable: it can't be yanked out from under other bindings. Symmetric with DATA (value = content, claim = edge).

**DATA (ADR-0049):** empty schema = pure identity. `contentHash` + `size` move to trust-scoped reserved-key PROPERTYs (lets you pin a 10 GB IPFS file with zero download; multiple lens-scoped hash claims). This is a real Tier-1 reshape (new DATA UID, removes `dataByContentKey`) — safe now because nothing is frozen on Sepolia yet.

**REDIRECT (ADR-0050):** canonical/`sameAs`/`supersededBy`/`symlink` redirect. `refUID` = source; `target` = destination. Only `uint16 kind` is frozen — the kind *taxonomy* is upgradeable resolver logic + convention. (`uint16` not `uint8`: widening is free under ABI padding, and `kind` is an open relationship vocabulary, so the irreversible field takes zero-cost headroom; see ADR-0050.) Write-time guards in `AliasResolver`; multi-hop cycle/chain resolution is a Durable read-time spec (cycle → lowest-UID-in-SCC), pinned with conformance vectors before durable seeding. Hardlinks remain native (one DATA, many PINs).

## WHITEOUT — additive 10th schema (post-freeze, ADR-0055)

WHITEOUT is **NOT part of the signed 9-schema freeze above** — it is an **additive post-freeze** schema (ADR-0055): a new schema + a new `WhiteoutResolver` proxy registered *after* the original nine are live, via the additive deploy path (`deploy-lib` `detectMissingResolvers`/`buildAdditivePlan`; deploys ONLY WhiteoutResolver + registers ONLY WHITEOUT, the core untouched). Adding it orphans nothing — a new schema UID is independent of the nine. It gets its **own one-row sign-off** at the additive deploy (same gate discipline: addresses + UID filled after the atomic CREATE3 deploy+init and verify gate, signed before register).

| # | Schema | Field string (exact) | revocable | Resolver (proxy) | Schema UID |
|---|---|---|---|---|---|
| 10 | WHITEOUT | `` (empty — pure-identity negative marker) | `true` | WhiteoutResolver proxy `<filled at additive deploy>` | `<filled at additive deploy>` |

**WHITEOUT (ADR-0055):** empty field string = pure-identity negative marker (same idiom as DATA); `revocable: true` (revoke == un-hide). `WhiteoutResolver` self-derives its WHITEOUT schema UID in `initialize()` and write-guards source/payload/revocability. It is **not** `OwnableUpgradeable` (no deployer/owner-gated functions — like EdgeResolver/ListResolver/ListEntryResolver/AliasResolver), so at burn only its **ProxyAdmin** is renounced; there is no contract-owner to zero. Its proxy + ProxyAdmin **join the burn ceremony** (see the burn checklist — 8 ProxyAdmins once WHITEOUT is deployed).

## Realized deploy facts (Sepolia — chainId 11155111)

Filled from the live Safe-native deploy (`deploy:efs --via-safe --network sepolia`). Addresses/UIDs are
Safe-keyed CREATE3 (the EFS.eth Safe is the CreateX caller) and match the table above. **The 7 impl
addresses are NOT here** — they are content-addressed CREATE2, behind the proxies, and in no UID, so they
are not part of the freeze.

- **Deploy FROM (EFS.eth Safe / CreateX caller / born owner):** `0x1Ad8B0a3F7F6892e9206FcA4c93871FEA3cA11D7`
- **Gas-paying deployer EOA (zero authority):** `0x8f99ED774D2eDd7390657130172Fa6FFAea95bb5`
- **CreateX factory:** `0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed`
- **EAS:** `0xC2679fBD37d54388Ce493F1DB75320D236e1815e` · **SchemaRegistry:** `0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0`
- **SystemAccount proxy (default-lens `system` tail, ADR-0053):** `0x63DEA7336C4217B7c5433eE3CB21Bb6a6813588d`
- **Verify gate (pre-register):** GREEN ✓ — realized==predicted, `initialize()` locked, self-UID getters, init cross-ref UIDs, EFSIndexer partner wiring, `getEAS()`==EAS, golden-vector field strings.
- **Safe MultiSend batches** (MultiSendCallOnly 1.4.1 `0x9641d764fc13c8B624c04430C7356C1C7C8102e2`, `operation=1`):
  - **Batch 1** (deploy + wire), nonce 0 — safeTxHash `0x0f631eb9eba02979e1e109a1f7ac056dc27e10b6545972a3a572199fd5f6466a` — **EXECUTED** ✓ (7/7 proxies live on-chain; `EFSIndexer.edgeResolver()` wired).
  - **Batch 2** (register×9 + `SystemAccount.bootstrap` + `seal`), nonce 1 — safeTxHash `0x12dc7b0d9d3f96e44ac715d4e6e78fca252c02626d68805b35bedbb4e2228647` — **PENDING — execute only after this table is signed.**
  - **Batch 3** (`MirrorResolver.setTransportsAnchor`), nonce 2 — safeTxHash `TBD` (emitted by the re-run after Batch 2 lands; fed the realized `/transports` UID).

## Explicitly NOT frozen now (addable later, no orphaning)

- **SORT_INFO** + its EFSSortOverlay resolver — deferred.
- **BLOB** — dropped (redundant with DATA+MIRROR; unvalidated).
- **NAMING** — dropped (schema-name tooling; SchemaNameIndex not deployed).
- **EVENT/TRANSITION** — the one real schema gap (provenance edges); additive, separate proposal.

## Pre-registration verification (all must pass before register-last)

- [ ] Each resolver address is a **proxy** (CREATE3), not an implementation; realized addr == predicted addr.
- [ ] Each proxy's `initialize()` is locked (2nd call reverts) and the implementation's direct `initialize()` reverts (`_disableInitializers`).
- [ ] On-chain self-derived UID (`ListEntryResolver._listEntrySchemaUID` etc.) == `keccak256(goldenFieldString, proxyAddr, revocable)` == the UID being registered (all three equal).
- [ ] Golden-vector test: contract field-string constants byte-identical to the deploy script (no UID drift).
- [ ] `getSchema(uid).resolver == proxy`; no conflicting prior registration of the same tuple.
- [ ] `wireContracts()` set and locked (pure storage, no EAS call; run pre-registration in Batch 1). `MirrorResolver.setTransportsAnchor()` set post-Batch-2 (Batch 3). No `setSortsAnchor()` — SORT_INFO is deferred.
- [ ] Upgrade admin = the EFS.eth Safe, set via single-step `Ownable` / `OwnableUpgradeable` `transferOwnership` (the resolvers use `OwnableUpgradeable`; the OZ v5 `ProxyAdmin` is single-step `Ownable` — there is no `Ownable2Step` accept step). The deploy asserts each `owner() == Safe` and that the deployer holds nothing; not burned/renounced yet.
  - ⚠️ The single-step transfer is **irreversible**: there is no pending-owner / accept handshake, so a wrong or unset target permanently misassigns the upgrade authority. The `EFS_SAFE_ADDRESS` MUST be verified as the correct checksummed Safe before the `--after-freeze-gate` run. The deploy enforces this — `resolveSafe` hard-fails on any non-`hardhat` network when `EFS_SAFE_ADDRESS` is unset/zero/invalid (I-5a).

## Post-Batch-2/3 verification (after register-last + `SystemAccount.bootstrap` + `MirrorResolver.setTransportsAnchor`)

- [ ] **Pre-registration wiring confirmed**: `EFSIndexer.wireContracts(...)` ran in Batch 1 (pure storage, no EAS call); all resolver cross-refs are set.
- [ ] **`/transports` anchor created**: `SystemAccount.bootstrap(...)` authored the `/transports` anchor and all `/transports/*` children in Batch 2; verify each child resolves under `/transports` by reading from the index.
- [ ] **`MirrorResolver.transportsAnchorUID()` == realized `/transports` UID**: confirm the UID returned by `MirrorResolver.transportsAnchorUID()` equals the realized `/transports` anchor UID set via `setTransportsAnchor()` in Batch 3.
- [ ] **No `setSortsAnchor()` step**: SORT_INFO is deferred; no sort-anchor wiring is expected or present.

## Pre-BURN checklist (the irreversible end-state gate — separate from registration)

- [ ] Refactor verified in source: no schema-UID/partner-ref `immutable` on any proxied resolver (all in ERC-7201 storage set by `initialize()`); only `_eas` remains impl-immutable, asserted == canonical EAS for the chain.
- [ ] Full invariant/property suite green against deployed bytecode at the real proxy addresses: every onAttest rejection branch, onRevoke, swap-and-pop removal from middle, PIN cardinality supersession, append-only invariants (ADR-0009).
- [ ] Real vN-1→vN upgrade exercised on a fork **with state present**; all pre-existing indices read back byte-identical (no silent storage corruption frozen in).
- [ ] ≥14-day soak on Sepolia with the real client; zero reverts on valid input; rejection branches observed firing; `deployedContracts.ts` pin held (ADR-0037).
- [ ] Mainnet-fork dry run; addresses + UIDs match this table.
- [ ] FREEZE_LEDGER committed (salts, factory, predicted/realized addrs, impl bytecode keccak, proxy + ProxyAdmin addrs, field strings, UID inputs, EAS/registry + chainId, register/init txs).
- [ ] Human sign-off on the FREEZE_LEDGER ("no pending field changes").
- [ ] **SystemAccount pre-burn:** call `SystemAccount.sealModules()` — permanently prevents any new system-writer module from being authorized post-burn (ADR-0053 "pre-burn only" membership). Verify `SystemAccount.modulesSealed() == true` before proceeding. (Do this while the Safe is still owner; the `renounceOwnership()` in (b) below is the final owner action.)
- [ ] BURN — LAST actions. Each proxied contract has TWO independent owners — its external **ProxyAdmin** (controls `upgradeAndCall`) and, where the logic is `Ownable`/`OwnableUpgradeable`, the **contract's own owner** (controls its privileged setters). Renouncing the ProxyAdmin does NOT touch the contract-owner; both must be zeroed or the system is not actually immutable (PR #24 50yr-review). LAST actions:
  - (a) `ProxyAdmin.renounceOwnership()` for all ProxyAdmins — **7** without WHITEOUT (6 resolver proxies + the SystemAccount proxy), or **8** once the additive WhiteoutResolver proxy (ADR-0055) is deployed (7 resolver proxies + SystemAccount). Freezes logic (no further `upgradeAndCall`).
  - (b) `EFSIndexer.renounceOwnership()` and `MirrorResolver.renounceOwnership()` — the two `OwnableUpgradeable` resolvers. **Required:** until this, the Safe can still call their owner-only setters on a "frozen" contract — notably the one-shot `EFSIndexer.setSortsAnchor(...)`, which is **never set during this freeze** (SORT_INFO deferred → `sortsAnchorUID == 0`, guard still open), so a post-burn Safe could weld a permanent kernel value into the immutable kernel. Renouncing closes it. (EdgeResolver/ListResolver/ListEntryResolver/AliasResolver/**WhiteoutResolver** have no owner — config is set once in `initialize()` — so they need no renounce; only their ProxyAdmin in (a).)
  - (c) `SystemAccount.renounceOwnership()` — zeroes the proxied contract's own `OwnableUpgradeable` owner (distinct from its ProxyAdmin). Safe to renounce: `sealModules()` + `seal()` have already frozen every meaningful owner power, and ongoing system-content authoring runs through the sealed `onlyAuthorizedModule` relay, not the owner.
  - Post-burn verify: `owner()==0` for each ProxyAdmin, **`EFSIndexer.owner()==0`, `MirrorResolver.owner()==0`, `SystemAccount.owner()==0`**, `SystemAccount.modulesSealed()==true`, ex-owner `upgradeAndCall` reverts, `EFSIndexer.setSortsAnchor(...)` reverts, attestations still succeed; record burn txs + blocks. **After this, every privileged function across all contracts is frozen — the system is ownerless and immutable.**

## Sign-off

- [x] **James** — frozen-UID table approved for Sepolia registration. Date: 2026-06-19
- [ ] **James** — FREEZE_LEDGER approved for burn-to-immutable. Date: ________
