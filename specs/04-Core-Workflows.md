# Core Workflows

This document maps the step-by-step execution for specific developer and user interactions within the EFS, relying on the [Onchain Indexing Strategy](./03-Onchain-Indexing-Strategy.md) and [Data Models and Schemas](./02-Data-Models-and-Schemas.md). Because EFS is subjective and permissionless, any data can be written, but the read state depends on the querier's perspective (Lens or Web of Trust).

### 1. Upload a file to `/memes/cat.jpg` (on-chain)
- **Action**: Atomic upload via EAS `multiAttest` — all attestations in a single transaction.
- **Step 1**: Read file bytes → compute `keccak256(bytes)` locally for `contentHash`; measure `size`. These are attester-supplied claims, not DATA fields (ADR-0049).
- **Step 2**: Query the PROPERTY index for a trusted `contentHash` claim to check for an existing DATA (best-effort client-side dedup, ADR-0049). If a matching DATA UID is found from a trusted attester, skip DATA attestation and hardlink the existing DATA with a new PIN (step 4.1 below). To resolve an existing duplicate to a canonical, use the REDIRECT primitive (ADR-0050).
- **Step 3**: Walk the ancestor chain from `/memes/` up to root exclusive (ADR-0006 revised 2026-04-18, ADR-0038, ADR-0041). For each generic folder the attester hasn't already covered with an active `TAG(definition=DATA_SCHEMA_UID, refUID=folder)`, queue a visibility TAG for that folder. A TAG is active iff it exists and is not EAS-revoked; weight is opaque metadata (ADR-0041 §4). The walk short-circuits the first time an existing active TAG is found — steady-state cost is zero. Bounded by `MAX_ANCHOR_DEPTH = 32` (ADR-0021).
- **Step 4**: Build `multiAttest` batch:
  1. `DATA()` — **empty schema** (pure identity, ADR-0049), standalone, non-revocable, `refUID = 0x0`. No `contentHash` or `size` fields.
  2. **contentType binding** (ADR-0041 supersedes ADR-0035): three sub-attestations — (a) `Anchor(refUID=DATA, anchorSchema=PROPERTY_SCHEMA_UID, name="contentType")` (skipped if already exists from a prior upload of this DATA), (b) `PROPERTY(value="image/jpeg")` — free-floating, `refUID = 0x0`, (c) `PIN(definition=contentType keyAnchor, refUID=PROPERTY UID)` — binds the value into the cardinality-1 slot.
  2a. **contentHash + size bindings** (ADR-0049): same three-sub-attestation pattern for `contentHash` (e.g. `keccak256(bytes)`) and `size` (byte count as decimal string) — each is a reserved-key PROPERTY bound to the DATA UID via PIN, lens-scoped per attester.
  3. `MIRROR(transportDef=/transports/onchain, uri=web3://0xABC)` — `refUID = DATA UID`
  4. `PIN(definition=cat.jpg Anchor)` — `refUID = DATA UID` (places DATA at path; cardinality-1 — re-PIN at the same `(attester, definition, targetSchema)` slot supersedes the prior placement in O(1))
  5. One visibility TAG per queued ancestor from Step 3: `TAG(definition=DATA_SCHEMA_UID, refUID=ancestorFolder, weight=1)`. Weight=1 is the conventional default; any existing non-revoked TAG makes the folder appear in the attester's lens listing.
- **Result**: EdgeResolver indexes the placement PIN in `_activeBySlot[catAnchor][alice][DATA_SCHEMA]` (cardinality-1, O(1) supersede) and each visibility TAG in `_activeByAAS[ancestor][alice][DATA_SCHEMA]`. EFSIndexer's `_containsAttestations[ancestor][alice]` is set as the kernel-level "this attester has anchored content somewhere under here" flag. `EFSFileView.getDirectoryPageBySchemaAndAddressList` paginates child anchors via opaque cursor (ADR-0036) and filters single-source — untagged folders, even ones containing the attester's files, do not appear in that attester's lens (tag-only model, ADR-0038).

