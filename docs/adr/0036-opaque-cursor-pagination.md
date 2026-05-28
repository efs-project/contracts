# ADR-0036: Opaque-cursor pagination for multi-source views

**Status:** Accepted
**Date:** 2026-04-19
**Related:** ADR-0006, ADR-0009, ADR-0026, ADR-0030

## Context

Several `EFSFileView` read functions combine **more than one underlying source** into a single result page — notably, schema-filtered directory listings merge "qualifying tagged folders" (from `EdgeResolver._childrenWithEdge`) with "content children" (from `EFSIndexer._childrenBySchema`), and multi-attester file listings merge per-attester active-PIN targets with cross-attester dedup. Today these functions expose a single `(uint256 startingCursor, uint256 pageSize)` input and return at most one `nextCursor`:

- `getDirectoryPageBySchemaAndAddressList(parent, schema, attesters, startingCursor, pageSize) → (items, nextCursor)`
  - Materializes the entire qualifying-folder set up-front via `_getQualifyingTaggedFolders`, capped at `MAX_TAGGED_FOLDERS = 10000`. Folders past the cap are silently dropped. Folders appear only on page 1 (hard-coded `startingCursor == 0` branch); if a page-1 response is larger than the UI's render budget, the caller cannot resume from the middle of the folder set.
  - The returned `nextCursor` only tracks `_childrenBySchema` progress. There is no cursor over the folder set.
- `getFilesAtPath(anchor, attesters, schema, start, length) → items`
  - Allocates a `length * attesters.length` scratch buffer. Caller passes the same `(start, length)` to every attester's `_activeByAAS` slice; entries past each slice are dropped. Dedup is O(n²) over the scratch buffer. No `nextCursor` is returned, so callers cannot tell whether the result is complete.

Two classes of bug fall out of this shape:

1. **Silent truncation.** `MAX_TAGGED_FOLDERS = 10000`, `MAX_ATTESTERS_PER_QUERY = 20`, `length * attesters.length` buffer — each is a hard cap hidden behind a nominally paginated API. Past the cap, results vanish without any external signal. ADR-0030 makes these caps permanent on mainnet: once deployed, the landmine cannot be patched.
2. **Leaky caller contract.** A caller reading "give me the next page" cannot express "I want 20 items from the whole source, whatever phase we're in." They have to understand the phased internals — "folders on page 1 only, then files" — and either guess page size or re-fetch on cap misses. The API leaks the implementation.

Fixing the caps in place is not enough. Raising a cap just pushes the failure mode further out; any fixed ceiling over an append-only index (ADR-0009) eventually breaks on a long enough time horizon. What's needed is an API whose correctness does not depend on any caller-visible size bound.

Industry convention for this shape is **opaque-cursor pagination** — Google AIP-158 (`page_token` / `next_page_token`), Stripe (`starting_after`), Relay GraphQL connection spec (base64 `cursor` + `hasNextPage`), Postgres keyset walkers. The caller passes a token they don't introspect, the server advances its internal walkers by whatever it needs, and returns a new token (or empty) to signal continuation.

## Decision

Adopt opaque-cursor pagination for `EFSFileView` functions that merge multiple sources or require dedup across sources. Phase 1 scope: the two functions above. Other `EFSFileView` reads (`getDirectoryPage`, `getDirectoryPageByAddressList`, `getDataMirrors`, `getReferencingAttestations` slice views) already walk a single append-only source via keyset pagination and stay on the existing `(start, length) → results` shape.

### API shape

```solidity
struct DirectoryPage {
    FileSystemItem[] items;
    bytes nextCursor;   // empty iff source is fully walked
}

function getDirectoryPageBySchemaAndAddressList(
    bytes32 parentAnchor,
    bytes32 anchorSchema,
    address[] memory attesters,
    bytes memory cursor,      // empty = start from beginning
    uint256 maxItems
) external view returns (DirectoryPage memory);

function getFilesAtPath(
    bytes32 anchorUID,
    address[] calldata attesters,
    bytes32 schema,
    bytes memory cursor,
    uint256 maxItems
) external view returns (DirectoryPage memory);
```

The cursor bytes are **opaque to callers**. Internally they encode a phase tag plus one or more walker indices; the encoding may evolve across deploys without changing the caller contract.

### Caller contract

- `cursor == ""` ⇒ start from the beginning.
- Server fills up to `maxItems` items by advancing through whatever internal sources it tracks; each inspected index (including filtered-out entries) advances the internal walker.
- Returned `nextCursor.length == 0` ⇒ sources are fully exhausted; no more pages.
- Returned `nextCursor.length > 0` ⇒ more items may be available; pass the token back verbatim to continue.
- `maxItems` bounds **result size**, not work: filtered-out entries still consume gas. Callers should pick `maxItems` to balance responsiveness against tail-latency on heavily-filtered slices.

### Cursor encoding (internal, non-normative)

For `getDirectoryPageBySchemaAndAddressList`:

```solidity
abi.encode(uint8 phase, uint256 folderIdx, uint256 fileIdx)
// phase 0 = walking _childrenTaggedWith (folders)
// phase 1 = walking _childrenBySchema (files)
```

For `getFilesAtPath`:

