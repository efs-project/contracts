# Core Workflows

This document maps the step-by-step execution for specific developer and user interactions within the EFS, relying on the [Onchain Indexing Strategy](./03-Onchain-Indexing-Strategy.md) and [Data Models and Schemas](./02-Data-Models-and-Schemas.md). Because EFS is subjective and permissionless, any data can be written, but the read state depends on the querier's perspective (Edition or Web of Trust).

### 1. Navigate to `/memes/` and list the newest 10 files
- **Action**: Query the `EFSIndexer` using `rootAnchorUID()` to find the root. Then, resolve the name "memes" under the root to get the `/memes/` Anchor UID.
- **Filter**: Filter results for `Data` schema attestations where the `fileMode` denotes a normal file.
- **Sort**: Order the entries by the block timestamp or EAS creation time descending.
- **Limit**: Return the top 10 results.

### 2. In `/memes/`, list the newest 10 videos
- **Action**: Retrieve files in the `/memes/` Anchor.
- **Resolution**: Inspect the `uri` and `contentType` directly on the `Data` attestations.
- **Filter**: Check the `contentType` field of the `Data` attestations to match standard video Content Types (e.g., `video/mp4`).
- **Sort & Query**: Return the newest 10 matching video files.

### 3. In `/memes/`, get the newest 10 images from `0x123...`
- **Action**: Retrieve files in the `/memes/` Anchor.
- **Filter 1**: Restrict the attester of the `Data` (and possibly the `Anchor`) to the specific address `0x123...`.
- **Filter 2**: Inspect the `Data` attestations and match `contentType` with image Content Types (e.g., `image/jpeg`, `image/png`).
- **Sort & Query**: Return the newest 10 matches.

### 4. Show items tagged 'Funny', hide items tagged 'NSFW'
- **Action**: When rendering the children of an Anchor, resolve tag definitions and cross-reference against the edition-specific DATA UIDs.
- **Resolve definitions**: Look up `resolvePath(tagsAnchorUID, "funny")` and `resolvePath(tagsAnchorUID, "nsfw")` to get the definition Anchor UIDs.
- **Fetch tagged targets**: Call `getTaggedTargets(funnyDefUID, 0, count)` and `getTaggedTargets(nsfwDefUID, 0, count)` to get the sets of tagged DATA UIDs.
- **Per-item check**: For each file item in the directory, call `getDataByAddressList(anchorUID, editionAddresses, false)` to get the currently viewed edition's DATA UID. Check if that DATA UID appears in the "Funny" set (include) or the "NSFW" set (exclude).
- **Key invariant**: Tags are on DATA UIDs, not Anchor UIDs. If User A tagged their edition as NSFW, User B's edition of the same filename is unaffected.

### 5. Get property 'icon' in `/memes/` made by `0x123...`
- **Action**: Find the Anchor uniquely representing the name "icon" inside the parent folder `/memes/`.
- **Filter**: Look up the `Property` attestation whose `refUID` is the "icon" Anchor, explicitly filtering for attestations created by `0x123...`.
- **Result**: Read the `value` string from the Property.

### 6. File Operations (CRUD)
EFS files are modified by issuing new attestations over existing paths.
- **Rename (`/memes/vitalik.jpg` to `/memes/vitalikoriginal.jpg`)**: Create a new destination Anchor for `vitalikoriginal.jpg` pointing to the original URI. Then, issue a deletion/obfuscation attestation for the old Anchor.
- **Delete (`/memes/vitalik.jpg`)**: Create a new `Data` attestation for the existing Anchor where `fileMode` is explicitly set to `"tombstone"`. The indexer recognizes this and removes the file from active directory queries.
- **Add Shortcut (`/memes/vitalikinfo` -> `/people/vitalik/`)**: Create a `Data` attestation where `fileMode` denotes "symlink/shortcut", and the generic bytes point to the destination UID. The Web UI recognizes this mode and requires a user click to navigate.
- **Add Hardlink (`/memes/vitalik.jpg` -> `/funny/vitalikfunny.jpg`)**: Create a `Data` attestation where `fileMode` denotes "hardlink". The Web UI indexes the destination link and automatically resolves to view the content.

### 7. Resolve Subjective File Content (Editions)
- **Action**: User wants to load `/pets/best.jpg`, trusting "Vitalik", "LocalDAO", and "Self".
- **Execution**: The client calls `getDataByAddressList` on the Anchor UID, passing `[Self, LocalDAO, Vitalik]`. 
- **Result**: The Indexer checks `Self`'s history first, then `LocalDAO`'s, returning the first valid, unrevoked file data it finds.

