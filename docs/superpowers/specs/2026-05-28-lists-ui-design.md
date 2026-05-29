# Lists UI Design

**Date:** 2026-05-28  
**Status:** Approved for implementation  
**Branch:** custom-lists  
**Governing ADR:** ADR-0044 (LIST + LIST_ENTRY schemas)  

> **Pivot note (mid-session):** The primary creation path is the **File Explorer**, not the `/lists` index page. End users create lists via **+ Add ▾ → List** in `FileActionsBar.tsx`, which opens `CreateItemModal.tsx`. The `/lists` index page retains its create form as a **dev tools / nice-to-have** surface (useful for script-level testing), but it is not the primary UX and is lower-priority. The detail page at `/lists/[listUID]` remains the canonical post-create destination for both paths.

---

## Goal

Rework the two existing Lists pages (`/lists` and `/lists/[listUID]`) in the Scaffold-ETH debug UI into a fully functional, correctly wired devtools interface for the EFS Lists primitive. The design must be accurate enough to directly inform the production Vite/Lit client.

## Context

### What exists

Two pages were built as part of the ADR-0044 implementation task:

- `packages/nextjs/app/lists/page.tsx` — Create list form + lookup by UID
- `packages/nextjs/app/lists/[listUID]/page.tsx` — Detail page: mode info, entry table, add/remove form

### What's broken or missing

Verified by live inspection on the running devnet:

| Issue | Severity |
|-------|----------|
| Detail page 500s in dev: `"use client"` + `generateStaticParams` in same file | **Blocker** (already fixed in this session) |
| Trailing slash in `usePathname()` causes `listUID = ""` → "Loading…" forever | **Blocker** (already fixed) |
| Post-create shows tx hash, not the attestation UID | High |
| `lensAddress` hardcoded to connected wallet — no way to view other attesters | High |
| `length` query not refetched after add/remove — stale count in mode card | Medium |
| `refetchEntries` uses `setTimeout(2000)` — brittle, misses slow blocks | Medium |
| REMOVE button shown for all entries regardless of who created them | Medium |
| React key is array index, not `entryUID` | Low |
| EAS address hardcoded to Sepolia mainnet | Low |

### Three list modes (ADR-0044)

- **ANY (0)** — opaque `bytes32` member key; `target` field; `recipient = 0x0`
- **ADDR (1)** — Ethereum address; encoded in `recipient`; `target = 0x0`
- **SCHEMA (2)** — attestation UID matching `targetSchema`; in `target`; `recipient = 0x0`

### Multi-lens semantics (ADR-0031/ADR-0044)

Lists are **per-attester**. `length(listUID, attester)` and `entries(listUID, attester, ...)` always take a single attester address. Multi-lens resolution (first attester with `length > 0` wins the whole read) is a client/SDK concern, not a contract concern. The debug UI must make this visible: switching the "viewing as" address switches the entire entries view.

---

## Architecture

### File changes

```
packages/nextjs/
├── components/explorer/
│   ├── FileActionsBar.tsx      # + Add ▾ dropdown: Folder / File / List  [BUILT]
│   └── CreateItemModal.tsx     # "List" CreationType: mode picker, Rules, Create → /lists/[uid]  [BUILT]
└── app/lists/
    ├── page.tsx                # Lists index — create + recent  [dev tools / nice-to-have]
    └── [listUID]/
        ├── page.tsx            # Server wrapper (generateStaticParams only)  [BUILT]
        └── ListDetailClient.tsx  # "use client" — all hooks and UI  [BUILT, bugs fixed]
```

**Primary creation path (implemented):** File Explorer → **+ Add ▾ → List** → `CreateItemModal` with mode picker (Addresses / Custom Keys / EFS Files), Rules section, Create List button. On success, navigates to `/lists/[uid]`.

**Detail page fixes (implemented):**
- EAS address now read from contract via `getEAS()` — no longer hardcoded to Sepolia mainnet
- `setTimeout` replaced with `useWaitForTransactionReceipt` for mutation refetch
- `entryUID` used as React key instead of array index

`page.tsx` for the server wrapper is already split (done in this session). `page.tsx` for the index page stays a client component (no dynamic route, no `generateStaticParams` needed).

