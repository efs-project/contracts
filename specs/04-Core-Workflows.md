# Core Workflows

This document maps the step-by-step execution for specific developer and user interactions within the EFS, relying on the [Onchain Indexing Strategy](./03-Onchain-Indexing-Strategy.md) and [Data Models and Schemas](./02-Data-Models-and-Schemas.md). Because EFS is subjective and permissionless, any data can be written, but the read state depends on the querier's perspective (Edition or Web of Trust).

### 1. Upload a file to `/memes/cat.jpg` (on-chain)
- **Action**: Atomic upload via EAS `multiAttest` — all attestations in a single transaction.
- **Step 1**: Read file bytes → compute `keccak256(bytes)` for `contentHash`, measure `size`.
- **Step 2**: Check `dataByContentKey[contentHash]` — if DATA exists, reuse it (dedup).
- **Step 3**: Walk the ancestor chain from `/memes/` up to root exclusive (ADR-0006 revised 2026-04-18). For each generic folder the attester hasn't already covered with an active `applies=true` `TAG(definition=DATA_SCHEMA_UID, refUID=folder)`, queue a visibility TAG for that folder. The walk short-circuits the first time an existing active TAG is found — steady-state cost is zero. Bounded by `MAX_ANCHOR_DEPTH = 32` (ADR-0021).
- **Step 4**: Build `multiAttest` batch:
  1. `DATA(contentHash, size)` — standalone, non-revocable, `refUID = 0x0`
  2. `PROPERTY(key="contentType", value="image/jpeg")` — `refUID = DATA UID`
  3. `MIRROR(transportDef=/transports/onchain, uri=web3://0xABC)` — `refUID = DATA UID`
  4. `TAG(definition=cat.jpg Anchor, applies=true)` — `refUID = DATA UID` (places DATA at path)
  5. One visibility TAG per queued ancestor from Step 3: `TAG(definition=DATA_SCHEMA_UID, refUID=ancestorFolder, applies=true)`. Makes the folder appear in the attester's edition listing.
- **Result**: TagResolver indexes the placement TAG in `_activeByAAS[catAnchor][alice][DATA_SCHEMA]` and each visibility TAG in `_childrenTaggedWith[ancestor][DATA_SCHEMA_UID]`. `EFSFileView.getDirectoryPageBySchemaAndAddressList` paginates those visibility TAGs via opaque cursor (ADR-0036) and filters single-source — untagged folders, even ones containing the attester's files, do not appear in that attester's edition (tag-only model).

