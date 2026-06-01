# ADR-0048: Sepolia freeze set + proxy-ready resolvers

**Status:** Proposed
**Date:** 2026-05-31
**Deciders:** James (freeze sign-off is human-gated)
**Permanence-tier:** Etched (defines which schema UIDs become permanent on Sepolia)
**Related:** ADR-0030 (mainnet permanence), ADR-0032 (EAS as foundation), ADR-0037 (pinned Sepolia fork), ADR-0041 (PIN/TAG split), ADR-0044/0046/0047 (Lists), ADR-0027 (deploy-before-register)

## Context

The hackathon seeds **real datasets on Sepolia**. That data is the network-effect seed and must last. EAS physics make two facts non-negotiable:

1. A schema's UID is `keccak256(abi.encodePacked(fieldString, resolverAddress, revocable))`. The resolver **address** and the `revocable` flag are part of the UID, not just the field string.
2. Attestations are immutable and a schema cannot be edited. **Changing a registered schema's shape orphans its data.** Adding a *new* schema never orphans anything.

Two consequences drive this ADR:

- **The freeze decision is asymmetric.** Since adding schemas later is free, the only irreversible risk is registering a schema whose shape (fields, types, `revocable`) or whose resolver address we later regret. The safe move is to freeze only the schemas we are confident in and to lock the resolver addresses *before* registration.
- **Upgradeability and the freeze are coupled.** "Resolver logic upgradeable behind a stable address" requires registering the **proxy** address as the resolver. But every live resolver today bakes its EFS state (schema UIDs, partner refs) as `immutable` set in the **constructor**, and `ListEntryResolver` derives its own schema UID from `address(this)` *in the constructor*. Under a proxy, a constructor runs in the **implementation's** context, so `address(this)` is the implementation address — the registered UID (computed against the proxy) would never match what the resolver checks. Proxy-readiness is therefore a prerequisite to a safe freeze, not a follow-up.

### Current-state inventory (origin/main @ `b1ac4e0`)

The deploy scripts register **11** schemas; the canonical surface (`specs/overview.md`, `specs/02`) is **9**. The two extras:

- **BLOB** (`string mimeType, uint8 storageType, bytes location`, revocable) — resolver is `ZeroAddress` (no validation), `BlobResolver.sol` is dead, and it overlaps DATA (identity) + MIRROR (retrieval). Absent from all 15 use cases and the freeze brainstorm.
- **NAMING** (`bytes32 schemaId, string name`, revocable) — resolver `ZeroAddress`; backs `SchemaNameIndex` (human-readable schema names). Tooling, not a kernel primitive.

Live resolvers: `EFSIndexer` (Anchor/Property/Data + kernel), `EdgeResolver` (Pin/Tag), `MirrorResolver` (Mirror), `EFSSortOverlay` (SortInfo), `ListResolver` (List, stateless validation), `ListEntryResolver` (ListEntry). Stateless views (not in any UID, freely redeployable): `EFSFileView`, `ListReader`, `EFSRouter`, `SchemaNameIndex`. Dead/legacy: `TopicResolver`, `FileResolver`, `PropertyResolver`, `BlobResolver`, `Indexer.sol`. Sepolia is a **clean slate** — nothing registered, zero data at risk.

## Decision

### 1. Sepolia freeze set — **8 schemas**

Freeze: **ANCHOR, PROPERTY, DATA, PIN, TAG, MIRROR, LIST, LIST_ENTRY**.

- **Drop BLOB and NAMING** from the freeze. BLOB is redundant and unvalidated; NAMING is tooling. Both can be registered later if a real need appears (additive, no orphaning). Remove their registration from `01_indexer.ts`; do not deploy `SchemaNameIndex` for the freeze.
- **Defer SORT_INFO** (and its `EFSSortOverlay` resolver). Sort overlays are additive — registering SORT_INFO later does not orphan any of the 8 frozen schemas. Ship the file-system core + Lists first; add SORT_INFO when the hackathon proves it.

`revocable` flags (in the UID — decided deliberately, not by SDK default):

| Schema | revocable | Rationale |
|---|---|---|
| ANCHOR | `false` | Path identity is a permanent Schelling point. |
| PROPERTY | `false` | Value is permanent; the *binding* moves via PIN. |
| DATA | `false` | Content identity is permanent (content-addressed). |
| PIN | `true` | Bindings must be removable (revoke clears the slot). |
| TAG | `true` | Labels/edges must be removable. |
| MIRROR | `true` | Retrieval URIs rot and change. |
| LIST | `false` | List identity is permanent, like DATA. |
| LIST_ENTRY | `true` | Membership removable (unless the list is `appendOnly`). |

Field strings are frozen exactly as in code (see the frozen-UID table doc). No field-string changes are proposed for Sepolia.

### 2. Proxy-ready resolvers, then freeze

Refactor the **5 resolvers backing the 8 schemas** (`EFSIndexer`, `EdgeResolver`, `MirrorResolver`, `ListResolver`, `ListEntryResolver`) to be deployed behind upgradeable proxies, then register the **proxy** addresses.

Per-resolver work (effort from the code audit):

| Resolver | Backs | Today | Work |
|---|---|---|---|
| EFSIndexer | Anchor/Property/Data | immutable schema UIDs + `DEPLOYER`; `wireContracts()` already a post-deploy setter | move UIDs to initializer storage; gate `initialize` |
| EdgeResolver | Pin/Tag | immutable PIN/TAG UIDs, indexer, schemaRegistry | move to initializer storage |
| MirrorResolver | Mirror | immutable `indexer`; `transportsAnchorUID` already mutable | move `indexer` to initializer storage |
| ListResolver | List | stateless (only EAS) | trivial: proxy + empty/guarded init |
| ListEntryResolver | ListEntry | **`address(this)`-derived UID in constructor** | **must** move UID derivation to initializer (now `address(this)` = proxy) |