The EAS address must come from `useScaffoldReadContract({ contractName: "Indexer", functionName: "getEAS" })` — matching the pattern in `ExplorerClient.tsx`. **Do not hardcode the Sepolia mainnet address** — the devnet uses the same address only because it forks Sepolia; this is not a guarantee for arbitrary networks.

### Shared utilities (new, in same directory or `~~/utils/lists.ts`)

```ts
// Decode the Attested event UID from a transaction receipt
function extractAttestedUID(receipt: TransactionReceipt): `0x${string}` | null

// EAS ABI (attest + revoke) — deduplicate from both pages
const EAS_ABI = [...] as const

// ListReader ABI (getMode, length, entries, LIST_ENTRY_SCHEMA_UID) — deduplicate
const LIST_READER_ABI = [...] as const

// Target type labels
const TARGET_TYPE_LABELS = { 0: "ANY", 1: "ADDR", 2: "SCHEMA" }
```

---

## Page 1: `/lists` — Lists Index *(dev tools / nice-to-have — not primary UX)*

### Layout

```
[Lists Debug]                                  // h1

[Contract status bar]                          // ListReader addr, schema UIDs, or warning

[Create List card]
  Mode selector (pill tabs: Addresses · EFS Files · Custom Keys)
  ─── conditional on mode ───
  ADDR: just checkboxes + maxEntries
  SCHEMA: targetSchema UID input
  ANY: just checkboxes + maxEntries
  ─── always visible ───
  ▶ Rules (collapsed by default)
    ☐ Allow duplicates
    ☐ Append-only (entries permanent once cast)
    Max entries [____] (0 = unlimited)
  [Create List]

[Post-create success state — replaces button area]
  ✅ List created
  UID: 0xabc123… [copy] 
  [View List →]                                // links to /lists/0xabc123…

[Your Lists section]                           // query Attested events, attester=connected
  Table: UID (truncated) | Mode | Entries | Created | →
  Empty state: "No lists yet. Create one above."
```

### Create flow details

**Mode selector:** three pill tabs. ADDR selected by default.
- **Addresses** → targetType = 1. Show: rules toggle only.  
- **EFS Files** → targetType = 2. Show: "Target Schema UID" input (required) + rules toggle.  
- **Custom Keys** → targetType = 0. Show: rules toggle only.

**Post-create:** use `useWaitForTransactionReceipt` to watch the tx hash returned by `writeContractAsync`. When receipt arrives, decode the `Attested(address,address,bytes32,bytes32)` event to extract the UID. Show the success state; clear the form. The "Your Lists" section should refetch after success.

