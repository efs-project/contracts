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
- `getEntryListPage(listAnchor, attester, start, length) → (entryUID, innerTargetID, innerSchema, weight)[]` — bundles entry resolution: TAG → entry anchor → entry's `schemaUID` → `getActivePinTarget` in one call. Wraps the wrapped-mode read.
- `validateTargetDerivedEntry(entryAnchor, attester) → bool` — schema-aware name-target consistency check for `entryIdentity = "target"` entries. Returns true if the entry's name matches the canonical hex of its resolved PIN target.

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

## How to use this file

Append-friendly. When adding:

- **Process / history items**: prepend date if it matters; reference the commit or thread that motivated the decision.
- **Speculation**: tag with "deferred" / "future" / "premature" so future agents know to push back if revisiting prematurely.
- **Verification notes**: prefix with "VERIFY:" for things that need real-world checking at implementation time.

When removing: only do so if a parked idea has been promoted to the main doc, an ADR, or rejected with finality. Otherwise leave the trail.