### 2. Paste an IPFS link to `/docs/paper.pdf`
- **Action**: Same as upload but MIRROR uses a different transport.
- **Step 1**: Client fetches `ipfs://QmXxx` via gateway to compute `keccak256(bytes)` for `contentHash`. For large files, user provides hash manually (attester's claim, client can verify on display).
- **Step 2**: Build `multiAttest` batch:
  1. `DATA(contentHash, size)`
  2. `PROPERTY(key="contentType", value="application/pdf")`
  3. `MIRROR(transportDef=/transports/ipfs, uri=ipfs://QmXxx)`
  4. `TAG(definition=paper.pdf Anchor, applies=true)`
- **Result**: File appears in `/docs/` with IPFS retrieval. Client resolves via gateway URL.

### 3. Add a mirror to an existing file
- **Action**: Attach an additional retrieval method to an existing DATA.
- **Execution**: Single `MIRROR(refUID=existing DATA UID, transportDef=/transports/arweave, uri=ar://yyy)` attestation.
- **Result**: File now has multiple transport options. Client picks best available per transport preference (web3 > ar > ipfs > magnet > https; see ADR-0012).

### 4. Cross-reference the same file at another path
- **Action**: Place an existing DATA at a second path (e.g., same cat.jpg at `/animals/cat.jpg`).
- **Execution**: Single `TAG(definition=animals/cat.jpg Anchor, applies=true, refUID=same DATA UID)`.
- **Result**: DATA, PROPERTYs, and MIRRORs are shared. Only one new TAG. Metadata on the canonical DATA is visible from both paths.

### 4a. Browse an address home (`/vitalik.eth/memes/`)
- **Action**: Resolve the top-level URL segment as an Ethereum address and walk anchors parented at that address (ADR-0033).
- **Step 1**: Off-chain, the UI resolves `vitalik.eth` via `publicClient.getEnsAddress` → checksummed address `0xd8dA…6045`. The on-chain router accepts raw 40-char hex only; ENS stays in the client per ADR-0030.
- **Step 2**: Classify the segment (address → schema → attestation → anchor precedence). An address turns into `seedUID = bytes32(uint160(addr))`.
- **Step 3**: Walk `resolvePath(seedUID, "memes")` → `resolvePath(<that>, "cat.jpg")` using the existing anchor-walk loop. `_nameToAnchor[parentUID][name][schema]` already indexes anchors parented at an address (via `EFSIndexer.onAttest`'s `refUID=0 && recipient!=0` fallback).
- **Step 4**: If no `?editions=` was given, the router defaults editions to `[caller, vitalikAddr]` — the connected wallet wins, vitalik's edition fills the gaps. Explicit `?editions=` overrides wholesale (ADR-0031).
- **Result**: A file under vitalik's home resolves exactly like any anchor path, scoped to his editions. The UI renders a `ContainerInfoPanel` showing the ENS name, a "You" chip when connected matches, and an Etherscan link.

### 5. Navigate to `/memes/` and list files
- **Action**: Query TagResolver for DATAs and sub-folders at an Anchor, filtered by attester.
- **Execution**: call EFSFileView — it iterates child anchors, merges editions, and paginates.
  ```
  items = efsFileView.getDirectoryPageBySchemaAndAddressList(
    memesAnchor, DATA_SCHEMA_UID, [attesterA, attesterB], startingCursor, pageSize
  )  // files only
  subfolders = efsFileView.getDirectoryPageBySchemaAndAddressList(
    memesAnchor, bytes32(0), [attesterA, attesterB], startingCursor, pageSize
  )  // generic (folder) anchors
  ```
- **Do not** call `tagResolver.getActiveTargetsByAttesterAndSchema(memesAnchor, ...)` directly. The TAG placement `definition` is the file anchor (e.g. `cat.jpg`'s Anchor), not the parent folder — a direct query on the folder anchor returns nothing. See `specs/03-Onchain-Indexing-Strategy.md` "TagResolver: File Placement" for why.
- **Result**: EFSFileView returns `FileSystemItem[]` with deduplicated edition-merged results, revocation-filtered. The returned cursor paginates the next page.

### 6. Show items tagged 'Funny', hide items tagged 'NSFW'
- **Action**: When rendering the children of an Anchor, resolve tag definitions and cross-reference against the edition-specific DATA UIDs.
- **Resolve definitions**: Look up `resolvePath(tagsAnchorUID, "funny")` and `resolvePath(tagsAnchorUID, "nsfw")` to get the definition Anchor UIDs.
- **Per-item check** (scoped to trusted editions): Call `tagResolver.isActivelyTaggedByAny(dataUID, TAG_SCHEMA_UID, defUID, [editionAttesters])` for each DATA UID against each definition. This scopes the check to **active tags by trusted attesters only** — no revoked tags, no untrusted attesters. Include if any edition tagged "Funny"; exclude if any edition tagged "NSFW".
- **Key invariant**: Tags are on DATA UIDs, not Anchor UIDs. If User A tagged their edition as NSFW, User B's edition of the same filename is unaffected.

### 7. Get property 'icon' in `/memes/` made by `0x123...`
- **Action**: Find the Anchor uniquely representing the name "icon" inside the parent folder `/memes/`.
- **Filter**: Look up the `Property` attestation whose `refUID` is the "icon" Anchor, explicitly filtering for attestations created by `0x123...`.
- **Result**: Read the `value` string from the Property.

### 8. File Operations
EFS files are modified by issuing new attestations.
- **Edit (new version)**: Create new DATA + PROPERTY + MIRROR. TAG new DATA at the path (`applies=true`). TAG old DATA at the path (`applies=false`). Link versions via `PROPERTY(key="previousVersion", value=oldDataUID)`. Batch in single `multiAttest`.
- **Remove from folder**: `TAG(definition=path Anchor, applies=false, refUID=DATA)`. TagResolver swap-and-pops DATA from `_activeByAAS`. DATA + mirrors + metadata survive. Other paths unaffected.
- **Delete a folder (client-driven cascade)**: Collect every active placement TAG the attester owns in the folder's subtree — their visibility TAG on the folder itself (from the upload ancestor-walk) plus every file-placement TAG on descendant anchors. Batch via EAS `multiRevoke` (chunked 50 per tx — ADR-0026 analog). TagResolver's `onRevoke` clears `_activeByAAS` entries for each revoked tag. The folder anchor itself is non-revocable and persists in the kernel forever; it simply stops appearing in the attester's edition listing because no visibility TAG is active. Ancestor folders higher in the chain remain visible if they still have other tagged content or explicit visibility TAGs.
- **Cross-reference**: `TAG(definition=new path Anchor, applies=true, refUID=existing DATA)`. Same DATA appears at multiple locations.

### 9. Resolve Subjective File Content (Editions)
- **Action**: User wants to load `/pets/best.jpg`, trusting "Vitalik", "LocalDAO", and "Self".
- **Execution**: The client calls `getActiveTargetsByAttesterAndSchema(bestJpgAnchor, attester, DATA_SCHEMA_UID, 0, 1)` for each attester in priority order.
- **Result**: The first attester with an active DATA placement wins. The client then resolves MIRRORs and PROPERTYs on that DATA UID.

### 10. List Merged Directory by Trusted Addresses
- **Action**: User opens `/pets/` and wants to see files uploaded by both "Vitalik" and "Self".
- **Execution**: `efsFileView.getDirectoryPageBySchemaAndAddressList(petsAnchor, DATA_SCHEMA_UID, [vitalik, self], cursor, pageSize)`. EFSFileView iterates child file anchors and merges edition placements internally.
- **Result**: Deduplicated, edition-merged, revocation-filtered list of file anchors under `/pets/` that have active DATA from any listed attester.

### 11. Tag a File (Edition-Specific)
- **Action**: User wants to tag their edition of `/memes/vitalik.jpg` as "funny".
- **Step 1 — Resolve or create the tag definition**: Look up `resolvePath(tagsAnchorUID, "funny")`. If zero, create an Anchor named "funny" under the `/tags/` folder (one EAS `attest` transaction). Tags can be hierarchical (e.g., `/tags/nsfw/orgy/`).
- **Step 2 — Resolve the user's DATA UID**: Call `getActiveTargetsByAttesterAndSchema(anchorUID, connectedAddress, DATA_SCHEMA_UID, count-1, 1)` to get the most recent DATA placed at this anchor.
- **Step 3 — Create the tag**: Create a Tag attestation with `refUID = dataUID`, `definition = funnyDefUID`, `applies = true`.
- **Result**: The `EFSTagResolver` stores the tag under `keccak256(attester, dataUID, funnyDefUID)`. The file appears when filtering by "funny" while viewing this user's edition, but other users' editions of the same filename are unaffected.

### 12. Remove a Tag
- **Action**: User wants to remove their "nsfw" tag from a file.
- **Step 1 — Find the active tag**: Call `getActiveTagUID(connectedAddress, dataUID, nsfwDefUID)` to get the active attestation UID.
- **Step 2 — Revoke it**: Call `eas.revoke(tagSchemaUID, activeTagUID)`. The `EFSTagResolver` clears the active mapping.
- **Result**: The tag no longer appears as active. The DATA UID remains in the append-only discovery list (`getTaggedTargets`) but `getActiveTagUID` returns zero.

### 13. Filter by Tags Across Editions
- **Action**: User is viewing `/memes/` with `editions=[Alice, Bob]` and applies tag filter "funny".
- **Resolve**: Look up the "funny" definition UID via `resolvePath(tagsAnchorUID, "funny")`.
- **Filter per DATA**: For each DATA UID surfaced by the directory listing, call `tagResolver.isActivelyTaggedByAny(dataUID, TAG_SCHEMA_UID, funnyDefUID, [alice, bob])`. Returns true only if one of the listed attesters has an **active** (not revoked, not `applies=false`) tag on that DATA.
- **Do not** use raw `getTaggedTargets(funnyDefUID, ...)` for this — it is an append-only index that includes revoked tags and tags from untrusted attesters.
- **Result**: Only files where at least one of the viewed editions has an active "funny" tag appear in the listing.

### 14. Cross-User Tagging (Curating Someone Else's Content)
- **Action**: User B wants to mark User A's edition of `/memes/cat.gif` as "nsfw".
- **Execution**: User B creates a Tag attestation with `refUID = dataA_UID` (User A's DATA UID), `definition = nsfwDefUID`, `applies = true`.
- **Result**: The tag is stored under `keccak256(userB, dataA_UID, nsfwDefUID)`. User A's DATA UID now appears in `getTaggedTargets(nsfwDefUID)`. When anyone views User A's edition and filters by "nsfw", the file matches. User B's own edition is unaffected. Multiple users can independently tag the same DATA UID; each tag is stored under a separate attester key.

### 15. "Where does this file live?" (Reverse Lookup)
- **Action**: Given a DATA UID, find all paths where it's been placed.
- **Execution**: Read `getTagDefinitions(dataUID, 0, count)` — all definitions ever applied. For each definition, check `getActiveTagUID(myAddress, dataUID, definition)` and `isApplied`.
- **Result**: Returns the set of Anchor UIDs where the user has actively placed this DATA. O(n) in definitions ever applied; typically 1–5 folders.

---

## List Workflows

EFS lists use the kernel/overlay architecture: the kernel (EFSIndexer) tracks items in insertion order; the sort overlay (EFSSortOverlay) maintains shared sorted linked lists on top (keyed by `(sortInfoUID, parentAnchor)` — edition filtering is applied at read time). There is no separate list contract. See [Lists and Collections](./06-Lists-and-Collections.md) for the full design.

### 16. Create a New Sort and Add Items

- **Step 1 — Create the directory**: The list is a normal EFS directory (Anchor). If it doesn't exist yet, attest an Anchor for it under the desired parent.
- **Step 2 — Add items**: For each item, attest an Anchor as a child of the list directory. Set `anchorSchema = DATA_SCHEMA_UID` for file items. Items accumulate in the kernel in insertion order.
- **Step 3 — Create a sort**: Attest an Anchor for the sort name (e.g. "alphabetical") under the list directory with `anchorSchema = SORT_INFO_SCHEMA_UID` as the naming anchor. Then attest a SORT_INFO attestation with `refUID = namingAnchorUID`, `sortFunc = <ISortFunc address>`, `targetSchema = bytes32(0)` (or restrict to a specific schema).
- **Step 4 — Populate the sort**: Call `EFSSortOverlay.processItems(sortInfoUID, parentAnchor, expectedStartIndex, items, leftHints, rightHints)`. See workflow 17 for the hint computation algorithm.
- **Result**: Items are pageable via `getSortedChunk(sortInfoUID, parentAnchor, bytes32(0), 10, false)`. The sorted list is shared — all attesters contribute to a single ordering per `(sortInfoUID, parentAnchor)`. Edition filtering is applied at read time via `getSortedChunkByAddressList`.

### 17. Populate a Sort (processItems Client Algorithm)

`processItems` requires the client to supply position hints for each new item. The full algorithm:

**Inputs:**
- `sortInfoUID` — the SORT_INFO attestation UID
- `parentAnchor` — the directory anchor the sort belongs to (read from `SortConfig.parentUID`)

Note: the sorted list is **shared across attesters** — `processItems` is keyed by `(sortInfoUID, parentAnchor)`, not by `attester`. Edition filtering is applied at read time.

**Step 1 — Determine what to process:**
```
lastIdx = overlay.getLastProcessedIndex(sortInfoUID, parentAnchor)
total   = indexer.getChildCountBySchema(parentAnchor, targetSchema)
// Walk kernel children from lastIdx..total for items matching the SORT_INFO's
// targetSchema. The overlay validates each item against the shared kernel
// arrays, not per-attester — the sort includes everyone's contributions.
newItems = indexer.getChildrenBySchema(parentAnchor, targetSchema, lastIdx, total - lastIdx, false, false)
```

Alternatively use `EFSSortOverlay.computeHints(sortInfoUID, parentAnchor, newItems)` — a free view function that computes correct `leftHints` and `rightHints` for you via on-chain binary search, removing the need to implement Steps 2–4 client-side for lists under ~1000 items.

**Step 2 — Fetch the current sorted state:**
```
alreadySorted = readSortedAll(sortInfoUID, parentAnchor)  // via getSortedChunk pagination
```

**Step 3 — Compute sort keys for all items:**
```
// Call ISortFunc.getSortKey(uid, sortInfoUID) for each item in newItems and alreadySorted
// Empty bytes = ineligible item (will be skipped by overlay; pass ZeroHash hints)
```

**Step 4 — Binary-search insert simulation (client-side):**
For each new item (in kernel order), simulate inserting it into the current sorted list:
1. Binary search `alreadySorted` by sort key to find the insertion position `pos`
2. `leftHint = pos == 0 ? ZeroHash : alreadySorted[pos - 1]`
3. `rightHint = pos == alreadySorted.length ? ZeroHash : alreadySorted[pos]`
4. Insert the item into `alreadySorted` at `pos` so subsequent items in the batch see the updated state

**Step 5 — Submit:**
```
overlay.processItems(sortInfoUID, parentAnchor, lastIdx, newItems, leftHints, rightHints)
```

The overlay validates each position with `ISortFunc.isLessThan` on-chain and reverts with `InvalidPosition` if hints are wrong.

### 18. Paginate Through a Sorted List

- **Action**: SPA renders a sorted list.
- **Step 1**: Call `getSortedChunk(sortInfoUID, parentAnchor, bytes32(0), 20, false)` → returns `items[0..19]` and `nextCursor`. To filter by attester/edition, use `getSortedChunkByAddressList(sortInfoUID, parentAnchor, bytes32(0), 20, attesters)` instead.
- **Step 2**: On scroll, call `getSortedChunk(sortInfoUID, parentAnchor, nextCursor, 20, false)` → next page.
- **Step 3**: For each item UID, resolve content via TagResolver queries and MIRROR resolution.
- **Staleness check**: Call `getSortStaleness(sortInfoUID, parentAnchor)` before rendering. If `> 0`, prompt the user: "N items unprocessed — pay gas to update sort?".
- **Key rule**: Pin `blockNumber` in `eth_call` across all pages in a session to prevent cursor drift from concurrent `processItems` calls.

### 19. Remove a List Item

- **Action**: Remove a file from a path or revoke an Anchor.
- **TAG removal (preferred)**: `TAG(definition=path Anchor, applies=false, refUID=DATA)`. TagResolver swap-and-pops the DATA from `_activeByAAS`. DATA + mirrors + metadata survive at other paths. Clean and reversible.
- **Anchor revoke**: `eas.revoke(anchorSchemaUID, anchorUID)` — EFSIndexer sets `_isRevoked[uid] = true`. The item stays in the kernel array but `getChildren(..., showRevoked=false)` skips it. Future `processItems` calls also skip it automatically (`indexer.isRevoked(item)` check).
- **Sort overlay**: Revoked items already processed into a sorted linked list remain there — the overlay is a snapshot. The UI should check revocation status and treat revoked items as hidden.

### 20. View a Merged Sorted List from Multiple Attesters

- **Action**: SPA displays a sorted list filtered to Alice's and Bob's contributions.
- **Shared list model**: The sorted linked list is shared — all attesters contribute items to a single ordering keyed by `(sortInfoUID, parentAnchor)`. Edition filtering is applied at read time, not at write time.
- **Step 1**: Call `getSortedChunkByAddressList(sortInfoUID, parentAnchor, bytes32(0), 20, [alice, bob])` → returns only items contributed by Alice or Bob, in sorted order.
- **Step 2**: On scroll, pass the returned `nextCursor` to the next call.
- **Step 3**: For each item UID, resolve content via TagResolver queries and MIRROR resolution.
- **Result**: Single sorted list on-chain; attester filtering is a read-time concern. See [Sort Overlay Architecture](./07-Sort-Overlay-Architecture.md) for the authoritative API reference.

### 21. Restrict a Sort to a Specific Schema

- **Action**: Create a sort that only orders file anchors (ignoring sort naming anchors, property anchors, etc.).
- **Step 1**: When creating the SORT_INFO, set `targetSchema = DATA_SCHEMA_UID`.
- **Enforcement**: `ISortFunc.getSortKey` returns empty bytes for items whose schema doesn't match `targetSchema`. The overlay skips them automatically (empty key = ineligible), so they never appear in the sorted list.
- **Result**: Only Anchors with `anchorSchema == DATA_SCHEMA_UID` appear in the sorted view. Sort naming Anchors and other meta-anchors are automatically excluded.