**Your Lists:** Use `usePublicClient().getLogs` with the `Attested` event filtered to `schema = LIST_SCHEMA_UID` and `attester = connectedAddress`, paginated (last 20, reverse-chron). Each row shows: truncated UID, mode badge, "—" for entries (lazy, don't fetch counts for the table), timestamp, → link. Clicking the row navigates to `/lists/[uid]`.

---

## Page 2: `/lists/[listUID]` — List Detail

### Layout

```
[List Detail]                                  // h1
[0xabc123…full UID] [copy button]             // copyable UID

[Mode card]
  Curator | Target Type badge | Allows Dupes | Append Only | Max Entries

[Append-only banner]                           // shown only when appendOnly = true
  🔒 Append-only — entries cannot be removed once added.

[Attester lens picker]
  "Viewing entries from:"
  [You (0x90F7…)] [alice.eth] [0xb0b…] [+ Custom address…]
  ↑ tabs, "You" always first; others discovered from ListEntryAttested events for this listUID

[Entry count for selected lens]
  N entries   (live from length() call for the selected lens address)

[Entries table]
  Entry UID | Identity Key (decoded) | Weight | Remove?
  Paginated: 25 per page, Prev / Next
  Remove button: shown only on "You" tab (entries attested by connectedAddress)

[Empty state]
  "No entries from [lens] yet."
  If lens is "You": also show "Add your first entry below."

[Add Entry card]                               // always visible when mode.exists
  Mode hint: "ANY — any nonzero bytes32 key" etc.
  Input: address field (ADDR) | bytes32 field (ANY/SCHEMA)
  Weight input (int256, default 0)
    Hint: "Positive = member, negative = suppressed (still on-chain)"
  [Add Entry]
```

### Lens picker details

- **"You" tab:** always present. Label = "You (0xshort…)". If not connected, label = "Not connected".
- **Discovered tabs:** query `ListEntryAttested(listUID indexed)` events, collect unique `attester` addresses, exclude `connectedAddress` (already "You"), show up to 4 additional tabs. If more exist, show "…more" that expands.
- **Custom tab:** text input for any address. No discovery needed.
- Switching lens tabs re-fetches `length` and `entries` for the new address. Active lens address stored in component state.

### Entry table details

- **Identity Key decoding:**  
  - ADDR mode: render as `0x` + last 20 bytes of the bytes32, truncated as an address (`0xdead…beef`)  
  - SCHEMA mode: truncated bytes32 UID  
  - ANY mode: truncated bytes32  
- **Remove button:** visible only on the "You" tab. Calls `eas.revoke()` with the entry's UID. After confirmed, refetches both `length` and `entries` for the current lens.
- **React key:** use `e.entryUID`, not array index.
- **Pagination:** 25 entries per page. Pass `start = page * 25, len = 25` to `entries()`. Show Prev/Next, disable at boundaries.

### Refetch after mutations

Replace `setTimeout(() => refetchEntries(), 2000)` with:

```ts
const { data: receipt } = useWaitForTransactionReceipt({ hash: pendingTxHash })
useEffect(() => {
  if (receipt) {
    refetchLength()
    refetchEntries()
    setPendingTxHash(undefined)
  }
}, [receipt])
```

This correctly awaits confirmation before refreshing, works on slow blocks, and refetches both queries (fixing the stale "Length" count).

---

## What this informs for the production client

The production Vite/Lit client should implement:

- **SCHEMA-mode lists surface in the explorer** alongside the EFS attestations they curate. When browsing a folder, SCHEMA-mode lists that target the DATA schema and reference files in that folder appear as a "curated by" sidebar.
- **Lens stack builder** (URL-based `?lenses=alice,bob`) rather than attester tabs — the URL is shareable and matches ADR-0031 semantics exactly.
- **Context-aware create:** from the explorer, mode defaults to SCHEMA with the visible schema pre-filled; from a wallet page, defaults to ADDR.
- **ANY-mode helper:** text input → keccak256 → bytes32, so non-technical users can create named keys.

These are **not** built in the devtools UI (scope would be too large) but should be documented here so the Vite/Lit client team has the design rationale.

---

## What is explicitly out of scope

- ENS resolution on identity keys
- Bulk add (paste list of addresses/UIDs)
- Drag-to-reorder lens stack
- SCHEMA-mode browse picker (attestation UID from explorer)
- ANY-mode keccak256 helper
- Deep-link `?lens=` URL param on detail page

These are all in `docs/FUTURE_WORK.md` under "Lists UI — production client features".

---

## Verification checklist

**File Explorer create path (primary UX):**
- [x] File Explorer → + Add ▾ → List → CreateItemModal opens with mode picker (Addresses / Custom Keys / EFS Files)
- [x] CreateItemModal: Create List → tx confirms → navigates to `/lists/[uid]`
- [x] Detail page loads at that UID without 500 error

**Detail page mutations:**
- [x] Add Entry → tx confirms → length updates (useWaitForTransactionReceipt, not setTimeout)
- [x] Entries table renders with `entryUID` as React key (no console index-key warning)
- [ ] Remove works; length updates after remove
- [ ] Detail page: add a second wallet's address manually in "Custom" tab → shows their entries (or empty)
- [ ] appendOnly list: Remove button absent, banner shown

**`/lists` index page (dev tools / nice-to-have):**
- [ ] Create ADDR list → tx confirms → UID surfaced with copy button → View List navigates correctly
- [ ] Create SCHEMA list → targetSchema required validation fires on empty → create succeeds with valid UID

**Code quality:**
- [x] No hardcoded Sepolia EAS address in source
- [ ] `yarn next:check-types` passes
