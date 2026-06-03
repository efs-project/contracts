# Contracts + API review — synthesis

Tiered multi-viewpoint review (3 research + 2 surface-map + 10 personas + 5 expert lenses + per-source adversarial verify; 35 agents). Personas *tried to build* on EFS; lenses root-caused the friction; verifiers confirmed + horizon-tagged. Findings: **5 tagged freeze-blocking (all downgraded on scrutiny — see below), 117 pre-hackathon-quality, 26 mainnet-proposal.**

## Headline
**The irreversible surface is ready. The hackathon's real risk is the developer layer.**
- All 10 personas could complete their build only **"partially."** Not because the contracts/schemas are wrong — every lens agreed the **core data model + schemas are sound and composable** — but because the **dev-facing layer (SDK, events, naming, query helpers) is pre-MVP.**
- This *sharpens* the two-horizon split: **schemas can freeze now; what makes or breaks the hackathon is the SDK + events + ergonomics**, which is non-blocking for the freeze and mostly cheap additive work.

## Freeze-blocking tier: 0 real (5 over-tagged — downgraded with reasons)
The verifiers tagged 5; on scrutiny **none is a genuinely new irreversible blocker:**
1. *`previousVersion` has no typed SDK constant* → SDK convention, not in any UID. **→ pre-hackathon-quality.**
2. & 4. *Schema UID embeds the resolver address* → the **known coupling already handled** by the proxy + register-last + CREATE3 plan. Confirms the plan; not a new blocker.
3. *`EFSSortOverlay.processItems` physical-index race* → real bug, but **SORT_INFO/SortOverlay is deferred** (not in the freeze set). **→ flag for when SortOverlay ships.**
5. *AliasResolver doesn't exist yet* → it's **Phase C of the build plan.** "Not built" ≠ freeze-blocking. **→ build task.**

**And the one freeze-coupled contract question — the schema→resolver binding — got an explicit YES:** the systems lens confirmed *"the binding is architecturally sound (PIN+TAG→EdgeResolver, DATA/PROPERTY→EFSIndexer, MIRROR→MirrorResolver)."* The "EFSIndexer is an overscoped monolith" concern is real but is **decomposition behind the proxy (a mainnet proposal), not a binding change** — so the current grouping is **safe to freeze.** That closes the last irreversible contract question.

## Pre-hackathon-quality (117; 47 critical/high) — the actual work
Clustered, in priority order. **Crucially, almost all of it is ADD or DOCUMENT — cheap, backward-compatible, and freeze-safe** (the modify/remove breaking class is rare here):
1. **The Solidity SDK doesn't exist** [3 critical]. `EFSWriter` / `EFSList` / `EFS.sol` library are *promised* (`_efsPinFile`, `place`, `tag`, `read`, `readAs`) but unimplemented. Integrators must hand-compose 7+ attestations and call raw resolvers. **This is the #1 hackathon blocker** — without it devs bounce immediately. (New code; touches no frozen surface.)
2. **No PIN/TAG/schema-specific events; generic revocation events** [many, all personas]. Indexers/subgraphs can't reconstruct state without `eth_call` amplification, and can't tell a revoked PIN from a revoked TAG. **Events are additive and cheap to add now** — and the hackathon needs a working indexer ecosystem.
3. **API naming sprawl** [~33]: 60+ getters with overlapping names (`getChildren` vs `getChildrenByAttester` vs `getChildAt`…); a newcomer can't predict which to call; not self-documenting. (Cheap to fix *now* on a pre-integrator surface; expensive later.)
4. **Inconsistent pagination** [~6]: offset-based in EFSIndexer vs opaque-cursor (ADR-0036) partially-implemented in views — three patterns across three contracts.
5. **Missing query helpers / reverse-lookups** [28 "missing-api"]: find-by-property-value, find-by-tag, `previousVersion` back-refs, is-this-PIN-or-TAG, `getPropertyValue`, `classifyUID`, `getDefaultLenses`. **All additive** (free to add anytime) — but felt immediately.
6. **Docs gaps** [15]: the 3-attestation PROPERTY dance, lens-defaulting defined in 3 places, no documented encoding standard.

## Mainnet-proposal (26) — the 100-year written-proposal material
Split EFSIndexer (kernel vs file-system vs generic-EAS-index decomposition, behind the proxy); a **typed EVENT edge** (museum provenance, supply-chain handoffs, version audit trails all hit this — the recurring real schema gap); on-chain **property index / reverse-lookups**; **redirect-following** reader; **signature-PROPERTY** for authenticity (firmware/legal); **ERC-165** interface detection; transport-priority flexibility; the contentHash-trust / MIRROR-content-verification story for legal-grade integrity.

## Implication for sequencing (decision for James)
The freeze is unblocked. But this review says **the SDK library + indexer events are what determine hackathon success**, and they're cheap + additive. Options:
- **(i) Fold the additive dev-layer into the pre-hackathon build** — add PIN/TAG events during the proxy refactor (cheap, they're additive), and build the Solidity SDK library + the highest-value query helpers before the hackathon.
- **(ii) Freeze-first, dev-layer-second** — ship the freeze build, then a fast-follow DX sprint before opening to integrators.
Either works; (i) front-loads the make-or-break adoption work. Naming/pagination consistency is best done *now* (pre-integrator) since it's the one semi-breaking class.
