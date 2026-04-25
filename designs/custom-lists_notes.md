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