```solidity
abi.encode(uint256 attesterIdx, uint256 targetIdx)
// attesterIdx: next attester in the caller-supplied list
// targetIdx:   next position in _activeBySlot[anchorUID][attesters[attesterIdx]][schema] (PIN; cardinality 1 per ADR-0041)
```

Both schemes are deploy-mutable: since `EFSFileView` is stateless (and marked redeployable in `specs/overview.md`), a new cursor format can ship with a new `EFSFileView` address. Clients round-trip tokens within a deploy; they don't persist them across deploys. Documented as part of the API contract.

### Dedup semantics

Multi-attester views (the "lenses" model, ADR-0031) must return each target at most once. File placement is Shape A (PIN only — cardinality 1 per `(attester, definition, targetSchema)` slot, ADR-0041). Dedup is expressed as: when processing attester `a`'s active PIN target `t`, skip `t` if any earlier attester `b` already has an active PIN on `(t, definition)`. Checked via `EdgeResolver.isActivePinEdge(b, t, definition)`, which is O(1) per check. Total dedup cost is O(attesters × page_size), replacing the prior O(n²) scratch-buffer scan.

### No result cap

Neither function retains a `MAX_TAGGED_FOLDERS`, `length × attesters` allocation, or any implicit ceiling on total source size. The walker processes whatever `_childrenTaggedWith` / `_childrenBySchema` / `_activeBySlot` (PIN placement storage) contain; growth is bounded only by the underlying indices, which are themselves bounded by actual on-chain attestations.

## Consequences

- **Silent truncation is structurally eliminated.** There is no cap past which entries vanish; the only way to "miss" an entry is if the caller stops paging early, which is explicit.
- **API remains stable as internals evolve.** New sources can be added to a merged page (e.g. a future "pinned folders" phase) by bumping the encoded phase tag. Existing clients continue to send the old cursor shape until the next deploy; no caller-facing breaking change.
- **ADR-0030 compatibility.** Because the caller never inspects the cursor, there is no mainnet-permanent encoding commitment. The `DirectoryPage` struct and the opaque-bytes contract are the frozen surface.
- **Concurrent-mutation semantics are "best-effort."** For phase 0 and the `getFilesAtPath` walker, the underlying indices are stable append-only structures — indices don't shift. For the `_activeBySlot` PIN storage used in `getFilesAtPath`, a revocation between calls clears that slot; the next resumed page safely skips to the next attester's slot. Documented as a best-effort pagination guarantee under concurrent mutation, in line with every non-snapshotting paginator in the industry. Not fixable without a snapshot index.
- **Work-per-call is bounded by `maxItems` + filter skip.** Callers pick `maxItems`; internal walkers advance indices even for filtered-out entries, so heavily-filtered pages cost proportionally more per item returned. Mitigated by picking `maxItems` conservatively (e.g. 20–50 for UI use); unbounded walks are the caller's choice.
- **Dedup cost drops from O(n²) to O(n · attesters).** Via `isActivePinEdge` O(1) lookups (ADR-0041).
- **Client complexity is unchanged or lower.** Clients that previously tracked `(start, pageSize)` manually now round-trip an opaque `bytes` value. No phase reasoning; no "folders only on page 1" special case.
- **`MAX_ATTESTERS_PER_QUERY = 20` is retained** as a hard bound on per-call gas. This is a bound on the caller's attester list length, not on returned items, so it does not cause silent truncation of results — it's a precondition the caller asserts.
- **Tests and simulation scripts must update signatures.** Internal — no mainnet impact.

## Alternatives considered

- **Raise the caps (e.g. `MAX_TAGGED_FOLDERS = 100_000`).** Rejected — pushes the failure mode out, doesn't remove it. On a long enough time horizon any fixed cap breaks, and ADR-0030 makes the choice permanent.
- **Return `(items, uint256 nextStart, bool truncated)`.** Rejected — `truncated` is a lossy signal (it tells you there's more, but not where). Callers still can't resume from mid-folder on page 1. The opaque-cursor approach subsumes this.
- **Split into separate single-source functions and have clients merge.** Rejected — pushes dedup and ordering responsibility to clients (including the `web3://` router), and makes the sidebar/browser UI fetch 2–3× the calls. The merged view is the natural unit; the bug was how pagination was expressed, not that merging exists.
- **Numeric compound cursor (`uint256 packed`).** Rejected — commits to a fixed bit layout on mainnet. Bytes are strictly more flexible at negligible cost (abi encoding overhead is dwarfed by the rest of the call).

---

*Prose-accuracy corrections 2026-04-22 (within 30-day grace window): (1) Context updated from `TagResolver._childrenTaggedWith` / `_activeByAAS` to `EdgeResolver._childrenWithEdge` / per-attester PIN targets — contract renamed and schema split per ADR-0041. (2) Dedup semantics section rewritten: dedup is now `isActivePinEdge` (PIN-specific, O(1)) not `TagResolver.getActiveTagUID` — file placement is PIN (Shape A); TAG is irrelevant to the dedup check. (3) Concurrent-mutation consequences bullet updated to `_activeBySlot` (PIN storage). (4) `getFilesAtPath` cursor pseudocode comment: `_activeByAAS` → `_activeBySlot` (PIN is cardinality 1 per ADR-0041). (5) "No result cap" section: `_activeByAAS` → `_activeBySlot` (PIN placement storage). The core decision — opaque cursor over multi-source views — is unchanged.*
