# EFS Custom Lists — Notes

Working scratchpad for thoughts that don't need to live in the canonical [`custom-lists.md`](./custom-lists.md). Less rigorous, more exploratory. Append-friendly across iterations and agents.

---

## Process notes

- The design was produced through cross-agent brainstorming between Claude Sonnet 4.7 and Codex GPT-5, mediated by James Carnley as relay. Two parallel research subagent passes (use cases in the wild + design space within EFS primitives + typed-list constraint mechanisms) seeded the structural alphabet; a multi-round critique loop refined it.
- Both agents are listed as `Co-authored-by` on commits per AGENTS.md trailer conventions.
- This notes file is the "below the line" scratchpad — not load-bearing for the design itself, but useful for future agents trying to understand *why* the doc looks the way it does.

---

## Design history / decision evolution

### P1.5 weight encoding: PROPERTY-via-PIN → TAG-with-weight

Initial proposal in this design encoded P1.5's per-entry weight as a PROPERTY value bound via PIN (analogous to `contentType`, `name`, etc.). Codex review flagged this as giving up the `int256 weight` machinery from ADR-0041. The doc now uses `TAG(definition=listAnchor, refUID=entryAnchor, weight=N)` as the canonical order source — same machinery as P1, just with the entry anchor as the TAG target. P1.5 is structurally "P1 over entry anchors."

This change cut typical P1.5 cost from ~5–8 attestations per entry to ~4–7 and made the read shape uniform with P1 (`getRankedSetPage` works for both with different `targetSchema`).

### `EFSListView` signature: multi-attester opaque cursor → single-attester paged

Initial proposal had `getRankedSet(listAnchor, attesters[], targetSchema, limit, cursor)` returning a merged result across attesters with an opaque cursor. Codex flagged two problems:

1. Multi-attester pagination needs per-attester offsets — an opaque cursor would either re-fragment per attester or hide that complexity.
2. The helper would accidentally bake in a merge default before Q1 (multi-edition merge) is resolved.

Switched to `getRankedSetPage(listAnchor, attester, targetSchema, start, length)` — single-attester, single-schema, numeric pagination. Multi-attester views and allowlist composition are explicit client concerns layered on top. This keeps Q1 out of the helper.

### `/lists/` authority: "ships empty" → layered protocol/EFS Team/community model

Initial proposal: `/lists/` ships empty at deploy; predicates emerge organically. James clarified the authority should be explicit and layered:

- Protocol identity (`efs.eth` / deployer) = system facts only (schemas, deploy metadata). No predicate seeding.
- EFS Team account (separate, identified) = reputational curation of recommended predicates. Not protocol-level.
- Community = competing predicates anywhere; clients pick whom to trust.

This split is now reflected in the Discovery section, Q3 detail, and human-decisions item 2.

### Helper rename: `getRankedSetPage` → `getRankedSetEntriesPage` (round-2 review)

The helper was originally named `getRankedSetPage`. Codex's round-2 review correctly flagged that the name implies the page is sorted by rank — but it isn't. The helper paginates the active TAG bucket (`_activeByAAS[def][attester][schema]`), which is insertion-ordered with swap-and-pop on revoke. `length=10` returns the next 10 entries in storage order, not the top 10 by weight.

Renamed to `getRankedSetEntriesPage` to make the unsorted nature explicit. The unsorted-pagination caveat is now called out in:
- D7 (Decisions section)
- The Read primitive section
- P1 read shape
- P1.5 read shape
- New Pitfall: "Multi-schema lists: sort across all schemas BEFORE truncating"

Sorted top-N over very long lists (≫ 1000 entries) needs either an off-chain indexer or a future `EFSSortOverlay` extension to support TAG sources — both deferred per D5.

### Address-target sentinel: `ADDRESS_TARGET = bytes32(0)`

Codex's round-2 review caught that `allowedTargetSchemas` didn't define how address targets are represented. Address-target TAGs (recipient-typed) have no target attestation and therefore no schema UID. The convention adopted: `bytes32(0)` (32 zero bytes) is the `ADDRESS_TARGET` sentinel. Allowlists permitting both schemas and address targets list both, e.g. `<DATA_SCHEMA_UID>,0x0000…0000`.

Reflected in D6 and the metadata-convention table.

### Adversarial-review additions (round 2)

Three pitfalls added based on Codex's round-2 review:

1. **Entry-anchor squatting and name-target mismatch (P1.5)** — clients MUST validate that an entry anchor's name matches the lowercase 0x-hex of its resolved PIN target. The protocol doesn't enforce this; entry-anchor names are conventional, and a buggy or malicious attester can create `0xBob` named anchors that PIN to entirely different targets. Mismatches must surface as warnings, not be silently rendered.

2. **`listKind` is renderer intent, not proof** — clients MUST NOT silently reinterpret storage when the declared kind doesn't match the actual data shape. Empty/degraded states surface to the user instead.

3. **Multi-schema sort-before-truncate** — for `allowedTargetSchemas` lists with multiple schemas, naive "top N per schema" produces incorrect global top-N results. Clients must merge ALL relevant buckets, sort, then truncate. Same rule for multi-attester aggregation.

### P1 vs P1.5 schema semantics + entry anchor `schemaUID` convention (round 3)

Codex's round-3 review caught that `allowedTargetSchemas` means subtly different things in P1 vs P1.5, and the doc didn't spell it out:

