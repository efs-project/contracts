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
- **Result**: The Indexer performs round-robin pagination, returning a mixed list of files from both users and a cursor to fetch the next page safely.

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

### 13. Create a New List and Add Items

- **Step 1 — Create LIST_INFO**: Attest with the LIST_INFO schema, setting `listType = 1` (Chronological), `targetSchemaUID = bytes32(0)` (unrestricted), and optionally `refUID` to an EFS Anchor to pin the list to a filesystem path.
- **Step 2 — Add items**: For each item, attest with the LIST_ITEM schema setting `refUID = listInfoUID`. The `EFSListManager` resolver appends each item to the attester's linked list tail.
- **Result**: The list is immediately pageable via `getSortedChunk(listInfoUID, attester, bytes32(0), 10)`.

### 14. Paginate Through a List

- **Action**: SPA renders a list with potentially millions of items.
- **Step 1**: Call `getSortedChunk(listInfoUID, attester, bytes32(0), 10)` → returns `items[0..9]` and `cursor = items[10]`.
- **Step 2**: When user scrolls, call `getSortedChunk(listInfoUID, attester, cursor, 10)` → returns the next 10 items.
- **Key rule**: Pin `blockNumber` in `eth_call` across all pages in a session to prevent cursor drift from concurrent inserts/deletes.

### 15. Remove a List Item

- **Action**: Revoke the LIST_ITEM attestation via `eas.revoke(listItemSchemaUID, itemAttUID)`.
- **Result**: The `EFSListManager` `onRevoke` hook unlinks the node in O(1). Prev/next neighbours are bridged. The list is immediately consistent; subsequent `getSortedChunk` calls skip the removed item.

### 16. Build a Social Graph (Address-Based List / EFP Style)

- **Action**: User creates a "following" list where each entry is an Ethereum address rather than a file.
- **Step 1**: Create LIST_INFO with `targetSchemaUID = bytes32(0)` and `refUID` pointing to e.g. the `/social/following` Anchor.
- **Step 2**: For each address to follow, attest LIST_ITEM with `itemUID = bytes32(0)` and `recipient = targetAddress`. The zero `itemUID` signals an address-based entry; the schema constraint check is bypassed.
- **Read**: Paginate via `getSortedChunk` as normal. Decode `recipient` from each LIST_ITEM attestation to get the followed address.

### 17. View a Merged List from Multiple Attesters (Edition Merge)

- **Action**: SPA displays a list merging User A's curation with User B's additions.
- **Step 1**: Fetch page from User A: `getSortedChunk(listInfoUID, userA, cursor_A, 10)`.
- **Step 2**: Fetch page from User B: `getSortedChunk(listInfoUID, userB, cursor_B, 10)`.
- **Step 3 (client)**: Sort the combined 20 items by fractional index (or timestamp for Chronological lists). Apply tombstones from the viewer's Tier 1 Local Overrides. Fill to target page size if tombstones reduced the count.
- **Result**: A subjective merged view with no on-chain coupling between the two attesters' lists.

### 18. Apply a User Override (Tombstone an Item in Your Edition)

- **Action**: User B views User A's list and wants to hide item 5 from their own view.
- **Execution**: User B creates a DATA attestation with `fileMode = "tombstone"` and `refUID` pointing to the specific LIST_ITEM attestation UID they want to hide.
- **Client-side**: The SPA's Four-Tier Resolution Engine detects User B's tombstone (Tier 1) and removes item 5 before rendering. User A's canonical list is untouched.

### 19. Enforce Schema Type on List Items

- **Action**: Create a list that only accepts Image file attestations.
- **Step 1**: Create LIST_INFO with `targetSchemaUID = dataSchemaUID` (or whichever schema represents Image files).
- **Step 2**: When attesting LIST_ITEM, set `itemUID` to an existing DATA attestation UID.
- **Enforcement**: The `EFSListManager` resolver calls `_eas.getAttestation(itemUID).schema` and reverts with `SchemaTypeMismatch` if the schema doesn't match. Address-based items (`itemUID = bytes32(0)`) bypass this check.
