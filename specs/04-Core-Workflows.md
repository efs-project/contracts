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
- **Action**: When rendering the children of an Anchor, resolve all associated `Tag` schemas pointing at the child data.
- **Filter (Include)**: Query for Tags resolving to the Anchor UID representing definition "Funny".
- **Filter (Exclude)**: If an item has a tag pointing to the "NSFW" Anchor definition, immediately filter it out of the visible UI scope for the user.

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
