# Sepolia Deployment Blueprint — mainnet-forward foundation

Capstone of the contract+API analysis (18-agent forward-compat workflow + empirical bytecode measurement, building on the schema-durability, file-identity, plan-critique, and contracts+API reviews). Answers: *what does EFS deploy to Sepolia, will the hackathon data persist, and will the contracts need a massive change before mainnet?*

## Verdict
**The foundation is mainnet-forward-compatible.** All six forward-compat lenses returned **"safe-with-fixes," none "will-need-major-change."** Via CREATE3, **the Sepolia structure *is* the mainnet structure** (identical resolver proxy addresses → identical schema UIDs → data portable, un-orphaned). Sepolia→mainnet is a redeploy + re-attestation, **not a rewrite.** The single risk that could have forced a structural split before Sepolia — EIP-170 — is **empirically a non-issue** (measured below).

## The empirical EIP-170 result (headline)
| Contract | deployed bytecode | % of 24,576 limit |
|---|---|---|
| EFSIndexer (current) | **14,912 B** | **61 %** (~9.6 KB headroom) |
| EFSRouter | 8,135 B | 33 % |
| EFSFileView | 5,664 B | 23 % |

The proxy refactor adds ~2–4 KB (Initializable + Ownable2Step + new events/getters) → ~17–19 KB, **comfortably under the limit.** No forced decomposition. *Add a CI bytecode-size gate (ceiling 23.5 KB) so future growth can't silently approach it.*

## Recommended contract set (what deploys to Sepolia = what's on mainnet)
**6 resolvers behind CREATE3 Transparent proxies** (addresses in schema UIDs → permanent; logic upgradeable until burn):

| Contract | Backs schema(s) | Notes |
|---|---|---|
| EFSIndexer | ANCHOR, PROPERTY, DATA | kernel + indices + path resolution (monolith; safe to decompose behind proxy later) |
| EdgeResolver | PIN, TAG | cardinality in the UID, one resolver |
| MirrorResolver | MIRROR | URI scheme allowlist widened |
| ListResolver | LIST | stateless validation |
| ListEntryResolver | LIST_ENTRY | **self-UID derived in `initialize()` from the proxy** — verified on-chain |
| AliasResolver | REDIRECT | new (ADR-0050); write-time guards |

**3 stateless views, NOT proxied, redeployable forever** (in no UID): EFSRouter, EFSFileView, ListReader.

## What is FROZEN at Sepolia registration (irreversible — get right before the human sign-off)
- The **9 schema field strings** (exact bytes) + **revocable flags** (ANCHOR/PROPERTY/DATA/LIST = false; PIN/TAG/MIRROR/LIST_ENTRY/REDIRECT = true).
- The **resolver proxy addresses** (CREATE3 salt-derived; realized == predicted or abort) and the **schema→resolver binding** (confirmed sound).
- **Append-only index shapes** (ADR-0009) and the **`onAttest`/`onRevoke` resolver signatures** (downstream indexers bind to them).
- The **anchor-name canonical encoding** (NFC + percent-encode — the Schelling point).

## What is CONTAINED behind the proxy (free to change Sepolia→mainnet — NOT a massive change)
Resolver logic; internal decomposition (split EFSIndexer anytime); added getters/query-helpers/reverse-lookups; **events (additive)**; the on-chain property index; redirect-following logic. The mainnet burn freezes resolver logic — until then it all iterates.

## What is REDEPLOYABLE views (free forever, even post-burn)
EFSRouter, EFSFileView, ListReader — reorganize/extend the read API anytime; point clients at new addresses.

## Pre-Sepolia gates (all already in build-plan r2; the analysis confirms them)
These are the "must-fix-before-Sepolia" items, all captured in `2026-06-02-schema-freeze-build-plan.md`:
1. Immutables → ERC-7201 storage in guarded `initialize()`; `_disableInitializers()` in impls; keep only `_eas` immutable.
2. **ListEntryResolver self-UID** computed in `initialize()` (proxy address) + on-chain `listEntrySchemaUID()` getter + verify-gate read-and-assert.
3. **CREATE3 spike** (CreateX live on Sepolia? exact `deployCreate3AndInit` sig?) + committed salts → realized == predicted.
4. **Golden-vector test**: contract field-string constants == `deploy/lib/schemas.ts` == on-chain registered UID.
5. **DATA reshape**: delete the `abi.decode` (reverts on empty), migrate the `DataCreated` event, register DATA as `""`, fix ripple consumers.
6. **`getEAS()` guard** post-deploy/post-upgrade; **storage-layout `validateUpgrade`** + **upgrade-with-state** corruption test.
7. **Human freeze-table / FREEZE_LEDGER sign-off** before any registration.
8. **New (cheap):** CI bytecode-size gate.

## Decomposition (the monolith)
**Not forced and not freeze-coupled.** EFSIndexer at 61% of EIP-170 has room; the binding (3 kernel schemas → EFSIndexer) is sound to freeze; and the proxy lets us split internals (libraries / extracted modules) anytime without changing the address or any UID. **Recommendation: deploy the current structure to Sepolia; decompose behind the proxy as a post-freeze quality pass if/when desired** (it's a mainnet-proposal, not a blocker).

## Bottom line
Deploy the 9-contract set above behind CREATE3 proxies, freeze the 9 schemas against the proxy addresses, burn before mainnet. **Hackathon data persists** (UIDs permanent; CREATE3 makes them mainnet-identical). **No massive pre-mainnet change** — everything that evolves is contained behind a proxy or in a redeployable view. The build is gated, the gates are in plan r2, and the only empirical unknown (EIP-170) is resolved.