Pattern:

- EAS's `SchemaResolver` base keeps `_eas` as constructor-set `immutable`. This survives proxying: EAS calls the proxy, which `delegatecall`s the impl; `msg.sender` is preserved so `onlyEAS` passes, and the EAS address is a per-chain constant (re-supplied to each impl version at impl-deploy). We accept impl-immutable `_eas`; we move only EFS state (schema UIDs, partner refs, the `address(this)` derivation) into a guarded `initialize(...)`.
- Use `Initializable`; `initialize` carries the `initializer` modifier and **reverts on second call**. An unguarded initializer behind a proxy is a hijack vector — verifying the initializer is locked is a hard pre-deploy gate.
- Proxy admin / upgrade authority: **a single admin key James controls** (Sepolia). Not burned, not renounced, not a throwaway hardcoded as permanent. Mainnet custody (multisig/timelock) is decided separately and does not block Sepolia.
- Stateless views (`EFSFileView`, `ListReader`, `EFSRouter`) stay non-proxied — their addresses are in no UID; fix by redeploy.

### 3. Deploy ordering (breaks the circular UID↔address dependency)

Schema UID needs the resolver (proxy) address; the resolver needs its schema UIDs at `initialize`. Order:

1. Deploy each resolver **implementation**.
2. Deploy each **proxy** with a deterministic address — **CREATE2 with a fixed salt + deployer + proxy init code**. Proxy addresses are now known and stable.
3. Compute the 8 schema UIDs **off-chain** from `(fieldString, proxyAddress, revocable)`.
4. **Produce the frozen-UID table → James signs off → only then register** the 8 schemas in EAS with `resolver = proxyAddress`.
5. Call each proxy's guarded `initialize(...)` with EAS + the computed schema UIDs + partner refs. For `ListEntryResolver`, `address(this)` now equals the proxy, so its self-derived UID matches the registered one.
6. **Verify** each initializer is locked (second call reverts) and each registered resolver address equals the proxy (never the impl) — abort the deploy if either check fails.
7. Round-trip: create an anchor/file/list and read it back through the views.

Using CREATE2 also makes Sepolia→mainnet UID parity *possible* later (identical init code + salt + deployer ⇒ identical proxy address ⇒ identical UID). Not a goal now, but it costs nothing to preserve and avoids foreclosing it.

## Options Considered

### Freeze scope

| Option | Pro | Con |
|---|---|---|
| All 11 (as code stands) | no deploy-script edits | freezes BLOB/NAMING cruft permanently |
| **8 (chosen)** | smallest confident irreversible surface; SortInfo/BLOB/NAMING all addable later for free | defer SORT_INFO until proven |
| 6 (file-system core only) | even smaller | Lists is settled at HEAD and wanted for the hackathon — no reason to defer it |

### Upgradeability

| Option | Pro | Con |
|---|---|---|
| **Proxy-first, then freeze (chosen)** | logic stays fixable behind stable UIDs; data never orphaned | resolver refactor on the critical path (~days) |
| Ship direct-impl now | fastest | registered addresses (and UIDs) permanent & non-upgradeable; a resolver bug forces re-registration = orphaning. Violates the upgradeability requirement. |

## Consequences

- **Easier:** resolver logic (bug fixes, indices, new capabilities) iterates forever behind stable addresses without touching any schema UID or orphaning data. Adding SORT_INFO / EVENT / BLOB later is a pure addition.
- **Harder:** the deploy pipeline gains real ceremony (CREATE2 proxies, off-chain UID precompute, human freeze gate, initializer-lock verification). The 5 resolvers need an initializer refactor and tests proving `initialize` reverts on re-entry and that UIDs match against the proxy.
- **Revisit:** mainnet key custody; whether SORT_INFO/EVENT/BLOB ever join the set; whether to fork EAS's `SchemaResolver` into a fully-initializable variant (storing `_eas` in storage) if impl-immutable `_eas` proves limiting.

## Out of scope (separate proposals)

- **EVENT/TRANSITION schema** — the one genuine schema-shape crack in the use-case suite (museum provenance #11, supply-chain handoff #13 need a typed directional edge with `eventTime/prevState/nextState/payload`; today a 3–5 attestation dance). Additive, so it does not block the freeze. Draft separately for mainnet.
- **Typed / array / multilingual PROPERTY values** (audit G02/G06/G08) — all solvable in the SDK with `string value` unchanged; not freeze blockers.

## Action items

1. [ ] Remove BLOB, NAMING registration (and SchemaNameIndex deploy) from the deploy scripts; defer SORT_INFO/EFSSortOverlay.
2. [ ] Refactor the 5 resolvers to guarded `initialize`; move EFS state out of constructors; fix `ListEntryResolver` `address(this)` derivation.
3. [ ] Rewrite deploy as: impl → CREATE2 proxy → off-chain UID precompute → (freeze gate) → register → initialize → verify.
4. [ ] Tests: `initialize` reverts on second call; registered resolver == proxy; `ListEntry` self-UID == registered UID; full round-trip.
5. [ ] Generate the frozen-UID table for James's sign-off **before** any registration.
6. [ ] Deploy to Sepolia; prove the end-to-end round-trip.
