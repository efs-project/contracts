# Sepolia frozen-UID table (sign-off gate)

> **Human gate (ADR-0048).** James signs off on this table **before** any schema is registered on Sepolia. Once registered with data, each row's shape is permanent: changing a field string, type, `revocable`, or the resolver address orphans that schema's data.
>
> `UID = keccak256(abi.encodePacked(fieldString, resolverAddress, revocable))`. The resolver address is the **proxy** (never the implementation). Addresses + UIDs are filled after the atomic CREATE3 deploy+init (ADR-0048 step 2) and the verify gate (step 3); this table is signed at step 4, before register-last (step 5).

## The 9 schemas to freeze

A first-principles + adversarial durability review (28 candidate cracks, all refuted) and a write-time-practicality pass validated 8 schemas; DATA is reshaped to pure identity (ADR-0049) and REDIRECT is added as a first-class primitive (ADR-0050).

| # | Schema | Field string (exact) | revocable | Resolver (proxy) | Schema UID |
|---|---|---|---|---|---|
| 1 | ANCHOR | `string name, bytes32 schemaUID` | `false` | EFSIndexer proxy `0x…TBD` | `0x…TBD` |
| 2 | PROPERTY | `string value` | `false` | EFSIndexer proxy `0x…TBD` | `0x…TBD` |
| 3 | DATA | `` (empty — pure identity) | `false` | EFSIndexer proxy `0x…TBD` | `0x…TBD` |
| 4 | PIN | `bytes32 definition` | `true` | EdgeResolver proxy `0x…TBD` | `0x…TBD` |
| 5 | TAG | `bytes32 definition, int256 weight` | `true` | EdgeResolver proxy `0x…TBD` | `0x…TBD` |
| 6 | MIRROR | `bytes32 transportDefinition, string uri` | `true` | MirrorResolver proxy `0x…TBD` | `0x…TBD` |
| 7 | LIST | `bool allowsDuplicates, bool appendOnly, uint8 targetType, bytes32 targetSchema, uint256 maxEntries` | `false` | ListResolver proxy `0x…TBD` | `0x…TBD` |
| 8 | LIST_ENTRY | `bytes32 listUID, bytes32 target` | `true` | ListEntryResolver proxy `0x…TBD` | `0x…TBD` |
| 9 | REDIRECT | `bytes32 target, uint16 kind` | `true` | AliasResolver proxy `0x…TBD` | `0x…TBD` |

**PROPERTY (ADR-0052):** `revocable: false`. PROPERTY is a non-revocable *interned value* — dumb shared content (an "anchor for a string"), not a claim. Many PINs can point at one value (best-effort dedup); nobody owns the value. Revocability and removal live in the **PIN** (the binding), not the value — revoke or supersede the PIN to unbind/change a property; the shared value is untouched. Non-revocability is what makes a value safely shareable: it can't be yanked out from under other bindings. Symmetric with DATA (value = content, claim = edge).

**DATA (ADR-0049):** empty schema = pure identity. `contentHash` + `size` move to trust-scoped reserved-key PROPERTYs (lets you pin a 10 GB IPFS file with zero download; multiple lens-scoped hash claims). This is a real Tier-1 reshape (new DATA UID, removes `dataByContentKey`) — safe now because nothing is frozen on Sepolia yet.

**REDIRECT (ADR-0050):** canonical/`sameAs`/`supersededBy`/`symlink` redirect. `refUID` = source; `target` = destination. Only `uint16 kind` is frozen — the kind *taxonomy* is upgradeable resolver logic + convention. (`uint16` not `uint8`: widening is free under ABI padding, and `kind` is an open relationship vocabulary, so the irreversible field takes zero-cost headroom; see ADR-0050.) Write-time guards in `AliasResolver`; multi-hop cycle/chain resolution is a Durable read-time spec (cycle → lowest-UID-in-SCC), pinned with conformance vectors before durable seeding. Hardlinks remain native (one DATA, many PINs).

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
- [ ] BURN — LAST actions:
  - (a) `ProxyAdmin.renounceOwnership()` for all **7** ProxyAdmins (6 resolver proxies + the SystemAccount proxy) — freezes logic (no further `upgradeAndCall`).
  - (b) `SystemAccount.renounceOwnership()` — zeroes the *proxied contract's own* `OwnableUpgradeable` owner. This is a **distinct owner** from the proxy's ProxyAdmin; the ProxyAdmin renounce in (a) does NOT touch it, so this explicit step is required for `SystemAccount.owner() == 0`. Safe to renounce: `sealModules()` + `seal()` have already frozen every meaningful owner power, and ongoing system-content authoring runs through the sealed `onlyAuthorizedModule` relay, not the owner.
  - Post-burn verify: `owner()==0` for each ProxyAdmin, ex-owner `upgradeAndCall` reverts, attestations still succeed, **`SystemAccount.owner()==0` AND `SystemAccount.modulesSealed()==true`**; record burn txs + blocks.

## Sign-off

- [ ] **James** — frozen-UID table approved for Sepolia registration. Date: ________
- [ ] **James** — FREEZE_LEDGER approved for burn-to-immutable. Date: ________