### 8. List Merged Directory by Trusted Addresses
- **Action**: User opens `/pets/` and wants to see files uploaded by both "Vitalik" and "Self".
- **Execution**: The client calls `getChildrenByAddressList` with the `parentUID`, passing `[Self, Vitalik]` and a target `pageSize`.
- **Result**: The Indexer walks the global children array and returns only items where Self or Vitalik contributed — in insertion order, no duplicates. Pass the returned cursor to get the next page. For a fair round-robin view (giving each attester equal representation), use `getChildrenByAddressListInterleaved` instead.

### 9. Tag a File (Edition-Specific)
- **Action**: User wants to tag their edition of `/memes/vitalik.jpg` as "funny".
- **Step 1 — Resolve or create the tag definition**: Look up `resolvePath(tagsAnchorUID, "funny")`. If zero, create an Anchor named "funny" under the `/tags/` folder (one EAS `attest` transaction).
- **Step 2 — Resolve the user's DATA UID**: Call `getDataByAddressList(anchorUID, [connectedAddress], false)` to get the connected user's DATA attestation UID for this file.
- **Step 3 — Create the tag**: Create a Tag attestation with `refUID = dataUID`, `definition = funnyDefUID`, `applies = true`.
- **Result**: The `EFSTagResolver` stores the tag under `keccak256(attester, dataUID, funnyDefUID)`. The file appears when filtering by "funny" while viewing this user's edition, but other users' editions of the same filename are unaffected.

### 10. Remove a Tag
- **Action**: User wants to remove their "nsfw" tag from a file.
- **Step 1 — Find the active tag**: Call `getActiveTagUID(connectedAddress, dataUID, nsfwDefUID)` to get the active attestation UID.
- **Step 2 — Revoke it**: Call `eas.revoke(tagSchemaUID, activeTagUID)`. The `EFSTagResolver` clears the active mapping.
- **Result**: The tag no longer appears as active. The DATA UID remains in the append-only discovery list (`getTaggedTargets`) but `getActiveTagUID` returns zero.

### 11. Filter by Tags Across Editions
- **Action**: User is viewing `/memes/` with `editions=[Alice, Bob]` and applies tag filter "funny".
- **Resolve**: Look up the "funny" definition UID via `resolvePath(tagsAnchorUID, "funny")`.
- **Build tagged set**: Fetch `getTaggedTargets(funnyDefUID, 0, count)` into a `Set`.
- **Per-item check**: For each item in the directory listing:
  - For Alice: `getDataByAddressList(anchorUID, [Alice], false)` returns Alice's DATA UID. Check if it is in the tagged set.
  - For Bob: `getDataByAddressList(anchorUID, [Bob], false)` returns Bob's DATA UID. Check if it is in the tagged set.
  - If **either** matches, include the item. If **neither** matches, exclude it.
- **Result**: Only files where at least one of the viewed editions has been tagged "funny" appear in the listing.