- **P1**: `allowedTargetSchemas` values map directly to TAG bucket schemas — the client passes them to `getRankedSetEntriesPage` as `targetSchema`.
- **P1.5**: the outer TAG bucket is **always** `ANCHOR_SCHEMA_UID` because TAGs target entry anchors, not the underlying items. `allowedTargetSchemas` describes the **inner** target schemas (what each entry anchor's PIN binds to).

Adopted convention: P1.5 entry anchors set `schemaUID = innerTargetSchema` on the ANCHOR attestation. This mirrors how naming anchors set `schemaUID = SORT_INFO_SCHEMA_UID` for sort discovery (specs/07) and how schema-alias anchors are declared (ADR-0033). Clients use this to know what to pass to `getActivePinTarget` per entry without trying every allowed schema. Address-target entries: `schemaUID = ADDRESS_TARGET = bytes32(0)`.

Reflected in D6 (P1 vs P1.5 split), P1.5 attestation graph (entry anchor `schemaUID` field), P1.5 read shape, the new "Entry anchor `schemaUID` convention" subsection in P1.5, and the Read primitive section's split P1/P1.5 composition patterns.

### Schema-aware entry-anchor name validation (round 3)

Round-2 pitfall said "compute expected name from lowercase 0x-hex of `targetID`." Codex caught that this is wrong for address targets: address `targetID = bytes32(uint160(addr))` (zero-padded to 32 bytes), and the canonical Ethereum address form is `0x` + 40 hex chars (low 160 bits), not `0x` + 64 hex chars.

Fixed rule, schema-aware:
- UID targets: name = `0x` + 64 lowercase hex (66 chars).
- Address targets (`schemaUID == ADDRESS_TARGET`): name = `0x` + 40 lowercase hex (42 chars; low 160 bits of `targetID`, dropping the 24 leading zero bytes).

Reflected in P1.5 Naming convention and the Pitfalls "Entry-anchor squatting" section.

### MAX_PAGE_LENGTH = 100 (round 3)

Recommended pagination cap for `getRankedSetEntriesPage`. Matches `EFSSortOverlay.MAX_PAGE_SIZE`. Bounds `eth_call` time given the helper performs N internal `eas.getAttestation` reads per page. 1000-entry list = ~10 calls. Documented in D7 and the Read primitive section.

### Snapshot consistency caveat for paginated reads (round 3)

Active TAG buckets are NOT snapshot-stable across multiple RPC calls. Swap-and-pop on revoke (ADR-0007) can shift later array positions between pagination calls. Clients needing consistency should pin to a single block tag or tolerate-and-refetch. Documented in the Read primitive section.

---

## Round 4 — final decisions and reframings

### P2 unification → "Occurrence Sequence"

P2 was previously deferred behind FractionalSort. After cross-agent analysis it became clear that P2 = P1.5 with relaxed entry-anchor naming (per-occurrence rather than per-target-hash). Same TAG-weight ordering, same `EFSListView` read primitive, same metadata convention.

**Codex's naming decision**: rename "Slot Sequence" → "Occurrence Sequence" because "slot" still implies the deprecated `a0/a1/a2` positional model.

**Codex's entry-naming formula**: `keccak256("efs:list-occurrence:v1", listAnchor, creatorAddress, clientNonce)` rendered as 66-char `0x` + 64 hex. Doesn't include `targetID` — entry identity should survive replacing the target PIN. `target:sequence` rejected because `:` fails ADR-0025 anchor-name validation.

**FractionalSort is now deprecated** as a v1 list requirement. Sparse `int256` TAG weights with periodic rebalance (Logoot/CRDT pattern) handle insertion and reorder in O(1). FractionalSort parked as a possible future read/index optimization for very long ordered lists if lazy sorted pagination demands it; not core to lists.

### Merge mode reframed as client convention, not data-layer

James caught the conflation. Merge modes (priority-union, last-write-wins, aggregate, intersection, side-by-side) are **client rendering choices** — the contracts/kernel know nothing about them; `EFSListView` is single-attester and clients compose. Standardizing the URL convention (`?merge=`) is for cross-client interop, not protocol enforcement.

The doc previously had a heavy "Q1 BLOCKING" framing for merge mode selection. Reframed as "Recommended URL conventions for clients" — a small section recommending priority-union default + `?merge=parallel` opt-in. The full tradeoff analysis from three subagent passes (use cases, engineering, adversarial) is summarized below in this notes file rather than bloating the canonical design.

### Rightmost-wins, not leftmost-wins

Round-3 doc had leftmost-priority for editions. James pushed back: URLs and paths go least-to-most-specific left-to-right (`/app/section/feature/`); config inheritance treats most-specific (rightmost/leaf) as the winner. Editions should match. Adopted **rightmost = highest priority** as the v1 client convention. URL `?editions=alice,bob` reads naturally as "Alice base, Bob layered on top."

This is consistent with CSS cascade (later rules override earlier) and most config-file inheritance systems.

**ADR-0039 alignment concern**: ADR-0039 currently documents the default editions chain with leftmost-priority semantics (caller leftmost). Adopting rightmost-wins for lists implies the chain order should flip for consistency. Tracked as a follow-up alignment ADR; not blocking this design. Documented in the Read primitive section's "Recommended URL conventions" subsection.

### UX warning softened

Round-2 / round-3 had a MUST first-publish-confirmation modal for `visibilityWarning = "social"` lists. James vetoed: following / listing other users is normal social behavior; consumer products don't gate it with friction. Spec language softened to MAY-advisory. The `visibilityWarning` PROPERTY remains as advisory metadata clients MAY use; the load-bearing safety primitive is **attribution labeling** ("Alice's blocklist", not "blocked"), which stays as SHOULD.

### `specs/06` rewrite deferred until design lands

Round-3 plan was to fix `specs/06`'s `SORT_INFO` field-count drift in the same PR. Codex argued — and we agreed — for a more substantial rewrite of `specs/06` around the unified P1 / P1.5 / P2 / P3 alphabet, with `specs/08` superseded as design notes. James agreed but said defer the prose work until the design itself is settled, to avoid token waste on text that may shift. Tracked as follow-up; not blocking.

### "First-attester-empty" UI note dropped

Earlier draft suggested clients show a small note when the first attester has no items in the list ("Alice has no items in this list"). James vetoed: just build the merged view silently; debug provenance can be exposed via explicit user action (a button). Removed from the doc.

### Q1 subagent research summary

Three independent subagents (use cases / engineering / adversarial) converged on the same recommendation:

- **Priority-union default + `?merge=parallel` opt-in for v1.**
- **Defer math aggregate** — Sybil-vulnerable, incompatible with default chain (system tier pollutes math), incoherent for P1.5/P2 (whose target binding wins?), weight-scale normalization unsolved.
- **Defer intersection** — incompatible with default chain (system-tier zero-TAGs → empty intersection for fresh users).
- **Defer explicit last-write-wins** — overlaps with priority-union via reversed editions list; URL-reorder attacks make it unsafe to default-on.
- **C-iv parallel side-by-side** is the only mode with clean revocation UX and best attribution preservation; ships as opt-in.

Only C-i (priority) is paginatable in any meaningful sense — every other mode requires reading all attesters' full buckets before top-N can render. With `MAX_EDITIONS = 20` and N≤1000 per attester, worst case ~400 RPC calls; realistic ~6.

The strongest cross-survey signal: **the merge rule should be part of the artifact's contract** (legible to the reader), not a hidden default. Adopted via the `?merge=` URL flag convention.

Adversarial review's loud warnings:
- C-iii (aggregate) MUST NOT ship in v1 by default — multiple unsolved problems.
- C-ii (last-write) unsafe under shareable URL model — reordering editions list silently flips trust authority.
- C-v (intersection) incompatible with ADR-0039 tail-fallback — almost always empty for fresh users.
- C-i and C-iv are the only modes safe to default-on; ship in that exact configuration.

The subagent reports themselves are not preserved in this notes file (they ran in cross-agent dialogue context); the conclusions above are the load-bearing summary.

---

## Round 5 — radical simplification

After the round-4 doc landed (~648 lines, 4 patterns including P3, full merge convention section, `EFSListView` shipping in v1, multi-PROPERTY metadata), James asked the meta-question: "is this too complex?" Three more subagents (clean-slate radical, one-list-with-options, two-list strict-split) plus a parallel pass from Codex converged on simplification.

### Two modes, not four (or three, or one)

The structural alphabet collapses to two modes:

- **Item List** — TAG targets the item directly. P1 unchanged.
- **Entry List** — TAG targets an entry anchor that PINs to the item. P1.5 + P2 unified; the previous P1.5-vs-P2 distinction (target-keyed vs occurrence-keyed naming) becomes a writer convention inside Entry List, not a separate `listKind`.

P3 (sorted folder) drops out of the list taxonomy entirely — folders are folders, not lists. `listKind` collapses from 4 values to 2 (`item` / `entry`).

The "one mode only" alternative (always-wrapped, every list is an Entry List) was considered seriously and rejected: it taxes the dominant case 3× and creates EAS state per address listed (asymmetry between "things in EFS" and "people on the network"). The simplicity gain doesn't earn its weight.

### Aggressive cuts to v1 scope

Codex's parallel synthesis pushed simplification further than my agent passes did, and James adopted most of it:

- **Drop `EFSListView` from v1.** Use `EdgeResolver.getActiveTagEntries` + SDK multicall directly. Add the helper later only if implementation pain demonstrates need. Pre-launch, the burden of proof is on adding contracts, not omitting them.
- **Drop merge semantics from the canonical design.** Multi-attester rendering is client UX, not list architecture. The previous "Recommended URL conventions for clients" subsection — even though it was small — is removed. Future merge conventions can land as separate docs without changing the list design.
- **Singular `itemSchema`, not `allowedTargetSchemas`.** Drop the multi-schema allowlist case from v1. Mixed-schema lists are an Entry List with diverse inner PINs; a future plural variant can be added without breaking the design.
- **Drop `displayLimit`, `weightMeaning`, `weightDirection`, `tieBreak`, etc.** These are presentation conventions; apps use generic PROPERTYs. Spec stays minimal until cross-app interop demands a convention.

### Edition flexibility preserved deliberately

James flagged: "We should try our hardest not to design in a way that makes editions very hard." The two-mode design preserves edition independence at every layer:

- Per-attester storage (`_activeByAAS`) is independent — both modes read per-attester.
- Item List editions: trivial (parallel reads per attester).
- Entry List editions, target-derived naming: entry anchors are shared schelling points across attesters; per-attester PINs and TAGs filter naturally.
- Entry List editions, occurrence-derived naming: per-curator entry anchors; intentional patching possible by reusing existing occurrence anchors.

No mode forces merge to happen on-chain; all merging is client-side composition. Future merge conventions can ship without contract changes. **This was explicitly considered and validated as part of the round-5 simplification, not added as a constraint after the fact.**

### `listKind` clarification

James asked: "is `listKind` a proxy for two different schemas?" No. Both modes use the same TAG schema. `listKind` is a client-side reader hint that tells clients which read recipe to apply (TAG-targets-item vs traverse-entry-anchor). Without it, readers would have to infer mode from the TAG's `refUID` schema — fragile when storage shapes mix. Smart contracts could validate consistency, but the kernel doesn't enforce it.

### Doc length impact

Pre-round-5: ~648 lines of design + ~284 of notes.
Post-round-5: ~250 lines of design + ~340 of notes.

Notes file accumulates design history; design doc is the canonical pre-ADR artifact. The simplified design eliminates entire sections: Q1 multi-edition merge, recommended URL conventions, `EFSListView` signature + composition patterns, split P1/P1.5 schema-semantics discussion, multi-schema sort-before-truncate pitfall, large rejected-alternatives matrix.

What stays load-bearing: the two modes, the picker question, list metadata convention (just `listKind` + `itemSchema`), reading conventions via existing kernel reader, editions composition, the entry-anchor squatting pitfall (now Entry List specific), the `listKind` advisory rule.

The round-5 simplification was tested against the 100-year-design lens explicitly: a future agent inheriting this in 2076 reads "lists are ordered tagging; two modes by what TAG targets" and is done. Compare with the round-4 model where they'd need to learn 4 patterns + merge conventions + helper contract semantics + multi-schema rules.

### What was preserved as parked / future work

- `EFSListView` helper (deferred, not rejected)
- Allowlist `allowedTargetSchemas` (deferred as `itemSchemas` plural)
- Multi-attester merge URL conventions (future shared-conventions doc)
- TAG-source extension to `EFSSortOverlay` (deferred until contract-consumer demand)
- ADR-0039 alignment ADR (rightmost-priority chain ordering, if/when client merge conventions formally adopt that direction)
- FractionalSort (deprecated as list requirement; parked as possible future huge-list optimization)

These all live in the doc's "Out of scope for v1 / future work" section so future agents know they were considered, not forgotten.

---

## Round 6 — pre-dev validation pass

After the round-5 simplified doc landed (~270 lines), James asked the validation question: "is this ready for dev? Did we miss anything?" Three subagents (expert panel from web3 / database / system design / SWE perspectives; end-to-end use case verification across 10 use cases; pre-launch readiness audit) plus a parallel Codex pass with five subagents converged on YELLOW LIGHT — architecture sound, but ~15-20 operational details that round-5 cut too aggressively or never had.

### What round-5 cut too deep

The round-5 simplification removed several things that turn out to be load-bearing for implementation:

- **Weight-spacing convention** (sparse `int256` for manual order with periodic rebalance) was in notes only. Implementers without it pick contiguous ranks (1..N) and pay 5-30× cascade cost on every reorder. **Restored as SDK SHOULD for manual-ordering use cases**, NOT a universal MUST (Codex correction: ratings, votes, and scores use meaningful weights and shouldn't be forced into sparse spacing).
- **Snapshot consistency caveat** for paginated reads was in notes only. ADR-0007 swap-and-pop on revoke can shift array positions between calls; multi-page readers MUST pin to a single `blockTag`. Pulled into canonical doc as MUST language.
- **Round-4 multi-attester merge analysis** was cut entirely. **Restored as INFORMATIVE only** (Codex correction): ADR-0031/0039 currently use first-wins for path resolution; lists adopting different defaults requires its own ADR. v1 says: default reads are single-curator-scoped; multi-attester is opt-in and MUST preserve attribution.

### New things neither thread had before round-6

- **Reframing**: "weighted TAG set + direct/wrapped member patterns" replaces "two modes." One primitive, two recipes. Codex's framing; both threads adopted.
- **`memberMode` rename** from `listKind`. Codex's vote: clearer, less "two protocol types" connotation. Values: `"direct"` | `"wrapped"`. Locked v1 enum.
- **`entryIdentity` PROPERTY** for wrapped lists. Codex's catch: making the entry naming convention machine-readable (vs writer-convention-only) is required for reliable client validation. Values: `"target"` | `"occurrence"`.
- **Single-curator metadata authority rule.** Codex's catch: `memberMode`, `itemSchema`, `entryIdentity` are PROPERTYs and therefore edition-scoped. Default reads are scoped to one curator attester for ALL metadata + TAGs + entry PINs + entry metadata. Multi-attester is explicit opt-in.
- **`itemSchema` REQUIRED for direct mode** (vs Recommended). A direct reader can't enumerate without `itemSchema` (it picks the `_activeByAAS` bucket). For wrapped, the outer bucket is always `ANCHOR_SCHEMA_UID` so `itemSchema` is recommended-not-required (describes inner targets).
- **`clientNonce` ≥ 128 bits CSPRNG MUST.** Sequential nonces enable squatting attacks where an attacker pre-computes the next entry-anchor name. Exact formula: `keccak256(abi.encode("efs:list-occurrence:v1", listAnchor, creatorAddress, clientNonce))`.
- **Default total order**: `weight desc`, tie-break by target/entry UID asc, then `tagUID` asc. Apps may declare alternatives.
- **Wire encoding rules**: lowercase enum strings, `0x` + 64 hex schema UIDs, exact-length anchor names, address sentinel as 32 zero bytes.
- **Wrapped-list invalid-entry behavior**: missing PIN, schema mismatch, target-derived name mismatch, revoked PIN. Each surface as visible warning state; never silently render incorrect content.
- **Direct-mode mixed-schema TAGs silently fragment** — explicit warning. Picker rule routes mixed-target curators to wrapped.
- **Forking convention**: Bob's fork = his own list anchor + optional `originList` PROPERTY. Bob does NOT silently mutate Alice's anchor.
- **Migration recipe Item → Entry**: explicit fork-as-new-list (revoke direct TAGs, create new list anchor, attest entry anchors). No in-place migration.
- **Target universe warning**: raw schema UIDs are NOT valid TAG targets via `refUID`; schema registries MUST target schema-alias anchors per ADR-0033.
- **ADR-0042 effective-TAG filter does NOT apply to lists by default**: a `weight = 0` blocklist entry is active membership; a `weight = -3` rating is meaningful. Apps MAY apply `weight ≥ 0` filter for their own UX but it's not the canonical default.
- **`getActivePinTarget` returns `bytes32(0)` on missing slot** (already true in code; documented). Clients render warning state; never treat as the address sentinel.

### Decisions the validation pass landed

- `memberMode` rename (Codex's vote, both threads endorsed).
- `entryIdentity` as required PROPERTY for wrapped (Codex's catch).
- Single-curator scope for default reads (Codex's framing).
- Singular `itemSchema` retained for v1; mixed-target lists routed to wrapped pattern with loud warning.
- Default ordering rule explicit.
- Multi-attester merge informative-only (NOT normative — would conflict with ADR-0031/0039).
- `EFSListView` helper still deferred. `getActiveTagTargetsWithWeights` reader on `EdgeResolver` is a separate spike candidate; ship in v1 if tiny + gas reasonable.
- specs/06 rewrite required before dev writes list data (was: deferred until design lands; tightened to required-pre-dev).

### Validation pass also raised these (out of scope for now)

- Naming concern (.NET overlap of "Item List" / "Entry List"). My SE agent flagged; Codex didn't echo. Resolved by keeping recipe names as user-facing aliases and using `memberMode = "direct" | "wrapped"` in the protocol layer. No rename of recipe names.
- ERC-5219 read shape for `web3://<list-anchor>` URLs. Web3-expert flagged. Routed to "out of scope" — separate router-layer concern.
- EFP / Snapshot interop note. Web3-expert suggested. More than v1 needs; future doc concern.

### Doc length impact

Pre-round-6: 270 lines design + ~340 notes.
Post-round-6: ~430 lines design + ~430 notes.

Net: ~+160 lines on canonical doc. Still well under round-4's 648. The additions are operational specs (encoding rules, validation behaviors, snapshot consistency, reader recipes) — not new architecture.

### Pre-dev punchlist (status)

The validation pass surfaced ~17 items; this round closed all of them in the canonical doc. Remaining pre-dev work is now:

1. ADR-A drafting (canonical decision record from this design)
2. specs/06 rewrite (REQUIRED before dev writes list data, per round-6 decisions)
3. Spike: end-to-end direct + wrapped contract test
4. Spike: multi-attester edition test (shared schelling-point entry anchors under `entryIdentity = "target"`)
5. Spike: `getActiveTagTargetsWithWeights` reader gas measurement
6. Spike: anchor-name validator dry-run

Estimated 3 days total; mostly parallel.

---

## Round 7 — multi-source review pass + smart-contract API commitment

After round-6 validation closed the operational gaps, James shared parallel review feedback from Gemini and a fresh Claude instance. Both surfaced concerns that converged on one principle James then made explicit:

> "Ship whatever is needed at the data structure level pre-1.0 as it'll be immutable after that. We can't rely on an SDK to do the right thing as smart contracts can do things too. The public APIs need to work, and the data structures need to be solid."

This reframed the design's relationship between conventions and on-chain APIs. Round-6 had committed to `getActiveTagTargetsWithWeights` as a "spike candidate" — round-7 promotes it (plus two siblings) to **v1 shipping units**, because:

1. Smart contracts read EFS data structures directly. They don't run an SDK. Anything the design asks "the SDK to enforce" is trivially bypassable by direct contract consumers.
2. Post-1.0 the data structures + public reader APIs are immutable. Adding bundled readers later isn't impossible (stateless helpers are redeployable) but creates fragmentation as multiple consumers reinvent the multicall.
3. Pre-launch the cost of adding three view methods to `EdgeResolver` is small (a few hundred lines of view code wrapping existing storage reads). The post-launch cost of NOT having them is consumers diverging.

### v1 reader API additions (committed)

Added to `EdgeResolver` in v1, all view methods over existing storage:

- `getActiveTagTargetsWithWeights(definition, attester, targetSchema, start, length) → (targetID, tagUID, weight, attester)[]` — bundles `getActiveTagEntries` + per-TAG `refUID`/`recipient` extraction. For Item Lists returns the actual item targets directly.
- `getActiveTagPinTargetsWithWeights(definition, attester, tagTargetSchema, start, length) → (tagTargetID, tagUID, pinTargetID, pinTargetSchema, weight, attester)[]` — extends the basic reader: for each TAG whose target is itself an anchor, additionally resolves the anchor's PIN target. Generic over any "wrapped" pattern, not just lists.
- `validateAnchorNameMatchesPinTarget(anchorUID, attester) → bool` — generic anchor-name consistency check. Useful for any self-naming anchor pattern (target-derived entry lists use it; other patterns may also).

These transform the smart-contract read path from N+1 separate reader calls per entry to single calls. They're explicitly NOT a stand-alone `EFSListView` — adding to `EdgeResolver` keeps them in the kernel-extension layer rather than introducing a new contract.

### Other round-7 additions

- **Non-goals section**: explicit list of use cases lists are NOT trying to support (mutable per-item state machines, real-time collaborative editing, computed lists, time-windowed queries, cross-attester aggregation, default-UX reverse lookups). Distinct from "Out of scope" (deferred); these are intentional shape rejections.
- **Conventions vs enforcement section**: explicit acknowledgment that several invariants are convention-only (kernel cannot enforce). Includes named revisit triggers — if shape-invalid lists exceed measurable share, sequential nonces appear at indexer layer, etc., promote to on-chain enforcement via custom resolvers or schema additions.
- **memberMode mutability pitfall**: re-attesting the metadata-binding PIN flips `memberMode` in O(1) without TAG storage migration. SDK MUST refuse the flip; contracts SHOULD validate; future custom resolver could constrain on-chain.
- **clientNonce kernel-unenforceability**: explicit acknowledgment that ≥128-bit CSPRNG MUST is convention only. Smart contracts consuming wrapped-occurrence lists treat the TAG attestation chain as the trust unit, NOT the entry name pattern. Squatting risk is asymmetric between target-derived (validatable) and occurrence-derived (kernel-blind) entries.
- **Indexer notes section**: explicit subsection for subgraph implementers covering event ordering, active-vs-historical state, metadata mutability, and reverse-lookup index access.
- **Cost asymmetry warning louder**: "if you might ever want notes, choose wrapped from the start" — migration is fork-only, so the picker question MUST be answered honestly at list creation.
- **Snapshot consistency clarified**: smart contracts get atomicity for free in single calls (the new bundled readers preserve this). Off-chain clients still MUST pin `blockTag` manually — `wagmi`/`viem` defaults don't.

### Decisions resolved (now 14 items)

Added decision 14: "Convention-violating lists are an accepted v1 risk with explicit revisit triggers." Round-7 admits the trade-off honestly; the long-tail risk section names the conditions under which to escalate.

Updated decision 4: from "EFSListView helper deferred" to "smart contracts read directly; v1 ships the bundled readers." Round-7's most consequential change.

### Doc length impact

Pre-round-7: 391 lines design + ~430 notes.
Post-round-7: ~510 lines design + ~510 notes.

Net: ~+120 lines on canonical doc. Still under round-4's 648 (the high-water mark before round-5's simplification), but materially closer than round-6. The additions are all genuinely needed — operational specs for smart-contract consumers, honest acknowledgment of unenforceable invariants, named revisit triggers for known fragility.

### What round-7 explicitly does NOT add

- **Sparse-weight as universal MUST.** The fresh-Claude review pushed for this; Codex's round-6 correction (SHOULD for manual ordering only; ratings/votes use meaningful weights) is upheld. Cascade-reorder cost is a performance concern, not correctness.
- **Migration helpers Item → Entry.** No silent migration is possible; the doc is loud about fork-as-new-list. Migration helpers would imply silent flip is possible, which it isn't.
- **MemberMode kernel-side enforcement (custom resolver).** Reserved as a long-tail-risk trigger; not pre-emptive in v1.
- **Nonce-entropy resolver.** Same: reserved as a long-tail-risk trigger.

### Cross-thread convergence at round-7

Three reviewers (Gemini, fresh-Claude, Codex earlier) all flagged variants of "the kernel doesn't enforce; clients diverge." James's framing closed this by committing to bundled readers + accepting convention-only invariants where unenforceable. The design is honest about both: what's enforced, what's convention with named revisit triggers, what's intentionally not supported (non-goals).

This round felt different from rounds 1-6 because it shifted from "what's the right design?" to "what's the right enforcement boundary?" The design didn't change architecturally — the enforcement model became explicit.

---

## Round 8 — API layer-leak correction

After round-7 committed three new view methods to `EdgeResolver`, Codex pushed back on the names. Round-7 had:
- `getActiveTagTargetsWithWeights` — fine, generic enough.
- `getEntryListPage` — list-specific name in a generic kernel resolver. Layer leak.
- `validateTargetDerivedEntry` — list-specific name in a generic kernel resolver. Layer leak.

Codex's argument: `EdgeResolver` is the generic PIN/TAG resolver. Adding list-overlay vocabulary into the kernel layer pollutes the abstraction permanently (ABI names are forever post-1.0). Two options:
1. Generic graph-operation names (e.g., `getActiveTagPinTargetsWithWeights`, `validateAnchorNameMatchesPinTarget`)
2. Stateless `EFSListView` contract in v1 for list-specific APIs

Round-8 adopted Option 1. Final method set on `EdgeResolver`:

- `getActiveTagTargetsWithWeights(definition, attester, tagTargetSchema, start, length) → (tagTargetID, tagUID, weight, attester)[]` — generic TAG bucket reader with target extraction.
- `getActiveTagPinTargetsWithWeights(definition, attester, tagTargetSchema, start, length) → (tagTargetID, tagUID, pinTargetID, pinTargetSchema, weight, attester)[]` — extension that follows PINs through TAG targets that are themselves anchors. Generic graph composition; lists USE it for wrapped-mode reads but other "wrapped" patterns could too.
- `validateAnchorNameMatchesPinTarget(anchorUID, attester) → bool` — generic self-naming-anchor consistency check.

All three names describe pure graph operations. No list, entry, or list-overlay vocabulary in the kernel ABI. Lists USE these methods; the kernel doesn't know about lists.

`tagUID` in return tuples (Codex's separate point) was already in the round-7 signatures; round-8 confirms it for both readers (used for deterministic final tie-break, audit/debug, revocation UX).

Round-8 also fixed several doc nits Codex caught:
- Duplicate "Single-curator scope" subheading (round-7 paste error) — removed.
- Reader recipes still using low-level methods despite committing to bundled ones — updated to use bundled with low-level fallback noted separately.
- Implementation sketch had `getActiveTagTargetsWithWeights` listed as both committed shipping unit AND spike candidate — deduped.
- TL;DR phrasing "via existing `EdgeResolver` reader API" undersold the v1 extensions — updated.

This round didn't change the design semantically; it cleaned the API surface to keep the kernel/overlay layer separation honest. Adding `EFSListView` would have been the alternative if generic naming hadn't worked, but generic naming captures the operations cleanly without a new contract.

### Why this matters at the 100-year horizon

ABI names on `EdgeResolver` are part of the kernel layer permanently. If we'd shipped `getEntryListPage`, future agents reading the kernel resolver would learn that the kernel knows about "entry lists" — except it doesn't, because EFS lists are a file-system overlay concept built atop graph primitives. Generic-named methods preserve the architectural truth: the kernel is graph; lists are an overlay; the overlay uses kernel primitives without injecting overlay vocabulary into them.

This is the "specs/01 layer model" discipline applied to ABI. Caught at round-8, before the names became immutable.

---

## Round 9 — three independent validation reviews

After round-8 closed the API layer-leak concern, James ran the validation prompt from the previous round through three fresh agents in parallel: Gemini, Codex, and a fresh Claude instance. None had access to chat history; each read the canonical doc + notes cold.

### Verdict synthesis

| Reviewer | Verdict | Spirit of feedback |
|---|---|---|
| Gemini | GREEN | Ship; document NatSpec warnings on the readers |
| Codex (fresh) | NO-GO until ADR + spec rewrite + ABI freeze | Architecture sound; specs/06 conflict + ABI tightening are real blockers |
| Claude (fresh) | YELLOW-GREEN | 7 small mechanical fixes |

The disagreement was less than it appeared: Codex's NO-GO was gated on `specs/06` rewrite + ADR-A (already part of the plan) plus ABI tightening shared with Claude-fresh's punchlist. Gemini's GREEN was conditional on NatSpec deliverables.

### What round-9 incorporated

**Picker rule expanded with flowchart + worked examples** (Claude-fresh, Codex). Replaced the philosophical question with a decision tree and three concrete examples (top friends → direct; annotated books → wrapped target-derived; playlist with duplicates → wrapped occurrence-derived).

**Page-size cap promoted from SHOULD to MUST-enforce** (Codex, Claude-fresh). The new readers MUST revert with `PageSizeTooLarge()` on `length > 100`. Protects on-chain consumers from gas-griefing when they propagate caller-supplied lengths.

**Indexer notes substantially expanded** (Codex). Added two critical sections:
- TAG supersession via re-attest at same edgeHash — kernel updates active set in place WITHOUT emitting a `Revoked` event for the prior TAG. Indexers reconstructing active state MUST detect this case via edgeHash matching, not just by listening for `Attested`/`Revoked` pairs.
- PIN supersession via re-attest at the same singleton slot — metadata-binding PINs supersede by `(definition, attester, targetSchema)`, not by edgeHash. If the target changes, the edgeHash changes too, so indexers MUST track `_activeBySlot` semantics separately from TAG edgeHash semantics.
- Discovery indexes (`_targetsByDef`, `_edgeDefinitions`) vs active state. Discovery indexes are append-only and include historical entries; they're seeds for "what attestations have ever existed at this triple," NOT ground truth for current active state. Indexers MUST cross-reference active-set storage.

**`clientNonce` trigger wording fixed** (Codex). Round-7's trigger said "if sequential nonces appear at the indexer layer" — but sequential nonces look identical to CSPRNG output in `keccak256(...)` hashes. The real signals are downstream effects: write-aborts because the expected anchor name already exists, successful squatting attacks reported, anchor-name collision rates above birthday-paradox baselines. Wording corrected.

**`memberMode` mismatch upgraded from SHOULD to MUST for on-chain consumers** (Claude-fresh). Smart contracts feeding governance, allowlist gates, or any decision with security consequence MUST validate declaration against actual storage shape. Display-only consumers MAY treat as warning.

**NatSpec requirements documented at implementation time** (Gemini). Three new view methods get explicit NatSpec deliverables:
- Address-target encoding (`bytes32(uint160(recipient))`) for `getActiveTagTargetsWithWeights`.
- `pinTargetID = bytes32(0)` semantics + `memberMode` advisory warning + occurrence trust model for `getActiveTagPinTargetsWithWeights`.
- Validation scope (name-to-PIN consistency, NOT membership) for `validateAnchorNameMatchesPinTarget`.

**Conformance test matrix promoted from spike to required pre-launch** (Codex). 19 enumerated tests covering direct mode, wrapped target, wrapped occurrence, page-size cap, mode flip, snapshot consistency, anchor-name validation, adversarial scenarios, and indexer state reconstruction. Failing any of these is non-conformant for v1.

### What round-9 pushed back on

**Bundling name-validation into `getActiveTagPinTargetsWithWeights`** (Claude-fresh #4). Smart contracts get atomic access within one transaction; off-chain clients pin `blockTag`. Adding name-validation to every read pays gas for everyone and doesn't solve a real TOCTOU (which only applies across separate calls without block pinning). Defer.

**Day-1 custom resolver for `memberMode` mutability** (Gemini #1 should-consider). Unnecessary additional surface. Advisory metadata + on-chain consumer validation MUST + long-tail-risk-trigger framework cover v1. The custom resolver remains parked as a long-tail-risk-trigger response if mutability proves harmful.

**Renaming `validateAnchorNameMatchesPinTarget` → `validateTargetIdentityEntry`** (Gemini #2 should-consider). Would re-introduce list-overlay vocabulary into the kernel resolver — exactly the layer leak Codex pushed back on in round-8. Generic name stays.

### Gemini's edge-case use cases (parked for future exploration)

Gemini surfaced six advanced/edge use cases that are out-of-scope for v1 but interesting to document for future design space:

- **Private/metadata-obfuscated lists** — current design is inherently public; truly private lists need blinded edge schemas (incompatible with PIN/TAG transparency).
- **Tier lists (multi-dimensional ranking)** — clients pack `(tier, rank)` into the single `int256 weight` or use auxiliary PROPERTYs; no kernel concept of tiers.
- **Ephemeral / auto-expiring lists** — no protocol-level TTL; requires off-chain cron to issue revokes.
- **Hierarchical / graph structures (skill trees)** — flat list model only; relational structure expressed via `parentEntry` PROPERTYs (expensive to maintain, hard to query).
- **Multi-sig / council-curated lists** — works natively if the attester is a Smart Account, but UX friction is high for multi-sig coordination on per-entry attestations.
- **A/B testing / draft lists** — no preview-then-publish; requires creating a new list anchor and signaling cutover (ENS, master PIN).

These are documented here for future agents but explicitly out of v1 scope. Each could become its own design proposal if/when concrete demand emerges.

### Claude-fresh's stale-recipe catch

Claude-fresh flagged that the Direct-mode reader recipe (lines 192-203) was using low-level `getActiveTagEntries` + per-TAG `eas.getAttestation` despite round-7 committing to bundled readers. Round-8 had updated the recipe to use `getActiveTagTargetsWithWeights`; Claude-fresh either read a pre-round-8 cached version or the recipe still had subtle issues. Verified post-round-9: recipes use bundled readers, low-level fallback noted separately.

### Round-9 doc length

Pre-round-9: 510 lines design + ~523 notes.
Post-round-9: ~570 lines design + ~610 notes.

Net: ~+60 lines on canonical doc (page-cap MUST, indexer supersession, NatSpec section, conformance matrix). Notes grew with round-9 history.

### Status after round-9

The validation pass surfaced ~12 actionable items, all incorporated. No architectural changes — all operational tightening, prose improvements, and concrete commitments. The design is now in the strongest pre-implementation state it has been in across 9 rounds.

**Convergence with Codex's NO-GO conditions:**
- ABI freeze: addressed (page cap MUST, NatSpec requirements, no method renames).
- specs/06 rewrite: still required pre-dev, on the punchlist.
- ADR-A: still required pre-dev, on the punchlist.
- Indexer rules: substantially expanded.
- Conformance test matrix: now mandatory in canonical doc.

After ADR-A drafting + specs/06 rewrite + the spikes, this should be GREEN unanimously.

### Round 5 Codex cleanup: stale prose after P2/rightmost-wins reframing

Codex's final pass after Claude's round-4 commit found no conceptual blocker, but a few stale lines still reflected older frames:

- P1/P1.5 multi-attester prose still said ADR-0039 "natively" selects the view. Updated to say clients compose per-attester buckets; no contract-level merge mode is baked in.
- `allowedTargetSchemas` section said "P1 vs P1.5"; updated to "P1 vs entry-anchor lists" so P2 is included.
- P2 multi-attester prose now distinguishes default independent occurrence IDs from intentional patching. If Bob wants to modify Alice's occurrence, he can reuse Alice's entry anchor and write his own TAG/PIN; otherwise independent P2 occurrences do not conflict.
- Rightmost-wins note now warns implementers that current ADR-0039 default chains are documented leftmost-priority. Until ADR-0039 is aligned, clients must receive/reorder default chains in rightmost-priority order before merging.
- Appendix / implementation sketch / likely ADR shape cleaned up so they no longer reserve positional anchors for P2 or claim a separate "ranked-set merge" ADR is needed.

---

## Speculation / parked ideas

### Future `EFSListView` extensions

Once Q1 is resolved, candidates for additional helpers:

- **Multi-attester convenience helper** taking an explicit `mergeMode` parameter. Worth adding once merge policy is locked. Avoid until then.
- **Allowlist convenience helper** that takes a `targetSchema[]` and merges per-schema reads internally. Probably premature; clients can do this trivially.
- **Generic-schema enumeration** by querying off-chain indexer addresses passed as parameter. Likely better as off-chain SDK, not on-chain helper.

### Computed lists ("smart lists" / "saved searches")

Membership derived from a predicate (e.g., "all DATA tagged `#scifi` by people I follow"). Likely needs either:
- A new primitive (predicate language stored as DATA + interpreted by an off-chain or on-chain evaluator)
- Or extensive off-chain indexer support with no kernel involvement

Not in v1; tracked as future work in main doc. Worth its own design pass when concrete demand appears.

### Reverse lookups ("lists containing X")

Documented as an anti-feature in default UX (`Pitfalls and safety` section). But there are legitimate viewer = subject use cases:

- "What lists am I featured in?" (the viewing user is the subject)
- "Who has put me on a blocklist?" (subject-only knowledge)
- "Lists that recommend me as a curator"

Likely a separate opt-in API surface, gated by `viewer == subject` checks at the client. Worth a deliberate design rather than ad-hoc per-client behavior.

### Aggregate views (Q1 option C)

Deferred from v1 due to Sybil concerns. Future-design candidates:

- **Reputation-weighted aggregation** — requires reputation graph primitive (which doesn't exist yet).
- **Threshold-based aggregation** — "show items at least N attesters agree on"; tunable but no Sybil resistance.
- **Per-list aggregator** — each list declares an aggregator address whose merge policy is canonical for that list; trust delegated explicitly. Closest to the "curator-owned selection" pattern from social products.

None of these is right yet. Park for separate proposal once a concrete use case justifies the complexity.

### `EFSListView` allowlist iteration helper

If `allowedTargetSchemas` becomes commonly multi-schema in practice, a helper that iterates schemas internally (still single-attester) might earn its keep:

```solidity
function getRankedSetPageMultiSchema(
    bytes32 listAnchor,
    address attester,
    bytes32[] calldata targetSchemas,  // allowlist
    uint256 start,
    uint256 length
) external view returns (RankedEntry[] memory, uint256 nextStart);
```

Returns interleaved or schema-grouped entries. Probably premature — wait for client implementation feedback.

### TAG `sourceType` extension to `EFSSortOverlay`

Deferred from v1 (D5). Could land later if a concrete contract-consumer demands lazy paginated sorted access over very long ranked sets. The hard part is reconciling swap-and-pop on revoke with `_lastProcessedIndex` append-only assumptions. Possible approaches:

- An append-only side index (one extra storage slot per TAG insertion; no compaction)
- A snapshot index that periodically rebuilds (gas spike, complexity)
- Skip the overlay for TAG buckets entirely and add a separate `TagSortOverlay` contract with different semantics

Not worth solving until concrete demand surfaces.

---

## Verification notes / things to double-check during implementation

### Anchor name validation for P1.5 entry anchors

P1.5 names entry anchors by lowercase 0x-hex of the target UID (or address). Need to verify against ADR-0025's anchor name character set + length limits:

- Target UID: 0x + 64 hex chars = 66 ASCII chars
- Target address: 0x + 40 hex chars = 42 ASCII chars
- Lowercase hex characters `[0-9a-f]` are within standard ASCII printable range

Should be fine but worth running the actual validator at implementation time.

### Gas cost estimates in main doc are informal

The cost lines in the design doc ("~4 attestations", "~7 with one note field") are informal estimates based on attestation counts, not measured gas. When implementing, run actual hardhat gas measurements and update the main doc if material differences emerge.

### `EFSListView.getRankedSetEntriesPage` reads `_activeByAAS` indirectly via `EdgeResolver`

**Resolved (round-2 review):** Codex confirmed `EdgeResolver.getActiveTagEntries(definition, attester, schema, start, length)` already exists per ADR-0041 §8 reader API and supports `(start, length)` pagination. `EFSListView` calls it directly. **No kernel-side reader addition needed.** Reflected in the Read primitive section's "Dependency check" note.

### EFS Team known-address recognition

If clients need to distinguish "EFS Team-curated" predicates from random community ones, there should be a stable mechanism — likely a known address registered in `deployedContracts.ts` or similar. Worth confirming the registration mechanism before clients start hard-coding addresses.

---

## Discarded ideas (with reasoning, in case revisited)

### A `LIST_ITEM` schema (briefly considered, rejected)

Would have been a new EAS schema wrapping `(target, listDef, weight, targetSchema)`. Rejected as Tier-1 commitment without justification when existing primitives suffice. Captured in the main doc's "Rejected alternatives" appendix.

### JSON manifest as list metadata

Considered a single DATA per list holding all metadata as JSON. Rejected because individual PROPERTYs are independently rebindable in O(1), match the ADR-0034 idiom, and clients can read just what they need. JSON manifest would force full re-attest on any change.

### Multi-attester opaque-cursor `EFSListView`

Considered. Rejected per the design history above — pushes merge semantics into the helper. The single-attester paged variant is composable.

### `?merge=union` as the URL surface for Q1 option B

Considered as a fixed URL parameter. Backed off because the broader merge question (router-global) hasn't been decided in QUESTIONS.md tier-2; committing this design's URL surface independently would risk inconsistency. The doc now defers concrete syntax to ADR-0031 resolution.

---

## Round 11 — substantive architectural simplification

After round-10 declared "convergence," James reviewed the canonical doc fresh and surfaced four concerns that triggered a real architectural revisit. He explicitly authorized ignoring ADR/Tier-1 framework concerns: "everything is up for change if it makes the system better."

### The three big changes

**1. Always-wrapped (one mode, not two).** Round 5 split lists into "direct" (TAGs target items) and "wrapped" (TAGs target entry anchors that PIN to items). The split was justified by ~3x cost asymmetry on simple top-N cases. James pushed back: cost is pennies on L2; the conceptual debt of two modes (picker rule, migration-as-fork, mode-mismatch pitfalls) wasn't worth the saving. Always-wrapped wins on simplicity, extensibility, and one mental model.

What we gain:
- One read recipe; one mental model
- Migration-proof — any folder can be promoted to a list
- Per-entry-in-list-context metadata always available (e.g., "this song should rank 5 higher in *this* playlist" without saying "this song is my favorite")
- No picker rule; no "mode-mismatch" pitfall class
- Per-list state on entries (status, notes, captions) trivial

What we lose:
- ~3x attestation cost on simple cases (top-N favorites). On L2 this is pennies.
- Direct's `isActiveEdge` cheap-membership-check pattern. For pure allowlist/blocklist contracts that only need "is X in Alice's list," they now need the wrapped read path. Real cost; James judged worth it for the simpler model.

**2. `LIST_DECLARATION` schema (new, non-revocable, replaces `memberMode` PROPERTY).** James caught a real fragility: round-7's `memberMode` PROPERTY (mutable via PIN supersede) is a "permanent type" implemented with mutable storage. The fix: a typed schema attestation (`revocable: false`) makes the list type immutable at attestation time. Costs one new EAS schema, but solves the entire `memberMode` mutability pitfall class.

```
LIST_DECLARATION:
  bytes32 itemSchema       // expected schema of inner targets
  uint8   entryIdentity    // 0 = target-derived, 1 = occurrence-derived
revocable: false
```

This is a Tier-1 commitment per AGENTS.md, but James authorized: "we should ignore ADRs and TIER concerns for these foundational designs. I'm trying to build a good foundation."

Round 5 had rejected `LIST_ITEM` (per-item schema) for proliferation reasons. `LIST_DECLARATION` is different — one schema for the primitive itself, declared once per list. Different proposal, different cost-benefit.

**3. Lists ARE folders (the unification).** James pushed beyond #1 and #2 to a deeper unification: "maybe Folders and these wrapped lists could be merged too." The structural insight: a folder is an anchor with child anchors that PIN to content (this is how files are placed in folders today in EFS). A wrapped list is identical structurally, plus weight TAGs and a `LIST_DECLARATION`. They're the same primitive with optional metadata layers.

The unification eliminates "list" as a separate data structure:
- Plain folder: anchor + child anchors + PINs to content
- List: same + LIST_DECLARATION + weight TAGs on entries
- Sorted folder: same + SORT_INFO
- Sorted list: any combination

A folder can be promoted to a list (add LIST_DECLARATION + weight TAGs). A list can be read folder-style (ignore weights). One graph structure, two rendering conventions.

### The supporting fixes

**4. Shopping lists, todos, and stateful items removed from non-goals.** The earlier "non-goal" of "mutable per-item state machines" was wrongly conservative. Wrapped entries with `status` PROPERTYs (toggleable via PIN re-attest) handle shopping/todo use cases trivially. Updated non-goals to only exclude *complex* state machines with transitions/validations/history (which are app-layer concerns). Simple status PROPERTYs are core supported.

This was a meaningful correction — James pointed out shopping lists and todos are basic use cases for lists, and they were wrongly excluded.

**5. Exhaustive use case audit.** James asked for a thorough use-case audit. The doc now lists 28 use cases mapped to the unified primitive, demonstrating that everything from top-N favorites through annotated catalogs through playlists with duplicates through shopping lists with state through tier lists through cross-list reuse is supported by one mode.

### Decisions resolved (round-11 updates)

| Decision | Pre-round-11 | Post-round-11 |
|---|---|---|
| Modes | Two (direct + wrapped) | One (always-wrapped) |
| `memberMode` declaration | Mutable PROPERTY (could flip in O(1)) | `LIST_DECLARATION` schema, non-revocable |
| `entryIdentity` declaration | Mutable PROPERTY | Field in `LIST_DECLARATION`, permanent |
| Folder vs list | Distinct concepts ("folders aren't lists") | Same primitive ("lists ARE folders") |
| Shopping lists / todos | Non-goal (per-item state machines) | Core supported (mutable status PROPERTYs) |
| Picker rule | "Item or Entry? Then target or occurrence?" | "Target-derived or occurrence-derived?" (one choice) |
| New EAS schemas | Zero | One (`LIST_DECLARATION`) |
| Etched commitments | Zero (or two-mode renamings) | One (the schema; `revocable: false`) |

The tradeoff: we accept one new EAS schema (Etched commitment) in exchange for substantial architectural simplification — one mode, permanent type, unified with folders, all stateful use cases supported.

### Why the round-11 revisit was right

Earlier rounds optimized for "no new schemas, no new resolvers" — the minimum-Etched-surface principle. That's good discipline most of the time, but it's not infinitely reasonable. When the cost of avoiding one new schema is:
- A "permanent type" implemented with mutable storage (memberMode PROPERTY)
- Two modes that need a picker rule and migration-as-fork
- A separate "lists vs folders" distinction that doesn't survive structural inspection
- An exclusion of basic use cases (shopping lists, todos)

…then the principle is overserving its purpose. One new schema (LIST_DECLARATION) for the canonical list-primitive type, used billions of times, is well-worth it. The schema is small (`bytes32 itemSchema, uint8 entryIdentity`), non-revocable, and unambiguous.

The earlier rejection of `LIST_ITEM` (per-item schema) was correct — that proposal would have created proliferation. `LIST_DECLARATION` is per-list, not per-item; one schema, used as the type marker for an entire primitive.

### Round-11 doc length impact

Pre-round-11: 574 lines design + 606 notes.
Post-round-11: ~470 lines design + ~720 notes.

The doc actually got *shorter* despite adding the LIST_DECLARATION schema and 6 new use cases — the unification eliminated the picker rule discussion, the Item-vs-Entry duality, the `memberMode` mutability section, and the migration-as-fork detail. Single-mode design is easier to describe.

### Cross-agent process notes

Eleven rounds total. The first ten converged on a two-mode design that all reviewers (Claude, Codex, Gemini, fresh instances) signed off on. Round-11 was James seeing it fresh and pushing back on assumptions the agents had carried forward without questioning.

Worth recording for future cross-agent work: **agents converge on a "good enough" answer and stop questioning it.** A fresh human review can re-open assumptions that all agents had treated as settled. The round-11 changes are real architectural improvements that no agent had proposed across the prior ten rounds, even though the seeds of all of them existed in earlier discussion.

The lesson: the cross-agent process is great for refinement but doesn't easily detect "we accepted a constraint we shouldn't have." Periodic fresh-human review catches this.

---

## Round 12 — structural correction

After round-11's three-reviewer validation surfaced concrete fix-set, James reviewed the design once more and identified two architectural mistakes that drove round-12's substantial revision:

**1. "Promotion" was a category error.** Round-11 said "promote a folder to a list by adding LIST_DECLARATION." James caught this: "I don't like the idea of 'promotion' of something to something else. An Anchor is a container of tons of things. Anchors with a schema set are for names for a specific thing like a file name. Lists are just another thing that can be added inside an Anchor. Lists can also have names with an Anchor<listSchema>. Anchors are always containers. Lists are always lists."

The structural correction: lists are typed anchors (`Anchor<LIST_SCHEMA>`) that contain entries. They live INSIDE generic container anchors. They're not unifications of folders; they're separate things that can coexist with folders, files, and tags inside an anchor's namespace.

This reverses round-11's "lists are folders" unification. The right framing:

| Thing inside an anchor | What it is |
|---|---|
| Files | child Anchor + PIN to DATA |
| Sub-folders | child Anchor (generic) |
| Lists | typed `Anchor<LIST_SCHEMA>` + LIST attestation + entry anchors |
| Tags | TAG attestations against the anchor |

These are independent, parallel patterns. An anchor can contain any combination of them.

**2. "Direct mode" was always tagging, not a list pattern.** James caught the deeper confusion: "Isn't 'direct mode' just tagged things? An allowlist or denylist is just a /tags/deny tagged on a bunch of addresses. And follow graph is too. Simple. Easy. Cheap lookup + writes. Right?"

Yes — exactly right. Across rounds 5 through 11, the design was trying to make the list primitive serve membership use cases (allowlists, blocklists, follow graphs). These were never list patterns; they're tagging patterns. The "lost direct-mode cheap membership check" that reviewers worried about in round-11 was never a list concern — `isActiveEdge(...)` already exists in `EdgeResolver` per ADR-0041 §8 and serves tag-pattern membership in O(1).

The correct division:
- **Lists** = ranked/curated/metadata-bearing collections (top-N favorites, annotated catalogs, playlists, shopping lists, ranked ballots)
- **TAGs** = membership claims (allowlists, blocklists, follow graphs, DAO membership, categorization, permissions)

The picker question simplifies to: *Need ordering or per-entry metadata?* Yes → list. No → tags.

### The structural design (round-12)

```
Anchor "memes"  (refUID=alice_home, schemaUID=ANCHOR_SCHEMA — generic folder)
  └── Anchor "mylist"  (refUID=memes, schemaUID=LIST_SCHEMA — typed list anchor)
        ├── LIST attestation  (refUID=mylist, entryIdentity=0/1/2, targetKind=0/1/2, targetSchema)
        ├── entry "<entry-name>" anchor  (refUID=mylist)
        │   ├── PIN(definition=entry, target)
        │   └── weight TAG(definition=mylist, refUID=entry, weight=N)
        ├── ... more entries
```

The anchor at `/alice.eth/memes/mylist/` is path-routable. Apps detect it as a list because its `schemaUID = LIST_SCHEMA`. The LIST attestation provides config; entries are children of the list anchor; weight TAGs use the list anchor as their definition (consistent with all other EFS TAG patterns).

### Schema field set (carried from round-11 / Codex's redesign)

```
LIST schema:
  uint8   entryIdentity   // 0=target, 1=occurrence, 2=freeform
  uint8   targetKind      // 0=any, 1=schema-uid, 2=address
  bytes32 targetSchema    // when targetKind == 1
revocable: true
resolver:  ListResolver   // singleton enforcement
```

Three values for `entryIdentity` (target-derived hex / occurrence-derived hash / freeform curator-chosen name) cover the use cases — including shopping lists with "milk", "eggs" entries (freeform).

`revocable: true` per Gemini's UX argument: irrevocable type markers create permanent self-griefing footguns on long-standing namespace anchors. Custom resolver enforces singleton-per-(attester, refUID) so revocation+re-attest is a clean lifecycle event.

### Use cases re-mapped

The 28-use-case audit from round-11 split between LIST patterns (20 cases) and TAG patterns (8 cases). Allowlists, blocklists, follow graphs, DAO membership, categorization, permissions, verification — all moved from the list spec to "tagging patterns; use TAG + `isActiveEdge`."

The list primitive's scope shrank, but its purpose became sharper. Each primitive does one thing well.

### What was eliminated from the design

- "Lists are folders" framing
- "Direct mode" entirely (was always tagging)
- `isActiveListMembership` proposal from the round-11 reviewers (unnecessary; `isActiveEdge` already covers tag membership)
- `LIST_DECLARATION` name (renamed to just `LIST` since it IS the list, not a declaration about a list)
- "Promotion of folders to lists" framing
- Allowlists / blocklists / follow graphs from list use case discussion (moved to tag patterns)

### What was kept

- Always-wrapped within the list primitive (only mode that's actually about lists)
- `entryIdentity` with three values (target / occurrence / freeform)
- Codex's schema redesign (`targetKind + targetSchema` instead of overloaded `bytes32 itemSchema`)
- Singleton enforcement via custom resolver
- All operational specs (page cap, snapshot consistency, indexer notes, validation rules)
- The 20 list-pattern use cases (now correctly identified)
- Entry-anchor squatting Pitfall (target-derived only)
- `clientNonce` enforcement-boundary discussion

### Reflection on the cross-agent process

Round-11 was a substantive simplification that 10 prior rounds had missed. Round-12 was a substantive correction that round-11 had missed. The pattern: **agents don't easily question framing assumptions; humans do.** Round-11's "lists are folders" framing felt clean but forced unification where the actual graph model has separate parallel patterns. James's "anchors are containers, lists are things INSIDE containers" reframing is closer to the actual structural truth.

Worth recording: cross-agent design needs periodic frame-level human review, not just within-frame validation. Agents are good at "is this design correct given these assumptions?" Less good at "are these the right assumptions?"

This is now twelve rounds. The first ten converged on a two-mode design that all reviewers signed off on. Round-11 was the first major simplification (reversed by round-12). Round-12 corrected round-11's framing back to "separate things in containers." If the pattern holds, there's likely one more frame-level question that hasn't been asked. Future agents working in this space should expect at least one more meaningful structural reframe before mainnet launch.

### Doc length impact

Pre-round-12: 482 lines design + 700 notes.
Post-round-12: ~575 lines design + ~830 notes.

Doc grew because it now needs to:
1. Clearly distinguish lists from folders / tags / files
2. Describe the typed anchor + LIST attestation + entries pattern
3. Document the 20 LIST use cases and 8 TAG patterns separately
4. Add Pitfalls for the new structural concerns (anchor schemaUID mismatch with LIST attestation)
5. Update the indexer notes for the new lifecycle events

The clarity gain is worth the line count.

---

## Round 13 — free-floating LIST attestations (file-like model)

After round-12's "lists are typed anchors with LIST attestation as config" model, James proposed another structural reframe: lists should be free-floating attestations like DATA, with anchors connecting to them via PIN. This is the third frame-level architectural change in three consecutive rounds.

His framing: "Lists are a lot like files where they are sort of free floating and tags connect them to their names. So Anchor=memes, Anchor=mylist then a tag points at the list and connects it to the mylist anchor. Like files. So the same list could be in two different folders."

(He used the word "tag" here, but the natural primitive for the anchor → LIST connection is PIN — cardinality-1, same as how anchors connect to DATA for files.)

### The structural shift

Round-12: LIST attestation has `refUID = anchor`; entries are children of the typed anchor.
Round-13: LIST attestation is free-floating (no `refUID` anchor binding); entries are children of the LIST UID; anchors connect via PIN.

```
Round-12:                         Round-13:
                                  
  Anchor<LIST_SCHEMA>             generic Anchor
       │                               │
       ├── LIST(refUID=anchor)         └── PIN(refUID=LIST_UID,
       │                                       targetSchema=LIST_SCHEMA_UID)
       └── entries (refUID=anchor)              │
                                                ▼
                                          LIST attestation L1
                                          (free-floating; UID=L1)
                                                │
                                                └── entries (refUID=L1)
```

### Why round-13 is better

**1. File-like semantics.** EFS already separates content (DATA) from placement (Anchor + PIN). Round-13 brings lists into the same pattern — config and entries free-floating, placement via PIN. Consistent across primitives.

**2. Same list at multiple anchors works mechanically.** Place a LIST at multiple paths via multiple PINs from different anchors. Editing the list updates all views. Like having the same DATA at multiple file paths.

**3. List sharing across attesters is natural.** Bob can PIN Alice's LIST UID at Bob's anchor. Bob's namespace exposes Alice's list. Alice still owns it (entries are her attestations). Like Bob placing Alice's DATA at Bob's path.

**4. Round-12's singleton-enforcement custom resolver becomes unnecessary.** The "duelling LIST attestations per (attester, anchor)" concern resolves automatically: with free-floating LISTs, multiple LIST attestations are just multiple distinct lists. The (attester, anchor) singleton is enforced by PIN cardinality-1 (kernel-level, no resolver needed).

**5. Path anchor doesn't need typed `schemaUID`.** Round-12 required `Anchor<LIST_SCHEMA>` typing. Round-13 uses generic anchors with PINs. Apps detect lists by reading the anchor's PIN, same way they detect files. Eliminates round-12's "anchor schemaUID mismatch" pitfall.

### Trade-offs

**Cost: one extra read step in path resolution.** Round-12: anchor → done. Round-13: anchor → resolve PIN → LIST UID → read attestation. Two extra reads (`getActivePinTarget` + `eas.getAttestation`). Smart contracts: trivial gas (atomic single-tx). Off-chain: minor RPC overhead.

**Reverse lookup ("which anchors hold this list?") needs `getEdgeDefinitions(listUID)`** per ADR-0041 §8. Already exists.

**Orphaned LISTs possible.** A LIST with no anchor PINing to it is path-unreachable. Same as orphaned DATA. Apps don't render orphans. Curators must create at least one anchor + PIN.

### What round-13 changed

- LIST attestation no longer has `refUID = anchor` requirement (free-floating)
- Entries' `refUID = LIST UID` (not the path anchor)
- Weight TAGs use `definition = LIST UID` (not the path anchor)
- Anchor → LIST connection is `PIN(definition=anchor, refUID=LIST UID, targetSchema=LIST_SCHEMA_UID)`
- Anchor at the path is generic — no `schemaUID = LIST_SCHEMA_UID` requirement
- Round-12's `ListResolver` for singleton enforcement is no longer needed (PIN cardinality handles it). Optional `ListSchemaResolver` for enum-range validation may exist as a soft check.
- New use cases enabled: same-list-at-multiple-paths, list-bookmarking-across-attesters, moving-a-list-between-folders
- New pitfall: stale anchor PIN to revoked LIST (curator should revoke PINs first, then LIST)
- Reader recipe gains one step: PIN-resolve to LIST UID before reading entries

### Pattern across rounds 11-13

Three consecutive frame-level reframes:
- Round 11: lists are folders (overshoot — unification didn't match the actual graph model)
- Round 12: lists are NOT folders; membership is tags (correction — separates the patterns)
- Round 13: lists are free-floating like files; placed via PIN (improvement — file-like portability)

Each reframe is a real improvement, not preference shuffling. Each was caught by James seeing the design fresh; none was proposed by any agent across the prior rounds.

The recurring pattern: **agents converge inside a frame; humans question the frame.** Round-13's free-floating model has been sitting in EFS's design DNA the whole time (DATA is free-floating; Anchors place via PIN). No agent extended this to lists across 12 rounds. Worth recording for future cross-agent design work.

### Doc length impact

Pre-round-13: 550 lines design + 808 notes.
Post-round-13: ~640 lines design + ~890 notes.

The doc grew because:
1. Round-13 enables genuinely new use cases (multi-anchor placement, sharing) that need documentation
2. Reader recipe has an extra step that needs explaining
3. Indexer notes need to address the new anchor-PIN-to-LIST event pattern
4. New pitfall (stale anchor PINs) needs coverage

### Round-13 status

Three architectural reframes in three consecutive rounds. Each made the design better. No more obvious frame-level questions remain — the model now matches EFS's existing primitives uniformly:
- DATA + Anchor + PIN = files
- LIST + Anchor + PIN = lists
- TAGs against anchors = membership patterns
- Multiple anchor PINs to same content = shared/multi-path

This is structurally consistent with EFS's primitives. Future agents proposing further reframes should expect a high bar — the design space appears mostly explored at this point. But the round-11/12/13 pattern says: don't be too confident, fresh human review can still find more.

---

## Round 14 — typed list anchors + revocable=false + freeform-no-PIN + placer/curator split

**Date:** 2026-04-30
**Trigger:** Three independent reviewer passes on round-13 (Gemini GREEN/+1 must-fix, Claude RED, Codex YELLOW/conditional NO-GO) plus James's frame-level reframe.

**The three reviews converged on several points and disagreed on others.**

Convergent points (all three reviewers):
1. List-level metadata location was undefined after round-13 decoupled LIST from path anchor.
2. Read API conflated placer (bookmark attester) and curator (LIST attester).
3. Stale-PIN-to-revoked-LIST was a real concern that round-13's mitigation under-addressed.
4. Cross-`targetSchema` PIN at one anchor was ambiguous (DATA PIN + LIST PIN at same slot).

Contested points:
- `revocable: true` (round-13) vs `revocable: false` (Claude argued strongly for false; Gemini for true; Codex either-or).
- Mandatory curator-write-gate resolver (Claude blocking) vs no resolver (Gemini, Codex).
- Co-contribution as feature (round-13) vs attack surface (Claude).

**James's frame-level direction.** James responded with simple, decisive reframes that resolved most of the contested points cleanly:

> "Lists should have name anchors like DATA do. So /memes/mylist[] is anchor<generic>=memes -> anchor<list>=mylist <- tag -> listDef attestation. Anchors have a namespace. DATA have a namespace. Properties have a namespace. Lists have a namespace."

Translation: typed list anchors (`Anchor<schemaUID=LIST_SCHEMA_UID>`) — same shape as `Anchor<PROPERTY>` slots. The schemaUID on the anchor signals what kind of slot it is. This:
- Eliminates the cross-`targetSchema` PIN ambiguity automatically (typed list anchors only hold lists)
- Aligns with the existing PROPERTY pattern (uniformity across primitives)
- Is mechanically the same as round-12's typed anchor insight, but with round-13's free-floating LIST attestation

> "Revocable shouldn't matter and I'm not sure what a list being revoked means. So False I guess. It's not deleting the list as deletion is more like removing the tag so the list doesn't show up inside the folder anymore."

Translation: `revocable: false` on the LIST schema. Match DATA. "Deletion" = revoke the placement PIN, not the LIST attestation. This:
- Closes the curator-key-compromise concern entirely (Alice can't kill bookmarkers' references)
- Removes one whole lifecycle pattern (no more "revoked LIST → stale PIN" warning state)
- Bookmark PINs to a LIST UID never go stale

> "Properties should totally be attached to the list definition attestation. This seems obvious."

Translation: list-level metadata (title, description, etc.) attaches to the LIST attestation as PROPERTY slots, not the path anchor. Bookmarks inherit metadata automatically. (Gemini's must-fix.)

> "Anchors for now use refUID as they are static and immutable. Everything else is tagged dynamic data."

Translation for entries: the entry anchor IS the static identity; for freeform entries the anchor name carries the meaning, no inner PIN required. Per-entry mutable state (status, quantity) goes via PROPERTYs (which are dynamic). (Codex's targetless-entries fix.)

> "Editions seem to work fine as I understood it." (on co-contribution)

Translation: keep co-contribution as a feature. Editions filter spam at read time; default reads are single-curator-scoped. Mallory writing entries against Alice's LIST UID is invisible to viewers reading "Alice's L1." Subgraphs that aggregate across attesters need to scope to a curator — that's an indexer-layer responsibility, not a kernel concern.

### What round-14 changed concretely

- **Path anchor for list:** generic (round-13) → typed `Anchor<schemaUID=LIST_SCHEMA_UID>` (round-14).
- **LIST schema `revocable`:** true (round-13) → false (round-14).
- **List-level metadata location:** undefined (round-13) → PROPERTY slots on LIST attestation (round-14).
- **Freeform entry inner PIN:** required (round-13) → optional (round-14); when absent, the entry anchor IS the entry.
- **Reader API:** single `read(anchor, attester)` (round-13) → split `resolveListPlacement(anchor, placer)` + `readListByUID(listUID, curator)` + convenience `read(anchor, placer, curator?)` (round-14).
- **Co-contribution:** kept as feature; documented "why this is safe at read time" with edition scoping rationale.
- **Cross-targetSchema PIN ambiguity pitfall:** gone (typed list anchors prevent it structurally).
- **Stale-PIN-to-revoked-LIST pitfall:** gone (`revocable: false` removes the lifecycle).

### Why round-14 is better than round-13

1. **Typed anchor namespace is consistent with PROPERTYs.** Each kind of attached thing has its own anchor namespace. Reader sees `Anchor<LIST>` and knows what's coming, no probing. Same as `Anchor<PROPERTY>(name="contentType")`.
2. **`revocable: false` matches the file-parallel cleanly.** DATA is permanent at its UID; LIST is permanent at its UID. Bookmarkers are insulated from curator key-compromise.
3. **List-level metadata travels with the LIST UID.** Bob's bookmark of Alice's list inherits Alice's title, description, cover automatically.
4. **Freeform entries are first-class rows.** Shopping lists and todos don't carry dead-weight target PINs.
5. **API split makes Bob-bookmarks-Alice work correctly by default.** `read(anchor, placer=bob)` defaults curator to the LIST attestation's attester (alice) — Bob's empty bucket isn't returned by mistake.

### Trade-offs / things round-14 still relies on convention

- Co-contribution + spam-resistance: subgraphs MUST scope active-set queries by curator. Cross-attester aggregation is an explicit opt-in. Long-tail-risk trigger: if subgraphs ship without curator scoping and spam surfaces in clients, escalate.
- Curator-self-grief on entries: Alice can revoke her own entry TAGs to "delete" entries; can't undo bookmarks others made of her LIST UID. This is intentional and matches DATA's lifecycle.
- Freeform entry name uniqueness: still curator's responsibility; multi-attester convergence on freeform names is opportunistic.

### Pattern across rounds 11-14

Four consecutive frame-level reframes:
- Round 11: lists are folders (overshoot — unification didn't match the actual graph model)
- Round 12: lists are NOT folders; membership is tags (correction — separates the patterns)
- Round 13: lists are free-floating like files; placed via PIN (improvement — file-like portability)
- Round 14: typed list anchors (parallel to PROPERTY slots) + free-floating LIST + revocable=false + freeform-no-PIN + placer/curator split

Each was caught by James from outside the agent-convergence loop. The recurring pattern: **agents converge inside a frame; humans question the frame.** Round-14's typed-anchor unification has been sitting in EFS's design DNA the whole time (PROPERTYs already use typed anchors with this exact shape). No agent extended this to lists across 13 rounds; James named it directly.

### Round-14 status

Four architectural reframes in four consecutive rounds. Each made the design better. The model now matches EFS's existing primitives uniformly with namespace consistency:
- DATA + Anchor<generic> + PIN = files
- LIST + Anchor<schemaUID=LIST_SCHEMA_UID> + PIN = lists
- PROPERTY value + Anchor<schemaUID=PROPERTY_SCHEMA_UID> + PIN = property values
- TAGs against anchors = membership patterns
- Multiple PINs to same content from different anchors = shared/multi-path
- Free-floating + Anchor + PIN = portability + permanence

A future agent proposing further reframes should expect a higher bar than the prior rounds. But round-11/12/13/14 says: don't be too confident.

Possible-but-deferred fourth-frame question (Gemini): "Should folders be free-floating too?" — extending the file-parallel to make folder hierarchy non-`refUID`-bound. Out of scope for v1; folders stay hierarchical for now.

### Doc length impact

Pre-round-14: 640 lines design + 890 notes.
Post-round-14: 750 lines design + ~1020 notes.

The doc grew because:
1. Typed list anchor + free-floating LIST needed concrete-example rewrite
2. List-level metadata section is new
3. Placer/curator split needs explicit treatment in the read API
4. Co-contribution rationale is documented (instead of just asserted)
5. New conformance tests (rows 13, 15, 17, 19, 20, 22, 30 changed or added)

---

## Round 15 — schema simplification + principled stances + extracted ADRs + SortOverlay validated

**Date:** 2026-05-20
**Trigger:** Three outside-agent review passes on round-14 (Gemini GREEN+5th-frame, Codex RED/conditional, fresh-Claude YELLOW + extensive blocker list). James ran a side thread to stress-test round-14 against alternatives and converged on a refined round-14 shape with several changes.

### Side-thread output

The side thread tested several reframe candidates against round-14:

- **A-loose** (shared `_entries/` container for cross-list item reuse) — rejected. Canonical-target PIN pattern handles reuse cleaner. List-context notes belong per-list, not on shared anchors.
- **Dissolving LIST attestation** (typed anchor IS the list) — rejected. LIST attestation gives stable identity separate from path placement, mirroring DATA.
- **Pure-TAG entries** (no entry anchor; weight on TAG; 1 attestation per entry) — rejected. Re-attesting weight produces a new TAG UID, orphaning per-entry metadata that referenced the prior TAG UID. Catastrophic for annotated lists.
- **TAG + listIndex PROPERTY** (move weight off TAG; kernel change to ADR-0041) — rejected. PROPERTYs cost 3 attestations each. Heavier than round-14, not lighter.
- **`coContributionPolicy` field** — rejected as **category error**. EFS does not have a write-gating concept. Editions ARE the access control; viewers choose what they read. Adding this field would imply a model EFS doesn't have.
- **Mandatory curator-write-gate resolver** — rejected for the same reason.
- **Free-floating folders** (Gemini's fourth-frame) — out of scope for v1.
- **One-enum schema field** (combine `allowsDuplicates`, `targetType` into one enum) — rejected. Discrete fields more self-documenting; enums need lookup tables.
- **Cross-list ITEM reuse via shared entry anchors** — rejected. Solved by canonical-target PIN at `/food/apple/` etc.
- **Ownership transfer mechanism** — accepted non-transferability. Old curator stays in editions chain forever.

### Schema field changes from round-14

- Dropped `uint8 entryIdentity` (3 enum values) — naming is a client convention, not a kernel concern. The kernel just enforces ADR-0025 anchor-name uniqueness.
- Dropped `uint8 targetKind` (5 effective values) → replaced with `uint8 targetType` (3 values: ANY / ADDR / SCHEMA). DATA collapsed into SCHEMA (use `targetSchema=DATA_SCHEMA_UID`). NONE-target handled by entries optionally omitting their inner PIN.
- Added `bool allowsDuplicates` — explicit replacement for what was inferred from `entryIdentity`.
- Added `bool sorted` — declares whether the curator maintains a SortOverlay-backed sorted index. **Default true in SDK helpers**, opt-out via `sorted: false` per James's call ("(a) but have a parameter to opt out of sorting").

### Other refinements from round-14

- **`revocable: true` → `revocable: false`** finally confirmed (was already in round-14; held under stress).
- **`title` → `name`** (align with ADR-0034 — round-14 had convention drift).
- **Optional resolver → mandatory `ListResolver`** for field-validation only. Validates `targetType ≤ 2`, (targetType, targetSchema) coherence, free-floating envelope.
- **Drop `MAX_LIST_PAGE_SIZE` cap and `PageSizeTooLarge` revert.** James's call ("Denial of service on who? The RPC providers? I doubt they'd care and would just cut your connection after a bit"). View reads are billed to the caller; memory expansion is quadratic-priced; RPC providers handle their own timeouts. Kernel paternalism dropped. SDK default `length = 100` as hint only.
- **Drop `validateAnchorNameMatchesPinTarget` reader** — naming is a client convention now; the validator was useful only with the `entryIdentity` enum.

### Cross-cutting extractions (separate ADRs)

Two findings from earlier rounds apply broader than lists. Pulled out:

- **PIN-trust-extension** — when a reader follows a PIN from attester A's anchor to attester B's target attestation, lens trust extends to B for that subtree. Applies to files, lists, properties — anywhere PIN-following crosses attester boundaries. Symlink-trust semantic. Deserves its own system-wide ADR.

- **Per-schema namespace + URL syntax** — anchors with different `schemaUID`s at the same parent + name coexist (kernel-level), but the file browser UX presents a unified-by-default view with cross-schema awareness. URL syntax disambiguates type. DNS precedent: `dig MX example.com` vs `dig A example.com`. Separate ADR governs the URL syntax (`/foo` vs `/foo[]` vs `/foo{}` vs `/foo<schemaUID>`).

Both are referenced from `custom-lists.md` but not duplicated.

### SortOverlay validation pass (background subagent)

Question: can `EFSSortOverlay` sort list entries by their TAG weight?

Findings:
1. **Source compatibility works.** `sourceType=1` filters children by schema; a LIST attestation's children with `ANCHOR_SCHEMA_UID` can be the sort source.
2. **`WeightSort` comparator needs custom path.** It can't read TAG.weight from an entry anchor UID directly; must look up the active TAG via EdgeResolver edgeHash index for `(curator, entryUID, listUID, ANCHOR_SCHEMA_UID)`, then read the TAG attestation, decode `weight`. ~2 EAS reads per comparison.
3. **Re-sort on weight change is NOT automatic.** Re-attesting a TAG with new weight updates EdgeResolver's in-place storage but does NOT trigger SortOverlay re-position. Caller must explicitly call `repositionItem(sortInfoUID, parentAnchor, entryUID, leftHint, rightHint)`. ~5.5k gas per call.
4. **Pagination via cursor.** `getSortedChunk` returns paginated sorted slices with `nextCursor` for following pages. O(1) per page.
5. **Verdict: feasible with manual repositioning.** SDK helpers handle `repositionItem` transparently for the curator on weight changes. No kernel changes needed for v1.

Result: round-15 commits to "sorted lists via SortOverlay" as opt-in default (`sorted: true`), with SDK auto-creating the SORT_INFO at LIST creation time and handling `repositionItem` on weight updates. Opt-out via `sorted: false` for small lists that don't need on-chain sorted reads.

### "Drill-into collections" mental model

A unifying frame for the spec rewrite. Lists, folders, and any future browse-into container types are siblings in the user's mental model. Kernel-level distinction is implementation detail. UX treats them as "things you click into to see what's inside." Surfaced this round; will land in `specs/06` rewrite.

### What round-15 changed concretely

| Item | Round-14 | Round-15 |
|---|---|---|
| Schema fields | `(uint8 entryIdentity, uint8 targetKind, bytes32 targetSchema)` | `(bool sorted, bool allowsDuplicates, uint8 targetType, bytes32 targetSchema)` |
| Resolver | "no resolver OR optional" | mandatory `ListResolver` (field validation only) |
| Page-size cap | `MAX_LIST_PAGE_SIZE = 100` + `PageSizeTooLarge()` revert | no kernel cap; SDK hint `length = 100` |
| `validateAnchorNameMatchesPinTarget` | shipped reader | dropped (naming is client convention) |
| Display-name PROPERTY | `title` (drift) | `name` (ADR-0034 alignment) |
| Co-contribution framing | "we keep it" + shaky defense | **principled: editions ARE the access control** |
| Sorting framing | "via SortOverlay or page reads" | `bool sorted` field (default true); SortOverlay opt-in/out |
| PIN-trust-extension | inline | extracted to separate ADR |
| URL/namespace | mentioned | extracted to separate ADR |
| Cross-list item reuse | unstated | explicit: canonical-target PIN pattern |
| Folder/list mental model | separate concepts | **"drill-into collections" — same UX-layer concept** |

### Open items remaining

- PIN-trust-extension ADR drafting (separate)
- URL/path-resolution ADR drafting (separate)
- `specs/06` rewrite (blocking before dev writes list data)
- Outside-agent review of round-15 (paste-ready prompt to be drafted)
- Implementation: LIST schema registration, ListResolver, WeightSort, EdgeResolver extensions, SDK helpers, frontend, conformance tests

### Pattern across rounds 11–15

Five frame-level refinements in fifteen rounds. Each was caught by James from outside the agent-convergence loop:
- Round 11: lists are folders (overshoot)
- Round 12: lists are NOT folders; membership is tags
- Round 13: free-floating LIST attestation, file-like portability
- Round 14: typed list anchors + revocable=false + freeform-no-PIN + placer/curator split
- Round 15: schema simplification + principled stances + extracted ADRs + drop kernel paternalism

The pattern: **agents converge inside a frame; humans question the frame.** Round-15's reframes came primarily from James-led side-thread stress-testing of round-14. A sixth frame-level refinement may still emerge; future agents reading this should expect a high bar but not assume the design space is exhausted.

### Doc length impact

Pre-round-15: 750 lines design + 1020 notes.
Post-round-15: ~932 lines design + ~1180 notes.

Growth driven by: three worked examples (Top 10 memes, grocery list, music playlist with repeats), WeightSort sketch, expanded decisions list, rejected-alternatives list with reasoning, frame-history recap.

---

## Round 16 — anchors-are-neutral + final schema + SortOverlay TAG-source committed

**Date:** 2026-05-20
**Trigger:** Three outside-agent review passes on round-15 (Codex RED, fresh-Claude RED, Gemini YELLOW/NO-GO) plus James-driven clarifications.

### Key reframings from external review + James's pushback

**1. Anchors are neutral.** The architect's "name-slot squatting attack" framing was wrong because it assumed anchor attesters were meaningful. James clarified: "Nobody owns anchors. Sure they have an attester but we NEVER use it. Anchors are neutral." This is load-bearing existing EFS behavior that hadn't been surfaced in docs. Round-16 makes it explicit. Squatting concerns collapse: first-creator gets nothing special; anyone can attach PINs/TAGs/PROPERTYs with their own attester; editions filter at the read layer.

**2. `_nameToAnchor` verified as single shared slot.** A focused code-read confirmed: `_nameToAnchor[parent][name][schemaUID] → bytes32` is a single slot, NOT per-attester. EFSIndexer reverts the second attestation at the same slot with `DuplicateFileName()`. Per-attester editions happen at the PIN/TAG layer below. This matches James's mental model (`/pizza/deepdish/file.txt` with James and Vitalik works via PIN-layer editions, not per-attester anchors). The earlier-considered kernel change to make `_nameToAnchor` per-attester is **NOT needed** — it would have been a major architectural shift away from shared schelling-point anchors. The current model is good.

**3. `sorted` field removed from schema.** Codex and the fresh Claude review both flagged it: `sorted` was overlay state masquerading as identity. With `revocable: false`, baking it into the schema created a migration trap. Reframe: **SORT_INFO existence is the on-chain signal.** SDK default at LIST creation attests a SORT_INFO; opt out via SDK parameter. Curators can attest a SORT_INFO later to upgrade an unsorted list. Per-curator (multiple curators can each have their own SORT_INFO for the same LIST UID).

**4. SortOverlay TAG-source kernel change committed for v1.** Codex and Gemini independently identified that SortOverlay walks `_children[L1]` (append-only) but list membership lives in `_activeByAAS[L1][curator][ANCHOR_SCHEMA]` (active TAG bucket). These diverge after revokes → sorted reads would show ghosts. Round-16 commits ~100-150 lines of Solidity: new `sourceType = 2` reading from EdgeResolver's active TAG bucket + an `onTagRevoked` hook from EdgeResolver to SortOverlay for auto-unlink. This is the only kernel change required for v1.

**5. Smart-contract NatSpec extended to `sortInfoUID`.** Same pattern as the curator warning: contracts MUST derive `sortInfoUID` from `EFSSortOverlay.getSortInfo(LIST_UID, canonical_curator)`, never accept it from caller input.

### Final round-16 schema (committed; permanent post-Sepolia)

```solidity
LIST schema:
  bool    allowsDuplicates   // false = set semantics (kernel enforces via name uniqueness with target-derived naming)
  uint8   targetType         // 0 = ANY, 1 = ADDR, 2 = SCHEMA
  bytes32 targetSchema       // EAS schema UID when targetType=SCHEMA; else bytes32(0)
revocable: false
resolver: ListResolver       // mandatory; field validation only
```

Three fields. Each is load-bearing per ADR-0041's "what earns a schema-encoded slot" test.

### Rejected in round-16

- **Per-attester `_nameToAnchor`** — verifier confirmed current shared-anchor model handles use cases; per-attester would be major architectural shift.
- **URL/namespace ADR** — deferred; current model works.
- **`sorted` as schema field** — moved to SORT_INFO existence.
- **`uint8 flags` / `uint8 version` reserved field** — schema UID IS the version mechanism; future variants ship as new schemas.

### Open items going into implementation

- LIST ADR drafting (`docs/adr/0044-list-and-list-entry-schemas.md`)
- PIN-trust-extension ADR drafting (`docs/adr/0044-pin-trust-extension.md`)
- `specs/06` rewrite (replacing stale content)
- EFSSortOverlay TAG-source mode + onTagRevoked hook implementation
- ListResolver + WeightSort implementation
- EdgeResolver view method extensions (no PageSizeTooLarge cap)
- SDK helpers
- Frontend renderer in packages/nextjs debug UI
- Conformance tests per round-16 §"Required pre-launch tests"

### Frame-history recap

Six frame-level refinements across sixteen rounds:
- Round 11: lists are folders (overshoot)
- Round 12: lists are NOT folders; membership is tags
- Round 13: free-floating LIST + file-like portability
- Round 14: typed list anchors + revocable=false + freeform-no-PIN + placer/curator
- Round 15: schema simplification + principled editions stance + drop kernel paternalism
- Round 16: anchors-are-neutral surfaced + schema finalized + SortOverlay TAG-source committed

Pattern: agents converge inside frames; humans question frames and surface load-bearing implicit invariants. Round-16's anchors-are-neutral wasn't a new design — it was making explicit something the system had been doing implicitly for years. The frame the architect picked up was wrong because they reasoned from "anchor attester = ownership" rather than "anchor attester = irrelevant artifact."

Round-16 should be terminal for the LIST design proper. The implementation may surface new questions but the schema and structural model are frozen.

> **2026-05-27 retrospective note:** the "Round 16 should be terminal" claim was wrong. Two more substantive rounds happened (R17, R18) when implementation drafting surfaced unenforced invariants the round-16 design assumed. The terminal-ness reasoning was internal-frame: round-16 was complete inside its frame, but the frame itself had a gap. See `docs/process/design-lessons.md` §"Internal synthesis can frame the problem to presuppose the answer." Preserving this claim unedited as a historical artifact of how the trap looks from inside.

---

## Round 17 — ADR-0045 constraint callbacks (rejected)

### Context

Round-16 framed `allowsDuplicates=false` and `targetType` enforcement as "expressed by ADR-0025 name-uniqueness when entries use target-derived naming" and "kernel-derived from ANCHOR resolver behavior." Implementation drafting (`docs/adr/0044-list-and-list-entry-schemas.md` first pass) surfaced that this only worked for specific naming schemes — occurrence-derived naming (used for `allowsDuplicates=true` lists with same-target repeats) bypassed it.

The internal subagents proposed a generalized solution: **`IEFSConstraintCallback`** — a kernel-level extension mechanism where schema resolvers could register cross-attestation invariant predicates that fire at attest time, scoped to specific (definition, target, attester) tuples. The intent was to make LIST-specific constraints (and any future cross-attestation invariants) declarable without polluting EdgeResolver.

Three parallel internal subagents synthesized the mechanism. The framing prompts all assumed "the mechanism is needed; design it well."

### What happened

ADR-0045 was drafted and submitted for external review (Codex GPT-5, Gemini 2.5 Pro, fresh Claude). **All three returned RED on the same convergent finding:** the mechanism solves a non-problem in v1.

- `allowsDuplicates=false` was already conditionally kernel-enforced via ADR-0025 name uniqueness + target-derived naming. The "occurrence-derived edge case" was a use case for `allowsDuplicates=true` lists, where dup prevention wasn't required.
- The "forward use cases" (bounded-N TAG, append-only TAG, PROPERTY value-type, etc.) were speculative — none had concrete v1 requirements.
- The mechanism was a permanent Etched commitment (constraint registry baked into resolver storage at deploy time) for hypothetical future flexibility, on a surface where any wrong commitment is irreversible at mainnet.

ADR-0045 was deferred (not accepted). Status set to "Proposed — deferred per round-17 external review."

### Lesson captured

`docs/process/design-lessons.md` records the meta-pattern: when drafting a permanent Etched commitment, the FIRST internal pass must be the **inverted-framing pass** — explicitly asking "is this mechanism needed?" not "design this mechanism." Only after that returns "yes, here are the gaps" should follow-on passes design the mechanism. The cost of skipping this step in round 17 was ~1 week of design work that didn't ship.

ADR-0045 stays as a documented deferral so future agents see why generic extension mechanisms were considered and rejected — and don't re-propose them without facing the same review.

---

## Round 18 — Requirements crystallization + 5-agent convergence (current design)

### What triggered round 18

After ADR-0045's deferral, the design returned to round-16's structure with the unenforced-invariant gap still open. James pushed back on the agent's framing of round-16 as "good enough":

> "You make this sound good but it looks like 'logic / ordering / uniqueness' enforced onchain isn't in this design? So smart contracts need to do a ton of work (which gas prevents them from doing well) to ensure EFS lists actually meet their needs? What else is alarming? Are we actually in a good spot?"

This was the inflection. The agent had been describing round-16 as enforcing what it actually only partially enforced (ADR-0035-shape mistake — `design-lessons.md` flagged this exact pattern). James's pushback was the human-in-the-loop catching framing drift.

### Phase 1 — requirements crystallization

Rather than design another mechanism, the round 18 process started by **locking the requirements explicitly with the human**:

- MUST: ordered, unordered, no-dupes (write-time enforced), dupes-allowed, typed (write-time), untyped, address-typed, append-only (list-level, write-time), per-attester editions, smart-contract O(N) typed iteration, O(1) membership for ALL modes.
- NICE: per-entry metadata, deprecation flags, intrinsic items, reorderable, capped.
- DEFERRED: generic constraint-callback (ADR-0045), cross-attester merged view, on-chain reverse-lookup, mainnet 50-year freeze.
- Validation: write-time, by resolver. `address(0)` valid.

Key James-clarifications during crystallization:
- "Just enforce what we declare. We say a list behaves a certain way, devs should trust that. We write once and downstream doesn't verify."
- "Append-only might be MUST — software versioning needs entries to stick around forever; dependents need to rely on them not disappearing."
- "Reverse lookup is NICE but actually important — DAO/Lens checks need near-constant time membership."
- "I hate bitfields. Just do bools and discrete values. Programmers will thank us in the future."

These clarifications drove field-set choices in the final design.

### Phase 2 — 5-agent parallel convergence round

5 agents dispatched in parallel, each with a distinct starting frame:

1. **Defend round-16** — start from entry-anchor pattern, propose minimal patches
2. **LIST + LIST_ENTRY clean** — start from prior LIST_ENTRY sketch, refine
3. **Greenfield** — ignore prior list designs entirely, propose from substrate
4. **Smart-contract-reader-first** — design backwards from consumer API
5. **Hybrid** — combine round-16 entry-anchor structure with LIST_ENTRY enforcement

Each produced a complete design (1500-2500 words) with explicit MUST coverage, ugly-bits list, and verdict.

### Convergence result

**4 of 5 independently converged on LIST + LIST_ENTRY with dedicated resolver:**

- Agent 2 (clean): HIGH confidence, mainnet-worthy with caveats
- Agent 3 (greenfield): HIGH confidence — "natural conclusion of three observations: schema UID is for on-wire shape only, resolvers are the mechanism for cross-attestation invariants, anchors are neutral"
- Agent 4 (reader-first): MEDIUM-HIGH — consumer API requirements drove same architecture
- Agent 5 (hybrid): MEDIUM — recommends dropping the entry-anchor escape hatch, collapsing the hybrid to Agent 2's design

Agent 1 (round-16 defender) admitted MEDIUM confidence and recommended a head-to-head bake-off before mainnet. Specifically flagged the cross-resolver coordination required for write-time enforcement as "exactly the ADR-0045 surface the team explicitly deferred."

### Key resolution: ADR-0041 reconciliation

The convergence required reconciling LIST's per-attestation cardinality/type switches with ADR-0041's "cardinality lives in schema UID." Two agents independently arrived at the same argument:

> LIST_ENTRY is not an edge predicate. It is the materialization of ONE specific list's membership. The predicate "is X in LIST L?" has cardinality fixed at LIST creation by `allowsDuplicates` — immutable because LIST is non-revocable. The coordination point is permanent, machine-readable, and coordinated, just one level of indirection deeper than ADR-0041's edge case.

ADR-0041 does NOT require supersession — the LIST attestation IS the predicate coordination layer for that specific list. A sibling ADR documents this reconciliation.

### Per-entry metadata clarification (James question)

During convergence review, James asked the sharp question: **"Per entry is a property on... what? The data itself? Or the list item?"**

This clarified three metadata scopes that the round-18 design preserves cleanly:

| Scope | UID | Example |
|---|---|---|
| Intrinsic to content | DATA UID | Film's release year |
| Per-entry in this list | LIST_ENTRY UID | Alice's rating in her top-10 |
| Per-list | LIST UID | List name, description |

LIST_ENTRY as a single attestation gives one unambiguous UID per entry. Round-16's 3-attestation entry pattern (anchor + PIN + TAG) made the "which UID is the entry?" question ambiguous — the convergence-round agents independently flagged this as an argument FOR the single-attestation design.

### Adversarial review findings (pre-convergence Solidity pass)

An earlier round of Solidity-adversary review against the LIST_ENTRY sketch identified BLOCKING bugs:

- `onRevoke` must gate cleanup behind `if (_entryPosPlusOne[uid] != 0)` to avoid state corruption (mirrors EdgeResolver line 290)
- `ListResolver` must enforce `targetType <= 2` and field-coherence
- Events required for subgraph indexing
- Reentrancy assumption (`eas.getAttestation` is pure storage read) must be documented

All four are addressed in the round-18 design.

### Open concerns going into external review

The round-18 design explicitly invites external review attack on:

1. ADR-0041 reconciliation — is it real reasoning or rationalization?
2. Schema count (7 → 9) — could fewer schemas have worked?
3. `address(0)` encoding for ADDR-typed lists (sentinel-bit options under consideration)
4. `isMember` semantics for duplicates-allowed lists
5. 50-year reader test on field semantics
6. State growth for append-only uncapped lists
7. The frame question — what haven't we asked?

### Open items going into implementation (post external review)

- LIST ADR drafting (replaces deferred ADR-0045 numbering; ADR-0045 stays as a documented deferral)
- Sibling ADR documenting ADR-0041 reconciliation
- `specs/06` rewrite (replacing stale round-16 content)
- ListResolver + ListEntryResolver implementation
- ListReader view contract
- SortOverlay integration for ORDERED lists (already designed in round-16; carries forward)
- SDK helpers
- Frontend renderer in packages/nextjs debug UI

### Frame-history recap (updated)

Seven frame-level refinements across eighteen rounds:

- R11: lists are folders (overshoot)
- R12: lists are NOT folders; membership is tags
- R13: free-floating LIST + file-like portability
- R14: typed list anchors + revocable=false + freeform-no-PIN + placer/curator
- R15: schema simplification + principled editions stance + drop kernel paternalism
- R16: anchors-are-neutral surfaced + schema finalized + SortOverlay TAG-source committed
- R17: IEFSConstraintCallback / ADR-0045 → rejected by external reviewers (wrong abstraction)
- R18 (current): LIST + LIST_ENTRY with dedicated resolver — convergence via 5-agent parallel design proposals; write-time enforcement of all declared options; per-entry metadata via standard PROPERTY pattern on LIST_ENTRY UID

Pattern across all seven: agents converge inside frames; humans question frames; reviewers (internal or external) find what was implicit. R18's convergence is the first where 4-of-5 independently-framed agents arrived at the same architecture — strong signal, but internal-only. External review on R18 has NOT yet happened; the convergence is conditional on external validation.

---

## Round 18b — Post-external-review revision

### What triggered round 18b

Three external reviewers (Claude, Codex GPT-5, Gemini 2.5 Pro) returned the round-18 doc with NOT-READY verdicts and concrete findings. Synthesis with James produced two-line directives: "Do what you need to do. Subagent review. Doc cleanup. Fixes. Iterate."

### Internal validation passes before doc revisions

Two parallel subagent passes:

1. **S1 inverted-framing pass**: Tried to satisfy every locked MUST using only existing schemas (PIN, TAG, ANCHOR, PROPERTY) with at most a new resolver and view contract. **Verdict: RED.** Four MUSTs fail without new schemas — typed write-time enforcement, append-only write-time enforcement, per-attester editions (ADR-0025 anchor names are GLOBALLY unique per parent, surprising failure), and on-iteration type confidence. The new schemas are load-bearing.

2. **Adversarial review of Codex's member-key reframe**: Found 9 potential new bugs. Most-dangerous: collapsing three encodings into one polymorphic `bytes32 target` field. Recommended ADOPT WITH MITIGATION: typed view accessors, key-derivation convention, indexed event field, optional existence check.

### What changed in round 18b

**Adopted Codex's member-key reframe** for `targetType=ANY`:
- ANY = opaque bytes32 member key, no EAS existence check
- `allowIntrinsic` field REMOVED — intrinsic items use ANY mode with key derivation `keccak256(abi.encode("efs-list-intrinsic", payload))`

**Adopted refined Option D for `address(0)` encoding** (use EAS's native `recipient` field):
- ADDR-typed entries: target=`bytes32(0)`, recipient=addr (address(0) fully supported)
- SCHEMA-typed: target=UID, recipient=`address(0)`
- ANY-typed: target=opaque key, recipient=`address(0)`
- No sentinel bits, no polymorphic single field — structural separation via different EAS native fields per mode

**Dropped `isMember` from ListReader** — `countOf` only; consumers explicitly compare to 0.

**Added typed accessors** to ListReader: `targetAsAddress`, `targetAsUID`, `targetAsMemberKey` that revert on mode mismatch.

**Lifecycle invariants enforced by resolver** (BLOCKING B3):
- LIST_ENTRY: per-attestation `revocable=true`, `expirationTime=0`, `refUID=0`
- LIST: per-attestation `revocable=false`, `expirationTime=0`, `refUID=0`, `recipient=0`

**`appendOnly + allowsDuplicates + uncapped` combination rejected** at ListResolver: `maxEntries` must be >0 in that combo (closes unbounded-growth gap).

**`getMode` decodes LIST directly via EAS** (not from resolver cache) — works for empty lists (BLOCKING B3-derived).

**Allowlist consumer pattern rewritten** — curator from `LIST.attester` or hardcoded trusted address, NOT caller-supplied (BLOCKING B4).

**CREATE2 deploy invariant** documented as launch-prerequisite — resolver address must be deterministic across Sepolia/mainnet so LIST_ENTRY schema UID is stable.

**Events frozen** with `targetType` denormalized into entry events for subgraph efficiency.

**ADR-0041 reconciliation reframed honestly** as deliberate deviation at the predicate-coordination layer (not "no supersession needed"). Sibling LIST ADR must document this in Consequences.

**Worked example added** showing one entry's full lifecycle through resolver state — surfaces invariants the design relies on and lets reviewers verify state transitions concretely.

### Final internal adversarial pass on round-18b

Surfaced two BLOCKING issues introduced by the revisions, both fixed before commit:
- C1: `onRevoke` idempotency check was unreachable (early-return after revert). Reordered.
- C5: Revoked-target policy for SCHEMA mode was undocumented. Documented as "entries immune to target lifecycle" matching editions principle.

Plus SHOULD-FIX items: identityKey derivation helpers on ListReader, forward-compat note for `targetType` additions.

### What's still open in round 18b

- External review of the revised design (this is the deliverable)
- Specifically: does EAS-native-recipient encoding hold up? Does the member-key reframe with key-derivation convention sufficiently coordinate clients? Are lifecycle invariants complete?
- The frame question remains open (Claude W1 "kernel enforces nothing; advisory", Gemini WA "lists as files" still candidate next-frames)

### Frame-history recap (updated)

Seven frame-level refinements + one post-external-review hardening:

- R11: lists are folders (overshoot)
- R12: lists are NOT folders; membership is tags
- R13: free-floating LIST + file-like portability
- R14: typed list anchors + revocable=false + freeform-no-PIN + placer/curator
- R15: schema simplification + principled editions stance + drop kernel paternalism
- R16: anchors-are-neutral surfaced + schema finalized + SortOverlay TAG-source committed
- R17: IEFSConstraintCallback / ADR-0045 → rejected by external reviewers
- R18: LIST + LIST_ENTRY with dedicated resolver — convergence via 5-agent parallel proposals
- R18b: post-external-review hardening — Codex member-key reframe + EAS-recipient encoding for ADDR + lifecycle invariants + ADR-0041 honest reframe + worked example + CREATE2 invariant

Pattern: agents converge inside frames; humans question frames; external reviewers find what internal convergence missed. Round-18 added a new dynamic: three independent external reviewers in parallel produced overlapping critical findings, validating the design-lessons.md prediction that internal convergence is a stability signal, not a correctness signal. Round-18b is the integration of that feedback.

---

## Round 18c — Second external review punch list

### What triggered round 18c

All three round-18b external reviewers (Codex, Gemini, Claude) returned **READY-WITH-SHOULD-FIX, zero blockers**. The architecture is validated — no reviewer requested an architectural change. Round 18c applies the SHOULD-FIX punch list.

### The one decision that gated the schema freeze

**Storage layout: wide vs lean.** Claude SF1 + Gemini A circled the same point from opposite ends — the `_entries` array stored bare entry UIDs, but the reader and DAO example read weight/recipient directly, which would require N+1 `eas.getAttestation` per entry. Since storage layout determines resolver bytecode → CREATE2 address → schema UID, this had to be decided before freeze.

James's call (2026-05-28): **go wide.** Store `EntryRecord { entryUID, identityKey, weight }` inline. Rationale: fail-safe direction (over-provision = wasted write gas, tolerable; under-provision = block-gas-limit wall for on-chain iterators, functional break), and consistent with ADR-0041's deliberate `TagEntry[]` widening for the same reason. "Optimize later" is valid only until mainnet freeze — past that, layout is etched into the schema UID.

The wide layout also subsumed Gemini A's optimization: storing identityKey inline in the record eliminated the separate `_entryIdentityKey` side map (revoke reads it from the array element directly).

### Punch-list items applied

Security:
- Typed accessors (`targetAsAddress/UID/MemberKey`) now verify BOTH mode match AND that entryUID belongs to listUID (Codex #4 + Gemini B — cross-list injection)
- `getMode` must check `L.schema == LIST_SCHEMA_UID` before decoding data (Claude SF2)

Example bugs:
- DAO distribution: sum only positive eligible weights for the denominator (Codex #5); bound iteration to a sane maxEntries (Codex #6)

Doc hardening:
- Stale "intrinsic-allowed" removed from TL;DR (Codex #1)
- ADDR-via-recipient: documented that generic EAS indexers read these as "received by address" (Codex #2)
- maxEntries reframed as contract-safety bound, not future-proofing (Codex #8)
- Metadata-orphaning on weight-rewrite vs SortOverlay stable-UID (Gemini C)
- Pagination not snapshot-isolated note (Claude SF3)
- SCHEMA-mode revoked-target consumer guidance louder (Claude SF4)
- isPayable / offchain-revocation lifecycle notes (Claude SF5)
- ANY no-dupes dedups on derived key not human meaning; canonical normalization in SDK guide (Claude SF6 + Codex #7)
- Events: index (listUID, attester, identityKey) instead of entryUID — enables raw-RPC reverse lookup by member (Codex #3)

### Status going into next external pass

Round 18c is a hardening pass on a validated architecture. The expectation is this is the last substantive design iteration before ADR drafting — but one more external confirmation pass is warranted since the wide-storage change and typed-accessor cross-list checks are new surface.

---

## Round 18d — Confirmation review outcome

Third external pass (confirmation gate, commit 1bdb34d). Result: **schema field strings GO from all three** (Claude, Codex, Gemini). Architecture and schema are freeze-ready.

Codex returned NO-GO on the *ListReader typed-accessor ABI handoff* (not the schema) — a real catch: the cross-list check I added in 18c proved only that an entry *claims* the trusted listUID, not that it's in the *trusted curator's edition*. Because editions are permissionless, Mallory can attest her own LIST_ENTRY against a trusted listUID with recipient=Mallory; a victim calling `targetAsAddress(L, entryUID)` would get Mallory's address. Claude had flagged the same thing as a "non-blocking nit" (secure consumers use countOf); Codex correctly weighted it as blocking because the accessor is *documented* as a membership check and is a footgun otherwise.

Round 18d fixes (all on Durable/redeployable surfaces, none schema-gating):
- Typed accessors now take `(listUID, curator, entryUID)` and check: LIST_ENTRY schema, `attester == curator`, `revocationTime == 0`, `entryListUID == listUID`, mode match. Safe-by-construction.
- Event emit arg order corrected to match the indexed declaration `(listUID, attester, identityKey, entryUID, targetType, …)` — 18c updated the declaration but not the emits.
- State-growth "natural bound" overclaim deleted (Codex): no-dupes bounds duplicates per key, not total entries; only `maxEntries` bounds totals.
- Swap-and-pop simplified to direct copy (Gemini nit).
- Worked example: added `address(0)` / `identityKey == bytes32(0)` conformance-test vector (Claude nit).

All three reviewers' own prior findings confirmed resolved in-text. Net: schema is frozen; the design phase is closed; remaining work is ADR + implementation. The accessor ABI lives on the stateless ListReader (redeployable), so its late hardening doesn't affect the Etched schema freeze.

---

## How to use this file

Append-friendly. When adding:

- **Process / history items**: prepend date if it matters; reference the commit or thread that motivated the decision.
- **Speculation**: tag with "deferred" / "future" / "premature" so future agents know to push back if revisiting prematurely.
- **Verification notes**: prefix with "VERIFY:" for things that need real-world checking at implementation time.

When removing: only do so if a parked idea has been promoted to the main doc, an ADR, or rejected with finality. Otherwise leave the trail.