### 2. Paste an IPFS link to `/docs/paper.pdf`
- **Action**: Same as upload but MIRROR uses a different transport.
- **Step 1**: Client fetches `ipfs://QmXxx` via gateway to compute `keccak256(bytes)` for `contentHash` (attester's claim, client can verify on display). For large files, user provides hash manually.
- **Step 2**: Build `multiAttest` batch:
  1. `DATA()` — empty schema (pure identity, ADR-0049); no `contentHash` or `size` fields.
  2. contentType binding triplet (Anchor + PROPERTY + PIN — see workflow 1 step 4 for the breakdown)
  2a. contentHash + size binding triplets (reserved-key PROPERTYs bound to the DATA UID via PIN — see workflow 1 step 4a)
  3. `MIRROR(transportDef=/transports/ipfs, uri=ipfs://QmXxx)`
  4. `PIN(definition=paper.pdf Anchor, refUID=DATA UID)`
- **Result**: File appears in `/docs/` with IPFS retrieval. Client resolves via gateway URL.

### 3. Add a mirror to an existing file
- **Action**: Attach an additional retrieval method to an existing DATA.
- **Execution**: Single `MIRROR(refUID=existing DATA UID, transportDef=/transports/arweave, uri=ar://yyy)` attestation.
- **Result**: File now has multiple transport options. Client picks best available per transport preference (web3 > ar > ipfs > magnet > https; see ADR-0012).

### 4. Cross-reference the same file at another path
- **Action**: Place an existing DATA at a second path (e.g., same cat.jpg at `/animals/cat.jpg`).
- **Execution**: Single `PIN(definition=animals/cat.jpg Anchor, refUID=same DATA UID)`.
- **Result**: DATA, PROPERTYs, and MIRRORs are shared. Only one new PIN. Metadata on the canonical DATA is visible from both paths. **If you pin across an attester boundary** (e.g. Bob pins Alice's DATA), MIRRORs/`contentType` are lens-scoped and won't resolve under Bob — see workflow 8e Caveat A.

### 4a. Browse an address home (`/vitalik.eth/memes/`)
- **Action**: Resolve the top-level URL segment as an Ethereum address and walk anchors parented at that address (ADR-0033).
- **Step 1**: Off-chain, the UI resolves `vitalik.eth` via `publicClient.getEnsAddress` → checksummed address `0xd8dA…6045`. The on-chain router accepts raw 40-char hex only; ENS stays in the client per ADR-0030.
- **Step 2**: Classify the segment (address → schema → attestation → anchor precedence). An address turns into `seedUID = bytes32(uint160(addr))`.
- **Step 3**: Walk `resolvePath(seedUID, "memes")` → `resolvePath(<that>, "cat.jpg")` using the existing anchor-walk loop. `_nameToAnchor[parentUID][name][schema]` already indexes anchors parented at an address (via `EFSIndexer.onAttest`'s `refUID=0 && recipient!=0` fallback).
- **Step 4**: If no `?lenses=` was given, the router defaults lenses to `[caller, vitalikAddr]` — the connected wallet wins, vitalik's lens fills the gaps. Explicit `?lenses=` overrides wholesale (ADR-0031).
- **Result**: A file under vitalik's home resolves exactly like any anchor path, scoped to his lenses. The UI renders a `ContainerInfoPanel` showing the ENS name, a "You" chip when connected matches, and an Etherscan link.

### 5. Navigate to `/memes/` and list files
- **Action**: Query EFSFileView (which composes EFSIndexer's child indices with EdgeResolver edge checks) for DATAs and sub-folders at an Anchor, filtered by attester.
- **Execution**: call EFSFileView — it iterates child anchors, merges lenses, and paginates.
  ```
  items = efsFileView.getDirectoryPageBySchemaAndAddressList(
    memesAnchor, DATA_SCHEMA_UID, [attesterA, attesterB], startingCursor, pageSize
  )  // returns both sub-folders (phase 0, TAG-visibility) and file anchors (phase 1, PIN-placement)
  ```
  A single `DATA_SCHEMA_UID` call covers both folders and files. Phase 0 returns sub-folders that any listed attester has made visible via a TAG (ADR-0038); phase 1 returns file anchors where any listed attester has an active PIN. Do not pass `bytes32(0)` as the schema argument — that bypasses ADR-0038 visibility TAG checks and returns all child anchors regardless of whether any attester has tagged the folder visible.
- **Do not** call `edgeResolver.getActivePinTarget(memesAnchor, ...)` directly. The placement PIN's `definition` is the file anchor (e.g. `cat.jpg`'s Anchor), not the parent folder — a direct query on the folder anchor returns nothing. See `specs/03-Onchain-Indexing-Strategy.md` for the discovery indices that EFSFileView uses to enumerate children.
- **Result**: EFSFileView returns `FileSystemItem[]` with deduplicated lens-merged results, revocation-filtered. The returned cursor paginates the next page.

### 6. Show items tagged 'Funny', hide items tagged 'NSFW'
- **Action**: When rendering the children of an Anchor, resolve tag definitions and cross-reference against the lens-specific DATA UIDs.
- **Resolve definitions**: Look up `resolvePath(tagsAnchorUID, "funny")` and `resolvePath(tagsAnchorUID, "nsfw")` to get the definition Anchor UIDs.
- **Per-item check** (scoped to trusted lenses): Call `edgeResolver.hasActiveTagFromAny(dataUID, defUID, [lensAttesters])` for each DATA UID against each definition. This scopes the check to **active TAGs by trusted attesters only** — no revoked edges, no untrusted attesters. Descriptive file labels are always TAG (cardinality N, ADR-0041). Include if any lens tagged "Funny"; exclude if any lens tagged "NSFW".
- **Key invariant**: Tags are on DATA UIDs, not Anchor UIDs. If User A tagged their lens as NSFW, User B's lens of the same filename is unaffected.

### 7. Get property 'icon' in `/memes/` made by `0x123...`
- **Action**: Find the PROPERTY value bound to the "icon" key anchor under `/memes/` by attester `0x123...` (ADR-0041 binding model).
- **Resolve key anchor**: `iconKeyAnchor = resolvePath(memesAnchor, "icon")` — its `anchorSchema` should equal `PROPERTY_SCHEMA_UID`.
- **Resolve bound value**: `propertyUID = edgeResolver.getActivePinTarget(iconKeyAnchor, 0x123..., PROPERTY_SCHEMA_UID)` — returns the active PROPERTY UID for that attester at that key (cardinality-1, O(1)).
- **Result**: `eas.getAttestation(propertyUID)` and read the `value` string from the PROPERTY's data.

### 8. File Operations
EFS files are modified by issuing new attestations.
- **Edit (new version)**: Create new DATA + contentType binding + MIRROR. Attest `PIN(definition=path Anchor, refUID=newDataUID)` — the new PIN automatically supersedes the prior placement in O(1) at the same `(attester, definition, targetSchema)` slot; no separate "deactivate old" attestation is needed (ADR-0041). Optionally bind a `previousVersion` PROPERTY on the new DATA. Batch in a single `multiAttest`.
- **Remove from folder**: Fetch the active PIN via `edgeResolver.getActivePin(pathAnchor, attester, DATA_SCHEMA_UID)`, then `eas.revoke(PIN_SCHEMA_UID, activePinUID)`. EdgeResolver's `onRevoke` clears `_activeBySlot[pathAnchor][attester][DATA_SCHEMA]`. DATA + mirrors + metadata survive at other paths.
- **Delete a folder (client-driven cascade)**: Collect every active edge the attester owns in the folder's subtree — the visibility TAG on the **target folder only** (NOT ancestors — revoking an ancestor would hide sibling content the attester still owns elsewhere in that subtree) plus every file-placement PIN on descendant anchors. Batch via EAS `multiRevoke` (chunked 50 per tx — ADR-0026 analog). EdgeResolver's `onRevoke` clears the corresponding `_activeBySlot` (PIN) / `_activeByAAS` (TAG) entries; when an attester's active edge count on a given anchor drops to zero, EdgeResolver also calls `EFSIndexer.clearContains(anchor, attester)` so `_containsAttestations` no longer reports the attester as a contributor to that subtree (refines ADR-0010). The folder anchor itself is non-revocable and persists in the kernel forever; it simply stops appearing in the attester's lens listing because no visibility TAG is active.
- **Cross-reference**: `PIN(definition=new path Anchor, refUID=existing DATA)`. Same DATA appears at multiple locations.

### 8a. Move a file (`/docs/a.txt → /archive/a.txt`, own content)

- **Action**: Re-place an existing DATA at a new path and revoke the old placement. **Atomic** — the whole sequence is one EAS `multiAttest` (the revoke rides along as a `multiRevoke` in the same wallet flow, or a follow-up tx; sequence it so the new placement lands before the old is dropped, never the reverse — a crash mid-flight must never leave the file at neither path).
- **Precondition (own content only)**: this workflow assumes the attester owns the DATA placement at the source (their own active PIN). Moving **inherited** content — a file you see only because a *lower* lens placed it — cannot suppress the old location today: a revoke only removes *your* edges, and you have none at the source. Suppressing an inherited source requires a WHITEOUT on the old Anchor (ADR-0055, post-freeze). Until WHITEOUT ships, "move" is a **self-owned-content** operation; on inherited content it degrades to "also place at the new path" with the old path still visible from the lower lens.
- **Step 1 — Ensure the destination name anchor**: `resolvePath(archiveFolder, "a.txt")`. If zero, queue an `Anchor(refUID=archiveFolder, name="a.txt", anchorSchema=DATA_SCHEMA_UID)` — non-revocable, persists forever (ADR-0002).
- **Step 2 — New placement PIN**: `PIN(definition=destAnchor, refUID=sameDataUID)`. The DATA UID is unchanged — **DATA, MIRRORs, contentType/contentHash/size PROPERTYs are path-independent and fully preserved** (ADR-0049; they hang off the DATA UID, not the path). No content is re-attested.
- **Step 3 — Ancestor-walk visibility TAGs for the new path**: walk `/archive` up to root exclusive (per workflow 1 step 3 / ADR-0038); emit a `TAG(definition=DATA_SCHEMA_UID, refUID=ancestor)` for each ancestor the attester hasn't already actively tagged. Steady-state zero if `/archive` already holds the attester's content.
- **Step 4 — Revoke the old placement PIN**: `getActivePin(srcAnchor, attester, DATA_SCHEMA_UID)` → `eas.revoke(PIN_SCHEMA_UID, oldPinUID)`. EdgeResolver clears `_activeBySlot[srcAnchor][attester][DATA_SCHEMA]`.
- **Step 5 — Conditional source-folder visibility-TAG revoke (the step clients get wrong)**: revoking the placement PIN does **not** auto-revoke the attester's visibility TAG on the *source folder* — folder visibility is a separate TAG (ADR-0038). Only revoke `TAG(definition=DATA_SCHEMA_UID, refUID=srcFolder)` if, after Step 4, the attester has **no other active placement PIN or visibility TAG anywhere in that folder's subtree** — i.e. the folder is now empty *for this attester*. If the attester still owns sibling content under `/docs`, leave the source-folder TAG in place; revoking it would hide those siblings. **Do not** blindly revoke it on every move. (Note `clearContains` fires kernel-side only when the attester's `_activeTotalByDefAndAttester` for that folder hits zero and clears the *immediate* folder flag only, never ancestors — see EFSIndexer.sol `clearContains` ~L350 and ADR-0010; the lens-visible self-correction is TAG-driven, the sticky `_containsAttestations` flag is not — see Caveat B.)
- **Result**: `a.txt` resolves at `/archive/` for the attester's lens and no longer at `/docs/`. The source name anchor persists as a harmless husk. Rename (8b) is the same mechanism with `srcFolder == destFolder`.

### 8b. Rename a file (`a.txt → b.txt`)

- **Action**: Same mechanism as move (8a) with the **same parent** — new name anchor + re-PIN at the new anchor + revoke the old PIN. One `multiAttest`.
- **Step 1**: Ensure `Anchor(refUID=sameFolder, name="b.txt", DATA_SCHEMA_UID)` (create if absent, non-revocable).
- **Step 2**: `PIN(definition=bAnchor, refUID=sameDataUID)` — DATA/MIRRORs/PROPERTYs preserved (path-independent).
- **Step 3**: No new ancestor-walk needed — the parent folder is already tagged from the original placement.
- **Step 4**: Revoke the old `a.txt` placement PIN.
- **The old name anchor persists forever as a harmless husk** — anchors are non-revocable (ADR-0002). It resolves to nothing (no active PIN) and never reappears in a lens listing. This is expected, not a leak.
- **Not a rename**: changing the `name` *display*-PROPERTY (ADR-0034) is **not** a rename. The path segment and the directory-listing label both come from the **anchor `name` field**, not the display PROPERTY; rebinding the `name` PROPERTY changes a cosmetic label only and leaves the file addressable at the old path segment. A true rename re-PINs onto a new name anchor as above.
- **Inherited content**: same caveat as 8a — renaming an inherited file places `b.txt` but cannot hide the inherited `a.txt` until WHITEOUT (ADR-0055), so the file appears under both names. Self-owned-content only today.

### 8c. Rename / move a FOLDER

- **There is no reparent.** A child anchor binds to its parent by `refUID` at attestation time, and ANCHOR is non-revocable and immutable (ADR-0002) — the parent pointer can never be changed. Renaming or moving a folder is therefore **not** an edit to the folder anchor.
- **Today — full subtree rebuild**: re-create the entire subtree under the new parent/name and revoke the old placements. Per descendant: one new name `Anchor` (if absent) + one re-`PIN` of its DATA at the new anchor + one ancestor-walk visibility `TAG` (deduped per folder) + one `revoke` of the old PIN; plus one visibility-TAG revoke per source folder that empties out (the 8a Step-5 conditional, applied bottom-up). Chunk via `multiAttest` / `multiRevoke` at **~50 ops per tx** (ADR-0026 analog; same chunking as the delete cascade, workflow 8 / 8e). Cost scales with descendant count — expensive for deep trees, by design (archival, not commodity).
- **Same inherited-content caveat**: descendants served from a lower lens can be re-placed under the new folder but not suppressed at the old location until WHITEOUT (ADR-0055).
- **Cheap future path — symlink on the folder anchor**: a single `REDIRECT(refUID=oldFolderAnchor, target=newFolderAnchor, kind=2)` (symlink, ADR-0050) renames/moves a whole subtree with **one** attestation, leaving the children in place. This is **pending the read-time redirect-resolution follower** — the production `EFSRouter` reads only the DATA-pin slot and does **not** follow symlinks yet (ADR-0050 §Symlink/hardlink mapping). The resolution algorithm (lens-scoped follow, depth cap, cycle = lowest-UID-in-SCC) is specified in **specs/09-redirect-resolution.md**; until a client/router implements it, symlink-on-folder does not resolve and the subtree rebuild above is the only working option. Recommend symlink-on-arrival as the default **once the follower ships**; subtree-rebuild is the interim default. (See SPICY note to maintainer.)

### 8d. Delete a file / folder

- **Mental model — unreachable, not erased (state this to users)**: revoke **hides**, it never erases. DATA, ANCHOR, and PROPERTY are **non-revocable** and persist on-chain forever (ADR-0049, ADR-0002, ADR-0052); only the **edges** (PIN, TAG, MIRROR) are revocable. A "delete" revokes the attester's *edges* so the content stops appearing in their lens (default reads exclude revoked, ADR-0051) — the bytes, the identity, and the path husk remain permanently and are reconstructable with `includeRevoked`. For an archival system this is a **user-trust / expectation point**: tell users "delete" means "removed from your view," not "wiped." Only the author can hide their own claims; nobody can erase or hide anyone else's (ADR-0051).
- **Delete a file**: revoke the placement PIN — `getActivePin(pathAnchor, attester, DATA_SCHEMA_UID)` → `eas.revoke(PIN_SCHEMA_UID, pinUID)`. EdgeResolver clears `_activeBySlot`. DATA + MIRRORs + PROPERTYs survive (still reachable from any other path the DATA is pinned at). Then apply the 8a Step-5 conditional source-folder TAG revoke if the folder emptied for this attester.
- **Delete a folder**: revoke the attester's **visibility TAG on the target folder** + every **descendant placement PIN** in the subtree. Batch `multiRevoke`, ~50/tx (ADR-0026 analog). EdgeResolver's `onRevoke` clears the matching `_activeBySlot`/`_activeByAAS` entries; when an attester's active-edge count on an anchor reaches zero, EdgeResolver calls `EFSIndexer.clearContains(anchor, attester)` (EdgeResolver.sol ~L502). **Revoke the TAG on the target folder only — NOT on ancestors.** Revoking an ancestor's visibility TAG would hide sibling content the attester still owns elsewhere under that ancestor. (This is the same rule as workflow 8's "Delete a folder" bullet — see there for the kernel detail.)
- **Inherited / system content**: revoke removes only *your* edges. To delete inherited or `system`-lens content **from your own view**, you attest an additive **WHITEOUT** on the path Anchor (ADR-0055) — a negative terminal in the lens scan that stops fall-through to lower lenses without substituting your own content. **Now implemented** (see workflow 8f). Un-hide = `revoke` the WHITEOUT.
- **Undelete = re-attest at the same slot.** Re-`PIN(definition=anchor, refUID=dataUID)` restores the placement in O(1) (cardinality-1 supersession, ADR-0041); re-`TAG` restores folder visibility. No special "undelete" primitive — the append-only kernel makes resurrection a normal write. (Revoking is one-directional per UID, but a fresh attestation at the same slot is always legal.)

### 8e. Caveats (move / rename / delete / cross-reference)

- **A. Cross-attester hardlink mirror footgun.** If Bob places a PIN onto **Alice's** DATA (hardlinking her file into his lens) but attests no MIRROR/`contentType` of his own, reads scoped to Bob's lens find **no mirror and no contentType under Bob** — mirrors and PROPERTYs are lens-scoped to the winning attester (ADR-0013, ADR-0014). The file resolves to **unreachable bytes / `application/octet-stream`**. Rule: a cross-attester hardlinker **MUST also attest a `MIRROR` (+ a `contentType` PROPERTY) under their own lens**, OR the reader must include the DATA's author in `?lenses=` so the author's mirror/contentType resolve. This applies anywhere a DATA is pinned across an attester boundary (workflow 4 cross-reference, and moves/renames that re-pin someone else's DATA).
- **B. Ghost-folder sticky flag.** `_containsAttestations` is sticky on revoke (ADR-0010): `clearContains` clears only the **immediate** folder flag and only when the attester's active-edge total for it hits zero (EFSIndexer.sol ~L350); **ancestor** flags stay set forever. A schema-blind reader (`getChildrenByAddressList`, `containsSchemaAttestations`) can therefore still report an emptied ancestor folder as "non-empty for this attester." Folder **visibility** in lens listings is TAG-driven (ADR-0038) and self-corrects on TAG revoke, so the directory *listing* is correct — but clients that consult the sticky flag directly should **cross-check for active children** rather than trust it (the ADR-0010 papering-over). Cosmetic, not a correctness bug.

### 8f. Suppress inherited / lower-lens content — the delete verb (WHITEOUT, ADR-0055)

Lenses are additive-only: a lens can ADD content or SHADOW a lower lens by placing its OWN content, but cannot say *"render this path empty in my view; stop the fall-through without substituting my own."* The **WHITEOUT** schema (additive post-freeze, specs/02 §10) adds that negative assertion. The client exposes it as a **single `delete` verb** — the user never picks a marker:

- **`delete(path)` — "this shouldn't be here."** The client **auto-selects the marker**, overlayfs-style. If the entry is the lens's OWN placement, `delete` simply revokes that PIN/TAG (workflow 8d) — which resolves to a **genuine not-found** (no 0-byte sentinel left behind). If the entry is **inherited** (placed by a lower lens / `system`), `delete` attests a **per-name WHITEOUT** on the path Anchor: `eas.attest(WHITEOUT_SCHEMA_UID, { refUID: pathAnchor, data: 0x, revocable: true })`. Read-time, the first lens in the scan with a whiteout terminates resolution with **empty** (404-equivalent) and stops fall-through. Un-delete = `eas.revoke(WHITEOUT_SCHEMA_UID, whiteoutUID)`.
- **Cascade on the last visible child.** When the deleted item was the **last visible child** of an inherited folder, the client also whites out that now-empty folder (and walks up while each parent empties) — overlayfs-style auto-marker management, so an emptied inherited folder also disappears. The user just clicks delete; the client manages the markers.
- **Lens-local for inherited content.** `delete` of inherited content is **lens-local** — you can't globally delete what you don't own (correct for a union / shared FS); the WHITEOUT hides it only for viewers who include your lens. `delete` of your **own** content is a `revoke`, which resolves to genuine not-found.

**"Deleted means gone" is enforced across BOTH listing AND resolution**: `EFSFileView`'s directory listings drop whited entries, AND `EFSRouter`'s path walk applies the same negative terminal so a deep link into a whited path 404s — a viewer cannot bypass a whiteout by deep-linking past the listing. `EFSFileView.getFilesAtPath` applies the identical terminal for view/router consistency.

**Folder re-add (the fix).** A lens that whites out a FOLDER and then re-asserts that folder with its OWN visibility TAG sees it again in listings: the listing predicate's positive terminal is a file PIN **or** a folder visibility TAG (Shape B), so the lens's own positive assertion beats its own earlier whiteout (same-lens override). A single-anchor DATA *lookup* (`getFilesAtPath` / router terminal) stays PIN-gated — the correct overlayfs lookup semantics.

**Out of scope**: **DATA-whiteout** (suppressing a DATA UID directly) is **not** a unionfs concept and is deliberately not built — whiteout suppresses a *path entry within a lens*, not content identity. Suppressing a PROPERTY / MIRROR / another whiteout is rejected at write time. The **opaque-directory variant** (*"show only MY children here"*) is **DEFERRED** (no concrete use case yet; re-adds additively per ADR-0055).

### 9. Resolve Subjective File Content (Lenses)
- **Action**: User wants to load `/pets/best.jpg`, trusting "Vitalik", "LocalDAO", and "Self".
- **Execution**: The client calls `edgeResolver.getActivePinTarget(bestJpgAnchor, attester, DATA_SCHEMA_UID)` for each attester in priority order. Returns the DATA UID actively pinned at that path, or `bytes32(0)` if none.
- **Result**: The first attester with an active DATA placement wins. The client then resolves MIRRORs and PROPERTYs on that DATA UID, scoped to the same attester (ADR-0013, ADR-0014).

### 10. List Merged Directory by Trusted Addresses
- **Action**: User opens `/pets/` and wants to see files uploaded by both "Vitalik" and "Self".
- **Execution**: `efsFileView.getDirectoryPageBySchemaAndAddressList(petsAnchor, DATA_SCHEMA_UID, [vitalik, self], cursor, pageSize)`. EFSFileView iterates child file anchors and merges lens placements internally.
- **Result**: Deduplicated, lens-merged, revocation-filtered list of file anchors under `/pets/` that have active DATA from any listed attester.

### 11. Tag a File (Lens-Specific)
- **Action**: User wants to tag their lens of `/memes/vitalik.jpg` as "funny".
- **Step 1 — Resolve or create the tag definition**: Look up `resolvePath(tagsAnchorUID, "funny")`. If zero, create an Anchor named "funny" under the `/tags/` folder (one EAS `attest` transaction). Tags can be hierarchical (e.g., `/tags/nsfw/orgy/`).
- **Step 2 — Resolve the user's DATA UID**: Call `edgeResolver.getActivePinTarget(anchorUID, connectedAddress, DATA_SCHEMA_UID)` to get the DATA the user has pinned at this anchor.
- **Step 3 — Create the tag**: Create a `TAG(refUID=dataUID, definition=funnyDefUID, weight=1)` attestation. Weight defaults to 1; non-default values are consumer-defined sort/score metadata.
- **Result**: EdgeResolver indexes the tag in `_activeByAAS[funnyDefUID][attester][DATA_SCHEMA]` and registers it in the schema-aware edge slot keyed by `_edgeHash(attester, dataUID, funnyDefUID, TAG_SCHEMA_UID)`. The file appears when filtering by "funny" while viewing this user's lens, but other users' lenses of the same filename are unaffected.

### 12. Remove a Tag
- **Action**: User wants to remove their "nsfw" tag from a file.
- **Step 1 — Find the active tag**: Call `edgeResolver.getActiveEdgeUID(connectedAddress, dataUID, nsfwDefUID, TAG_SCHEMA_UID)` to get the active attestation UID.
- **Step 2 — Revoke it**: Call `eas.revoke(TAG_SCHEMA_UID, activeTagUID)`. EdgeResolver's `onRevoke` swap-and-pops the entry from `_activeByAAS` and clears the schema-aware edge slot. There is no `applies=false` self-revoke path under ADR-0041 — removal is always via `eas.revoke()`.
- **Result**: The tag no longer appears as active. The DATA UID remains in the append-only discovery indices (`getEdgeDefinitions` / `getTargetsByDefinition`) but `getActiveEdgeUID` returns zero and `isActiveEdge` returns false.

### 13. Filter by Tags Across Lenses
- **Action**: User is viewing `/memes/` with `lenses=[Alice, Bob]` and applies tag filter "funny".
- **Resolve**: Look up the "funny" definition UID via `resolvePath(tagsAnchorUID, "funny")`.
- **Filter per DATA** (effective-TAG path, ADR-0042): For each DATA UID surfaced by the directory listing, for each lens attester, call `edgeResolver.getActiveTagEntries(funnyDefUID, attester, DATA_SCHEMA_UID, 0, pageSize)` and include the DATA only if at least one returned entry has `weight >= 0`. This is the **effective TAG** convention: active (unrevoked) TAGs with `weight < 0` are suppressed from include/exclude filters — a `weight < 0` TAG is still on-chain but treated as "hidden" by the client layer. Descriptive file labels are always TAG (cardinality N, ADR-0041).
- **Kernel check alternative**: `edgeResolver.hasActiveTagFromAny(dataUID, funnyDefUID, [alice, bob])` returns true for any unrevoked TAG regardless of weight — use this only when weight-blind activity is what you want (e.g. on-chain guards, indexer logic). Do not use it for the explorer's include/exclude filter.
- **Do not** use raw `getTargetsByDefinition(funnyDefUID, ...)` for this — it is an append-only discovery index that includes revoked edges and edges from untrusted attesters.
- **Result**: Only files where at least one of the viewed lenses has an effective "funny" tag (active, weight ≥ 0) appear in the listing.

### 14. Cross-User Tagging (Curating Someone Else's Content)
- **Action**: User B wants to mark User A's lens of `/memes/cat.gif` as "nsfw".
- **Execution**: User B creates a `TAG(refUID=dataA_UID, definition=nsfwDefUID, weight=1)` attestation against User A's DATA UID.
- **Result**: EdgeResolver indexes the tag in `_activeByAAS[nsfwDefUID][userB][DATA_SCHEMA]` and the schema-aware edge slot. User A's DATA UID now appears in `getTargetsByDefinition(nsfwDefUID)`. When anyone views User A's lens and filters by "nsfw", the file matches. User B's own lens is unaffected. Multiple users can independently tag the same DATA UID; each tag is stored under a separate attester slot.

### 15. "Where does this file live?" (Reverse Lookup)
- **Action**: Given a DATA UID, find all paths where it's been placed by a given attester.
- **Execution**: Read `edgeResolver.getEdgeDefinitions(dataUID, 0, count)` — all definitions (both PIN and TAG) ever applied to the DATA, append-only. For each definition, call `edgeResolver.isActiveEdgeAnySchema(myAddress, dataUID, definition)` to filter to active edges only.
- **Result**: Returns the set of Anchor UIDs where the user has actively placed (PIN) or labeled (TAG) this DATA. O(n) in definitions ever applied; typical files have 1–5 placements plus a handful of labels.

---

## List & Sort Workflows

"List" in EFS spans two **distinct** mechanisms — don't conflate them:

- **Curated lists** — the `LIST` (declaration) + `LIST_ENTRY` (membership) EAS schemas, each with their own resolver (`ListResolver`, `ListEntryResolver`; read via the stateless `ListReader`), per ADR-0044 / ADR-0046. Explicit, per-attester membership with write-time shape enforcement (typed / no-duplicates / append-only / capped). Entry order and free-text label are PIN-bound (cardinality-1) PROPERTYs on each stable `LIST_ENTRY` UID — **not** schema fields, and **not** the sort overlay. Workflows 22–24 below; authoritative model in [Lists and Collections](./06-Lists-and-Collections.md) and [Data Models and Schemas](./02-Data-Models-and-Schemas.md).
- **Sorted directories** — ordering the children of an ordinary directory Anchor via `SORT_INFO` + the shared `EFSSortOverlay` (a kernel overlay keyed by `(sortInfoUID, parentAnchor)`; lens filtering applied at read time). No dedicated list contract is involved here. Workflows 16–21 below; authoritative API in [Sort Overlay Architecture](./07-Sort-Overlay-Architecture.md).

The two compose — a curator can keep a `LIST` *and* expose a sort over a directory — but they are separate primitives with separate contracts.

> **⚠️ Sorted-directory workflows (16–21) are deferred — SORT_INFO is NOT in the Sepolia freeze set.** The freeze registers nine schemas (ANCHOR, DATA, MIRROR, PIN, TAG, PROPERTY, LIST, LIST_ENTRY, REDIRECT); SORT_INFO and `EFSSortOverlay` are **not** registered/deployed by the freeze ceremony (see `specs/overview.md` and `docs/SEPOLIA_FREEZE_TABLE.md`). Workflows 16–21 below describe valid future behavior (authoritative design in [Sort Overlay Architecture](./07-Sort-Overlay-Architecture.md)), but until SORT_INFO is registered post-freeze there is **no `SORT_INFO_SCHEMA_UID` to attest against** — do not treat these as live, and do **not** add SORT_INFO to the freeze as a tenth schema. The curated-list workflows (22–24) are unaffected. (Workflows 22–24 are the live list path.)

### 16. Create a New Sort and Add Items

- **Step 1 — Create the directory**: The list is a normal EFS directory (Anchor). If it doesn't exist yet, attest an Anchor for it under the desired parent.
- **Step 2 — Add items**: For each item, attest an Anchor as a child of the list directory. Set `anchorSchema = DATA_SCHEMA_UID` for file items. Items accumulate in the kernel in insertion order.
- **Step 3 — Create a sort**: Attest an Anchor for the sort name (e.g. "alphabetical") under the list directory with `anchorSchema = SORT_INFO_SCHEMA_UID` as the naming anchor. Then attest a SORT_INFO attestation with `refUID = namingAnchorUID`, `sortFunc = <ISortFunc address>`, `targetSchema = bytes32(0)` (or restrict to a specific schema).
- **Step 4 — Populate the sort**: Call `EFSSortOverlay.processItems(sortInfoUID, parentAnchor, expectedStartIndex, items, leftHints, rightHints)`. See workflow 17 for the hint computation algorithm.
- **Result**: Items are pageable via `getSortedChunk(sortInfoUID, parentAnchor, bytes32(0), 10, false)`. The sorted list is shared — all attesters contribute to a single ordering per `(sortInfoUID, parentAnchor)`. Lens filtering is applied at read time via `getSortedChunkByAddressList`.

### 17. Populate a Sort (processItems Client Algorithm)

`processItems` requires the client to supply position hints for each new item. The full algorithm:

**Inputs:**
- `sortInfoUID` — the SORT_INFO attestation UID
- `parentAnchor` — the directory anchor the sort belongs to (read from `SortConfig.parentUID`)

Note: the sorted list is **shared across attesters** — `processItems` is keyed by `(sortInfoUID, parentAnchor)`, not by `attester`. Lens filtering is applied at read time.

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
- **Step 1**: Call `getSortedChunk(sortInfoUID, parentAnchor, bytes32(0), 20, false)` → returns `items[0..19]` and `nextCursor`. To filter by attester/lens, use `getSortedChunkByAddressList(sortInfoUID, parentAnchor, bytes32(0), 20, attesters)` instead.
- **Step 2**: On scroll, call `getSortedChunk(sortInfoUID, parentAnchor, nextCursor, 20, false)` → next page.
- **Step 3**: For each item UID, resolve content via EdgeResolver queries and MIRROR resolution.
- **Staleness check**: Call `getSortStaleness(sortInfoUID, parentAnchor)` before rendering. If `> 0`, prompt the user: "N items unprocessed — pay gas to update sort?".
- **Key rule**: Pin `blockNumber` in `eth_call` across all pages in a session to prevent cursor drift from concurrent `processItems` calls.

### 19. Remove a List Item

- **Action**: Remove a file from a path or revoke an Anchor.
- **PIN replace or revoke**: To swap the active DATA at a path, attest a new `PIN(definition=path Anchor, refUID=newDataUID)` — the new PIN automatically supersedes the prior one in O(1) at the same `(attester, definition, targetSchema)` slot. To remove the placement entirely, fetch the active PIN UID via `edgeResolver.getActivePin(pathAnchor, attester, DATA_SCHEMA_UID)` and `eas.revoke(PIN_SCHEMA_UID, activePinUID)` — EdgeResolver clears `_activeBySlot`. DATA + mirrors + metadata survive at other paths. Both paths leave the prior PIN UID in the append-only discovery list.
- **Anchor revoke**: anchors are non-revocable under ADR-0002 (file anchors and folder anchors persist forever in the kernel). To make an anchor disappear from a viewer's lens, revoke their visibility/placement edges instead. Sort overlay items that are visible only because of an active PIN/TAG will fall out of lens-filtered views once those edges are revoked.
- **Sort overlay**: Items already processed into a sorted linked list remain there — the overlay is a snapshot. The UI should check edge activeness via EdgeResolver and treat anchors with no active edges from the trusted lenses as hidden.

### 20. View a Merged Sorted List from Multiple Attesters

- **Action**: SPA displays a sorted list filtered to Alice's and Bob's contributions.
- **Shared list model**: The sorted linked list is shared — all attesters contribute items to a single ordering keyed by `(sortInfoUID, parentAnchor)`. Lens filtering is applied at read time, not at write time.
- **Step 1**: Call `getSortedChunkByAddressList(sortInfoUID, parentAnchor, bytes32(0), 20, [alice, bob])` → returns only items contributed by Alice or Bob, in sorted order.
- **Step 2**: On scroll, pass the returned `nextCursor` to the next call.
- **Step 3**: For each item UID, resolve content via EdgeResolver queries and MIRROR resolution.
- **Result**: Single sorted list on-chain; attester filtering is a read-time concern. See [Sort Overlay Architecture](./07-Sort-Overlay-Architecture.md) for the authoritative API reference.

### 21. Restrict a Sort to a Specific Schema

- **Action**: Create a sort that only orders file anchors (ignoring sort naming anchors, property anchors, etc.).
- **Step 1**: When creating the SORT_INFO, set `targetSchema = DATA_SCHEMA_UID`.
- **Enforcement**: `ISortFunc.getSortKey` returns empty bytes for items whose schema doesn't match `targetSchema`. The overlay skips them automatically (empty key = ineligible), so they never appear in the sorted list.
- **Result**: Only Anchors with `anchorSchema == DATA_SCHEMA_UID` appear in the sorted view. Sort naming Anchors and other meta-anchors are automatically excluded.

### 22. Create a Curated List (LIST) and Add Entries (LIST_ENTRY)

- **Action**: A curator creates an explicit, shape-enforced collection (ADR-0044, ADR-0046).
- **Step 1 — Declare the list**: Attest a `LIST` (non-revocable) fixing the shape: `allowsDuplicates`, `appendOnly`, `targetType` (ANY=0 / ADDR=1 / SCHEMA=2), `targetSchema` (the required schema UID when `targetType=SCHEMA`, else `bytes32(0)`), `maxEntries` (uint256 cap; 0 = uncapped). `ListResolver` validates the shape at write time. The LIST UID is the permanent collection identity (like DATA).
- **Step 2 — (optional) Name the list**: Bind a `name` PROPERTY onto the LIST UID via PIN for a human label (ADR-0034 convention).
- **Step 3 — Add an entry**: Attest a `LIST_ENTRY(listUID, target)` (revocable). The member is encoded per the LIST's `targetType` — ANY: opaque nonzero key in `target`; ADDR: address in the EAS `recipient` field with `target = bytes32(0)`; SCHEMA: the member attestation UID in `target` (must exist, schema must match). `ListEntryResolver` enforces type / no-duplicates / append-only / cap against the **caller's own lens** and records it in the per-attester `EntryRecord[]`. The entry UID is stable membership identity.
- **Step 4 — (optional) Set order / label**: Bind PIN PROPERTYs onto the **entry UID** — order under the `weight` key anchor, free text under `name` / `description`. Cardinality-1, so re-attesting supersedes in O(1) without touching membership.
- **Result**: `ListReader.entries(listUID, attester, start, len)` pages the curator's entries; `ListReader.length` / `countOf` / `getMode` expose count and shape. Reads are lens-scoped — each attester sees only their own entries.

### 23. Reorder or Relabel a List Entry

- **Reorder**: Re-attest the order PROPERTY (the `weight`-key PIN) on the entry UID with a new value. Membership and the entry UID are untouched — ADR-0046 deliberately moved order *off* the entry so reordering never orphans it (the footgun the original weight-field design carried).
- **Relabel**: Re-attest the `name` / `description` PROPERTY PIN on the entry UID. Same O(1) supersession.

### 24. Remove a List Entry

- **Action**: Drop a member from a curated list.
- **Revoke**: `eas.revoke(LIST_ENTRY_SCHEMA_UID, entryUID)`. `ListEntryResolver.onRevoke` removes it from the attester's `EntryRecord[]` via swap-and-pop. **Blocked** (`ListIsAppendOnly`) when the LIST was declared `appendOnly`.
- **Order/label PROPERTYs** on the revoked entry UID become inert (the entry is gone); no separate cleanup is required.