### 12. Cross-User Tagging (Curating Someone Else's Content)
- **Action**: User B wants to mark User A's edition of `/memes/cat.gif` as "nsfw".
- **Execution**: User B creates a Tag attestation with `refUID = dataA_UID` (User A's DATA UID), `definition = nsfwDefUID`, `applies = true`.
- **Result**: The tag is stored under `keccak256(userB, dataA_UID, nsfwDefUID)`. User A's DATA UID now appears in `getTaggedTargets(nsfwDefUID)`. When anyone views User A's edition and filters by "nsfw", the file matches. User B's own edition is unaffected. Multiple users can independently tag the same DATA UID; each tag is stored under a separate attester key.

---

## List Workflows

EFS lists use the kernel/overlay architecture: the kernel (EFSIndexer) tracks items in insertion order; the sort overlay (EFSSortOverlay) maintains per-attester sorted linked lists on top. There is no separate list contract. See [Lists and Collections](./06-Lists-and-Collections.md) for the full design.

### 13. Create a New Sort and Add Items

- **Step 1 — Create the directory**: The list is a normal EFS directory (Anchor). If it doesn't exist yet, attest an Anchor for it under the desired parent.
- **Step 2 — Add items**: For each item, attest an Anchor as a child of the list directory. Set `anchorSchema = DATA_SCHEMA_UID` for file items. Items accumulate in the kernel in insertion order.
- **Step 3 — Create a sort**: Attest an Anchor for the sort name (e.g. "alphabetical") under the list directory with `anchorSchema = SORT_INFO_SCHEMA_UID` as the naming anchor. Then attest a SORT_INFO attestation with `refUID = namingAnchorUID`, `sortFunc = <ISortFunc address>`, `targetSchema = bytes32(0)` (or restrict to a specific schema).
- **Step 4 — Populate the sort**: Call `EFSSortOverlay.processItems(sortInfoUID, items, leftHints, rightHints)`. See workflow 14 for the hint computation algorithm.
- **Result**: Items are pageable via `getSortedChunk(sortInfoUID, attester, bytes32(0), 10)`.

### 14. Populate a Sort (processItems Client Algorithm)

`processItems` requires the client to supply position hints for each new item. The full algorithm:

**Inputs:**
- `sortInfoUID` — the SORT_INFO attestation UID
- `attester` — the address whose sorted view to update (msg.sender)

**Step 1 — Determine what to process:**
```
lastIdx = overlay.getLastProcessedIndex(sortInfoUID, attester)
newItems = indexer.getChildrenByAttester(dirUID, attester, lastIdx, pageSize, false, false)
// newItems are in kernel insertion order starting from lastIdx
```

**Step 2 — Fetch the current sorted state:**
```
alreadySorted = readSortedAll(sortInfoUID, attester)  // via getSortedChunk pagination
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
overlay.processItems(sortInfoUID, newItems, leftHints, rightHints)
```

The overlay validates each position with `ISortFunc.isLessThan` on-chain and reverts with `InvalidPosition` if hints are wrong.

### 15. Paginate Through a Sorted List

- **Action**: SPA renders a sorted list.
- **Step 1**: Call `getSortedChunk(sortInfoUID, attester, bytes32(0), 20)` → returns `items[0..19]` and `nextCursor`.
- **Step 2**: On scroll, call `getSortedChunk(sortInfoUID, attester, nextCursor, 20)` → next page.
- **Step 3**: For each item UID, resolve content via `getDataByAddressList(itemUID, editionAddresses, false)`.
- **Staleness check**: Call `getSortStaleness(sortInfoUID, attester)` before rendering. If `> 0`, prompt the user: "N items unprocessed — pay gas to update sort?".
- **Key rule**: Pin `blockNumber` in `eth_call` across all pages in a session to prevent cursor drift from concurrent `processItems` calls.

### 16. Remove a List Item (Revoke)

- **Action**: Revoke the item's Anchor or DATA attestation.
- **Anchor revoke**: `eas.revoke(anchorSchemaUID, anchorUID)` — EFSIndexer sets `_isRevoked[uid] = true`. The item stays in the kernel array but `getChildren(..., showRevoked=false)` skips it. Future `processItems` calls also skip it automatically (`indexer.isRevoked(item)` check).
- **DATA revoke**: `eas.revoke(dataSchemaUID, dataUID)` — EFSIndexer marks the DATA UID revoked. `getDataByAddressList` falls back to the next attester in the priority list.
- **Sort overlay**: Revoked items already processed into a sorted linked list remain there — the overlay is a snapshot. The UI should resolve content via `getDataByAddressList` and treat a null result (all editions revoked) as a tombstone.

### 17. View a Merged Sorted List from Multiple Attesters

- **Action**: SPA displays a sorted list merging Alice's curation with Bob's additions.
- **Step 1**: Read Alice's sorted view: `getSortedChunk(sortInfoUID, alice, bytes32(0), 20)`.
- **Step 2**: Read Bob's sorted view: `getSortedChunk(sortInfoUID, bob, bytes32(0), 20)`.
- **Step 3 (client)**: Each attester's sorted view is independent. Merge strategies:
  - **Union**: combine and deduplicate by anchor UID, re-sort client-side by sort key.
  - **Interleave**: display Alice's list first (or Bob's), then items the other has that aren't in the first.
  - **Edition-aware**: for each position in Alice's sorted list, call `getDataByAddressList(itemUID, [alice, bob], false)` — content comes from the priority list regardless of who sorted it.
- **Result**: No on-chain coupling between attesters' lists. Each is independently maintained.

### 18. Apply a User Override (Tombstone an Item)

- **Action**: User B views User A's sorted list and wants to hide one item from their own view.
- **Execution**: User B creates a DATA attestation with `fileMode = "tombstone"` and `refUID` pointing to the item's Anchor UID.
- **Client-side**: When rendering, resolve each item's content via `getDataByAddressList(itemUID, [userB, userA], false)`. User B's tombstone DATA wins (it's first in the priority list and has `fileMode = "tombstone"`). The UI hides the item. User A's sorted list and content are untouched.

### 19. Restrict a Sort to a Specific Schema

- **Action**: Create a sort that only orders file anchors (ignoring sort naming anchors, property anchors, etc.).
- **Step 1**: When creating the SORT_INFO, set `targetSchema = DATA_SCHEMA_UID`.
- **Enforcement**: `ISortFunc.getSortKey` returns empty bytes for items whose schema doesn't match `targetSchema`. The overlay skips them automatically (empty key = ineligible), so they never appear in the sorted list.
- **Result**: Only Anchors with `anchorSchema == DATA_SCHEMA_UID` appear in the sorted view. Sort naming Anchors and other meta-anchors are automatically excluded.
