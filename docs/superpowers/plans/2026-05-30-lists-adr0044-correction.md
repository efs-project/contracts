# Lists correction → ADR-0044 alignment (loop plan)

**Goal:** undo the divergent lists-in-folder implementation and make lists behave per ADR-0044 §1/§7 + the user's model: placed like files (`Anchor → PIN → LIST`, **deletable by revoking the PIN**), item names resolved from the referenced entity, free text via a `name` PROPERTY, plus a lens/editions picker. **Contracts already reverted to clean ADR-0044 — the rest is client-only** (PIN→LIST is supported by EdgeResolver with no change).

## Confirmed model
- **Create** a list "groceries" in folder F (attester A):
  1. `ANCHOR(name, anchorType=LIST_SCHEMA_UID, refUID=F)` → listAnchorUID  *(named slot; name validated like a filename)*
  2. `LIST(refUID=0, config = allowsDuplicates,appendOnly,targetType,targetSchema,maxEntries)` → listUID
  3. `PIN(definition=listAnchorUID, refUID=listUID)` → places it. EdgeResolver stores `_activeBySlot[listAnchor][A][LIST_SCHEMA_UID]`.
- **Surface:** existing `EFSFileView.getDirectoryPageBySchemaAndAddressList(F, LIST_SCHEMA_UID, lenses, cursor, n)` returns list-slot anchors (schema=LIST_SCHEMA_UID), lens-scoped — mirrors files.
- **Open:** `EdgeResolver.getActivePinTarget(listAnchor, attester, LIST_SCHEMA_UID)` → listUID → ListPreviewPane(listUID).
- **Delete:** `getActivePinSlot(listAnchor, attester, LIST_SCHEMA_UID).pinUID` → `eas.revoke(PIN_SCHEMA, pinUID)`. Anchor + LIST stay; placement gone → disappears (exactly like a file).
- **Item names:** ADDR → ENS/address; SCHEMA → resolve target attestation (if ANCHOR, its name/`name` PROPERTY); ANY → a `name` PROPERTY on the LIST_ENTRY (free text, arbitrary length). Reference items = 1 tx; free-text = entry + name-PROPERTY pattern (~4 tx, accepted; batch-gateway is FUTURE_WORK).
- **Lens/editions:** picker of attesters with entries (+ you + custom); default to curator when viewing; `entries(listUID, selectedLens)`; editing only for your own lens.

## Files / changes
1. **CreateItemModal.tsx `handleCreateList`** — replace single-LIST(refUID=parent,name) attest with: ANCHOR(anchorType=LIST_SCHEMA_UID) + LIST(5-field config, refUID=0) + PIN(def=anchor, ref=LIST). Validate the list name as an anchor name (reuse `validateAnchorName`). Drop the `name` field from LIST encoding. `onListCreated(anchorUID)`.
2. **FileBrowser.tsx** — remove `getListsAtParent`/`GET_LISTS_ABI`/`rawListItems`. Fetch list anchors via `getDirectoryPageBySchemaAndAddressList(parent, LIST_SCHEMA_UID, lenses,…)` (second directory query, reuse hook or direct). Merge into grid as list cards. Click → resolve PIN→LIST → `setSelectedList({anchorUID, listUID, name, attester})`. Add delete-list (revoke PIN) to the trash action. Pass resolved `listUID` to ListPreviewPane.
3. **ListPreviewPane.tsx** — prop `uid` becomes the resolved LIST UID. Add: SCHEMA-entry name resolution (fetch target attestation → anchor name); ANY free-text via `name` PROPERTY (write on add, read on display); lens/editions picker (default curator, switch lens, edit-only-own).
4. **efsTypes.ts** — `isList` unchanged.
5. **decisions.md / FUTURE_WORK** — supersede the 2026-05-29 bytes32-packing entry; record the corrected model. No new ADR (un-diverging back to ADR-0044; free text = §7).

## Then
- Redeploy (regenerate deployedContracts.ts with ADR-0044 ABIs) against the running fork; verify pin-check.
- Browser test (lenses + lists): create → appears → open → add ADDR/SCHEMA/free-text → names resolve → reorder → **delete (PIN revoke) → disappears** → lens picker shows another attester's entries.
- Review subagent pass → PR.

## SCOPE DECISION (free text) — flag for human
While planning Phase 4 I found a real conflict: the agreed "name PROPERTY per entry" for free text **breaks weight-based reorder**. ADR-0044 §7: reorder mints a new entry UID and **orphans attached metadata** (the name PROPERTY), so a reordered free-text item would lose its text. Clean fixes: (a) a `string` field on LIST_ENTRY — text rides the entry, survives reorder, 1 tx (but a LIST_ENTRY schema-UID change = **Tier-1, needs human OK to supersede ADR-0044 §4/§7**); or (b) SortOverlay-based reorder (complex). bytes32-packing (current) is reorder-safe (text = identity key) but caps at 31 bytes.

**This PR keeps the current bytes32-packed free text (reorder-safe, ≤31 bytes) and ships the placement/delete/lenses/name-resolution corrections.** Removing the 31-byte limit is deferred to a human decision: recommend (a) the `string` field on LIST_ENTRY. Surface this in the PR + chat.

## Status
- [x] Phase 1: contracts reverted to ADR-0044 (7 files via `git checkout 187dbe0^`)
- [x] Phase 2: CreateItemModal create-flow (ANCHOR anchorType=LIST + LIST 5-field + PIN). NOTE: `parseAbiItem`/`decodeEventLog` imports may now be unused — clean in the typecheck pass.
- [x] Phase 3: FileBrowser surfacing + delete — DONE. Old `getListsAtParent` removed; lens-path 2nd `useLensesDirectoryPage(LIST_SCHEMA_UID)` merged into rawItems (standard path already includes list anchors); grid filter + cards include `isList`; `openList` resolves `getActivePinTarget`→listUID; `deleteList` revokes the placement PIN via `getActivePinSlot`. `selectedList = {uid:listUID, anchorUID, name, attester}`. type/lint clean.
- [x] Phase 4: ListPreviewPane — DONE. Lens/editions picker (contributor discovery via ListEntryAttested getLogs, default→curator, edit-only-own `viewingOwn`, read-only banner + "switch to yours"); SCHEMA-entry name resolution (decode anchor `(string,bytes32)` → show name, fallback short UID). Kept bytes32 free-text. type/lint/22-unit-tests green.
- [x] Phase 5: redeploy + browser test — DONE. Fresh fork deployed reverted contracts; deployedContracts.ts regenerated (202 ABI deletions, addresses unchanged/nonce-based). Browser-verified: create list (anchor+PIN→card), open (PIN→LIST), add item, **delete (PIN revoke → disappears)**, **editions picker** with 2 contributors (default→curator, switch edition → read-only banner + "switch to yours", shows their content). Fixed a discovery bug: getLogs fromBlock 0 forwards pre-fork range to upstream (400) → now shrinking-window retry (full history on real chains, recent-local on forks).
- [ ] Phase 6: docs + review + PR
