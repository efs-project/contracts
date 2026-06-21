# EFS at a glance

One-screen summary of current architecture. This is the **canonical quick reference**: if code changes any of this, update here in the same PR.

For depth, see the numbered specs. For historical reasoning (why we chose X over Y), see `docs/adr/`.

## What EFS is

EFS (Ethereum File System) is an on-chain file system built on EAS (Ethereum Attestation Service). Files, folders, and the links between them are expressed as EAS attestations. Content can be stored on-chain via SSTORE2 or off-chain via IPFS, Arweave, HTTPS, or BitTorrent — the router resolves whichever is best.

The point is **permanent, credibly neutral archival**. Anyone can publish. Anyone can curate. No central party can silently revise what was published. Once deployed, EFS itself cannot be upgraded (see "Load-bearing invariants" below).

## Three-layer model

**Anchors** (paths) → **DATA** (content identity) → **MIRRORs** (retrieval URIs)

- **Anchors** are path nodes. Hierarchical (`refUID` points to the parent anchor). Permanent and non-revocable — once a folder exists, it exists forever.
- **DATA** is standalone file identity: an **empty** attestation (pure identity, ADR-0049) — its UID *is* the file's identity. It carries no fields; `contentHash` and `size` are reserved-key PROPERTYs bound to the DATA UID (lens-scoped per attester), not DATA fields. DATA does NOT belong to any specific path. Multiple paths can reference the same DATA.
- **MIRRORs** are retrieval URIs. Each MIRROR references a DATA via `refUID` and carries one URI. Multiple MIRRORs per DATA (ipfs://, ar://, web3://, https://, magnet:) let the router pick the best available transport.

**Edge attestations** (PIN, TAG) are the glue: `PIN(definition=anchorUID, refUID=dataUID, attester=alice)` means "Alice says this DATA lives at this path." Edges enable cross-referencing (same DATA at many paths) and per-attester **lenses** (next section). The two edge schemas differ only in cardinality (ADR-0041):

- **PIN** — cardinality 1. Used for file placement, PROPERTY value binding, and any predicate where one slot holds one thing. Re-attesting at the same `(attester, definition, targetSchema)` slot supersedes the prior PIN in O(1).
- **TAG** — cardinality N. Used for folder visibility, descriptive labels, and any predicate where one slot accumulates many entries. Each entry carries an `int256 weight` for sort/score/ranking metadata.

Removal is always via `eas.revoke()` — there is no `applies=false` mechanism (removed in ADR-0041). PIN supersession is automatic when re-attesting at the same slot with a different target.

Content-addressed dedup is no longer intrinsic (ADR-0049): DATA carries no hash, so identical bytes produce distinct DATA UIDs. Dedup *prevention* is best-effort client-side — query the property index for a trusted `contentHash` claim before upload and, if found, hardlink (a new PIN to the existing DATA) instead of minting a new DATA. Dedup *resolution* (point a duplicate at a canonical DATA) is the REDIRECT primitive (ADR-0050).

## Lenses (whose content are you looking at?)

Multiple attesters can place different DATA at the same Anchor. The
router resolves which to serve via a URL parameter:

    web3://<router>/docs/readme.md?lenses=alice.eth,bob.eth

Each address in the list is a *lens* — a trusted attester whose
attestations contribute to your view. The ordered list is your *lenses*.
Lenses are tried in order; the first lens with active content at that
path wins (first-attester-wins fallback, per ADR-0031). Alice's
`readme.md` is served if she has any; otherwise Bob's. For properties
and configs, lenses compose — overrides cascade through the list.

Without `?lenses=`, the router falls back to `?caller=` (the requesting
address), then to **`system`** as the final default lens. `system` is the
`SystemAccount` contract (ADR-0053) — a neutral, code-governed identity
that authors the canonical bootstrap structure (root, `/transports/*`) and
official defaults. It is the **last default lens**, default-on but
**user-removable and not reorderable**: a user can drop it (losing the
fallback) but can never move it ahead of their own content, so it is purely
additive (first-attester-wins, ADR-0031) — it fills gaps, never shadows
your content. It **replaces the old deployer-EOA fallback** (ADR-0016/0039).
EFS.eth is just-another-user: opinionated/curated data is a normal opt-in
lens, with no special system power. **Nobody sees foreign content unless
they explicitly opt in** — viewer sovereignty is a core design property.

Reads are lens-scoped beyond just TAG resolution: mirrors and PROPERTYs
on a DATA are also filtered to the winning attester. This prevents third
parties from injecting a malicious mirror or a bogus `contentType` onto
someone else's DATA.

> *Note for readers encountering the term "edition" / "editions" in external
> references, git history, or cached EFS documentation: that was the previous
> name for this concept. ADR-0043 (2026-05-05) renamed it to "lenses" across
> the entire codebase, including ADRs 0013, 0014, 0026, 0031, and 0039.*

## Nine frozen EAS schemas

The Sepolia freeze set is **nine** schemas: ANCHOR, DATA, MIRROR, PIN, TAG, PROPERTY, LIST, LIST_ENTRY, REDIRECT. SORT_INFO is **deferred** — not in the freeze set (see its row below); it remains a working overlay design (`07-Sort-Overlay-Architecture.md`) but is not registered as a frozen schema in this set.

| Schema | Revocable | Purpose |
|---|---|---|
| ANCHOR | no | Paths. Hierarchical via `refUID = parentAnchor`. |
| DATA | no | Content identity — **empty schema** (`""`, pure identity, ADR-0049). Standalone (`refUID = 0x0`). `contentHash`/`size` are reserved-key PROPERTYs bound to the DATA UID, not fields. |
| MIRROR | yes | Retrieval URI for a DATA. Multiple allowed per DATA. |
| **PIN** | yes | Cardinality-1 edge. Places one thing per `(attester, definition, targetSchema)` slot. File placement, PROPERTY value binding (`contentType`, `name`, …). Re-attesting supersedes in O(1). ADR-0041. |
| **TAG** | yes | Cardinality-N edge. Accumulates entries per slot. Folder visibility (ADR-0038), descriptive labels (`#nsfw`, …), schema-alias discovery. Each entry carries an `int256 weight` for sort/score metadata. ADR-0041. Active = unrevoked (kernel). For the explorer label-filter, *effective* = active with `weight >= 0` (ADR-0042); on-chain consumers can apply a caller-chosen `weight >= minWeight` threshold via `EFSFileView.getDirectoryPageFiltered` (ADR-0054) — the kernel still never interprets weight. |
| PROPERTY | no | Free-floating string value, placed on a container via PIN under a PROPERTY-typed "key" anchor (ADR-0035 → ADR-0041). A non-revocable *interned value* — dumb shared content (an "anchor for a string"), not a claim (ADR-0052); the revocable claim is the PIN, so removal/change happens at the binding, never the value. Reserved key anchor names: `contentType` (ADR-0005), `name` (ADR-0034). |
| SORT_INFO | yes | **Deferred — NOT in the Sepolia freeze set.** Declares a sort scheme for a folder (sort function + target schema). Working overlay design (`07-Sort-Overlay-Architecture.md`); not frozen in this set. |
| **LIST** | no | Curated collection declaration. Permanent identity (like DATA). Fields: `bool allowsDuplicates, bool appendOnly, uint8 targetType, bytes32 targetSchema, uint256 maxEntries`. Three modes: ANY (0), ADDR (1), SCHEMA (2). Enforced by ListResolver. ADR-0044, ADR-0047. |
| **LIST_ENTRY** | yes | Member entry in a LIST — pure membership identity. Fields: `bytes32 listUID, bytes32 target` (ADR-0046; order + free-text label are PIN-bound PROPERTYs on the stable entry UID, not fields). Per-attester lens storage with wide EntryRecord[] for O(N) on-chain iteration. Enforced by ListEntryResolver. ADR-0044, ADR-0046. |
| **REDIRECT** | yes | Trust-scoped "this points at that" — canonical/dedup (`sameAs`), version supersession (`supersededBy`), path symlinks. Fields: `bytes32 target, uint16 kind` (FROZEN). `refUID` = source. Kinds `0=sameAs / 1=supersededBy / 2=symlink / 3+=reserved` (taxonomy is resolver+client logic, not in the UID). Write-time guards only (no self-loop, per-kind typing) by AliasResolver; read-time multi-hop resolution is client/spec. ADR-0050. |

Full field definitions and resolver wiring: `02-Data-Models-and-Schemas.md`.

**Cardinality lives in the schema UID** (ADR-0041). PIN and TAG share one resolver contract but distinct schema UIDs. Smart-contract readers and subgraph indexers see the schema UID and know whether to call a singular or list-shaped reader — zero EFS-specific decoding.

## Core contracts

| Contract | Role | State | Redeployable |
|---|---|---|---|
| EFSIndexer | Append-only kernel. All indices, path resolution, revocation tracking. | Yes (heavy) | No — schema UIDs encode its address |
| EFSRouter | `web3://` URI resolution (ERC-5219). Lens-scoped content serving. | No | Yes — but URIs change |
| EFSFileView | Directory listing views over EFSIndexer + EdgeResolver. | No | Yes — fully stateless |
| EdgeResolver | PIN + TAG schema hooks (ADR-0041). `_activeBySlot` for PIN (O(1) singleton); `_activeByAAS` (struct-of-tuple) for TAG. | Yes | No — wired into EFSIndexer |
| MirrorResolver | MIRROR schema hook. Transport-ancestry + non-empty/length checks; **no URI scheme allowlist** (ADR-0056 — scheme/render safety is the client's job). | Minimal | No — wired into EFSIndexer |
| EFSSortOverlay | Per-parent sorted linked lists. Lazy overlay on EFSIndexer. | Yes | No — wired into EFSIndexer |
| ListResolver | LIST schema hook. Validates shape; no state. | No | No — baked into LIST_SCHEMA_UID at registration |
| ListEntryResolver | LIST_ENTRY schema hook. Wide EntryRecord[] storage, swap-and-pop removal, per-attester lens. | Yes | No — baked into LIST_ENTRY_SCHEMA_UID at registration |
| ListReader | Stateless view over ListEntryResolver + EAS. getMode, length, entries, countOf, typed accessors. | No | Yes — address not baked into any schema UID |
| AliasResolver | REDIRECT schema hook (ADR-0050). Write-time guards only: no self-loop, per-kind typing (sameAs/supersededBy → DATA↔DATA; symlink → Anchor source). No read-time resolution. | No | No — baked into REDIRECT_SCHEMA_UID at registration |

"Not redeployable" means the contract's address is baked into one or more schema UIDs at registration. Replacing it breaks every attestation under those schemas.

## Upload flow (what a user's "save" actually does)

For a new file:

1. **Chunk the bytes.** SSTORE2 — content split into ~24KB chunks, each deployed as a raw-bytecode contract. An `EFSBytesStore` chunk-manager contract is deployed that holds the chunk addresses (ADR-0057). It is dual-interface: `chunkCount()`/`chunkAddress(i)` for the router's efficient `extcodecopy` read, plus ERC-5219 (`resolveMode()`/`request()`) so a bare `web3://<store>` also resolves the file in any standard web3:// client. *(Status: `EFSBytesStore` is the contract of record. The `packages/nextjs/` debug uploaders still vendor the prior one-arg chunk-only bytecode; re-vendoring the dual-interface store there + in the SDK is the tracked follow-up — `docs/FUTURE_WORK.md` / issue [#34](https://github.com/efs-project/contracts/issues/34). Stores deployed by the debug UI until then are chunk-only, still router-readable.)*
2. **Attest the DATA** — an empty attestation (pure identity, ADR-0049). To dedup, the client may first query the property index for a trusted `contentHash` claim; if found, skip this step and hardlink the existing DATA via a new PIN (step 6).
3. **Attest a MIRROR** pointing `web3://<chunkManager>:<chainId>` at the DATA. Additional MIRRORs (ipfs://, ar://, etc.) may be added for redundancy.
4. **Attest contentType / contentHash / size PROPERTYs** — each is three attestations batched (ADR-0041 supersedes ADR-0035; reserved keys per ADR-0049): `Anchor<PROPERTY>(refUID=DATA, name="<key>")` (skipped if already exists), a free-floating `PROPERTY(value=…)`, and a `PIN(definition=that anchor, refUID=that property)` that binds the value into the cardinality-1 slot. `contentHash` (e.g. keccak256) and `size` are computed locally; both are lens-scoped attester claims, not authenticated identity.
5. **Attest an ANCHOR** for the filename under the target folder (if the name slot doesn't already exist).
6. **Attest a PIN** linking the DATA to the file Anchor under the uploader's address. Cardinality 1 — re-attesting at the same `(attester, definition, targetSchema)` slot supersedes the prior placement in O(1).
7. **Ancestor-walk visibility TAGs** (ADR-0006 revised, ADR-0038, ADR-0041) — for every generic folder on the path from the immediate parent up to root exclusive, if the uploader has no active `TAG(definition=dataSchemaUID, refUID=folder)` yet, emit one. Weight defaults to 1 by convention; the kernel treats any existing, non-revoked TAG as active regardless of weight (ADR-0041 §4). Ensures the uploader's lens listing shows the folders that contain their content. Steady-state zero cost (walk exits once an existing TAG is found); pays 1 TAG per untagged ancestor on the first upload into a new subtree.

Typical new upload: ~10 transactions. Gas-heavy by design — this is archival, not a commodity file service.

## Read flow (what `web3://<router>/path/file.png` does)

1. Router parses the URL: path segments + `?lenses=`, `?caller=`.
2. **Top-level segment is classified** into one of four container flavors (ADR-0033): Ethereum address, EAS schema UID, EAS attestation UID, or anchor name. Address seeds `currentParent` with `bytes32(uint160(addr))`; anchor names seed `rootAnchorUID`. For schema and attestation UIDs, the router first checks for an **alias anchor** — a root-child anchor whose name is the UID in lowercase 0x-hex — and seeds `currentParent` with the alias if present; otherwise it seeds the raw UID. Alias anchors let schemas and attestations carry EFS-native metadata (human label PROPERTY, sub-anchors, TAGs) without conflating with the raw EAS record. When the container is an address and `?lenses=` wasn't given, the router defaults lenses to `[caller, segmentAddr, system]` — the `system` tail (ADR-0053/0039) matches the default-lens fallback every other flavor gets, so address browsing still surfaces canonical defaults.
3. Walks the remaining path segments using `EFSIndexer.resolvePath` — every flavor reduces to a bytes32 parent, so the walk is the same code path.
4. For each lens attester in order, queries `EdgeResolver` for the active placement PIN at that Anchor → DATA (cardinality-1, O(1) read). First attester with a match wins. Returns the DATA UID plus that attester's address. With no `?lenses=`, the attester order is `[caller, system]` (or just `[system]` if no caller) — `system` = the `SystemAccount` address (ADR-0053), the default-lens tail, replacing the former deployer-EOA fallback.
5. Finds the best MIRROR for the DATA **from the same attester**, by transport priority: `web3:// > ar:// > ipfs:// > magnet: > https://`. Skips revoked mirrors and invalid URIs. Capped at 500 mirror scans per request.
6. Finds the `contentType` PROPERTY **from the same attester** on the DATA. Falls back to `application/octet-stream`.
7. Serves:
   - **`web3://` mirror** → reads SSTORE2 chunks via `extcodecopy`, concatenates, returns the bytes. Multi-chunk files use EIP-7617 chunk pagination. The mirror target is an `EFSBytesStore` (ADR-0057), which also implements ERC-5219 — so the same `web3://<store>` URI resolves directly in a generic web3:// client (`web3protocol`, w3link, eth.limo) without going through this router. Only **same-chain** `web3://` mirrors are read on-chain: a `web3://<addr>:<otherChainId>` mirror (chainId ≠ the router's chain) is served as a `message/external-body` redirect for the client to follow cross-chain, since the router can only `extcodecopy` contracts on its own chain (ADR-0058).
   - **Other transports** → returns HTTP 200 with `Content-Type: message/external-body; access-type=URL; URL="<mirror>"; content-type="<mime>"`. Clients follow the redirect.
   - **No DATA + schema/attestation container** → returns HTTP 200 `application/json` with the raw schema or attestation fields (useful for `web3://<router>/<schemaUID>` discovery).

## Load-bearing invariants

Breaking these is painful or impossible to reverse:

- **Append-only indices** (`03-Onchain-Indexing-Strategy.md`). Revocation sets an `_isRevoked` flag; never mutate or compact existing entries. Readers filter on iteration.
- **Schema UIDs are immutable.** The UID hashes the field string; any field change produces a new schema UID. Old attestations stay under the old UID forever.
- **Lens-scoped reads.** Mirrors and PROPERTYs on a DATA are filtered to the lens attester at read time — cross-attester injection of mirrors or MIME types is blocked by design. Attester-scoped reads **require** the lens as a parameter: `EFSRouter` serves the winning lens's mirror; `EFSFileView.getDataMirrors(dataUID, attester, …)` is the scoped read. The only cross-attester reader is the explicitly-named `getDataMirrorsAllAttesters` (debug/discovery — never a trusted render path).
- **Client render-isolation is mandatory (ADR-0056).** The kernel does **no** URI-scheme safety — a mirror URI is arbitrary attester-controlled bytes (any scheme, incl. `data:`/`javascript:`). Clients MUST sandbox rendered mirror content (sandboxed iframe + CSP; SES/LavaMoat for active content), never render a raw mirror URI as a live link, and never navigate the top-level context to one. This is a client launch-blocker.
- **Mainnet contracts are permanent.** No upgrades, no admin override, no migrations. Devnet uses upgradeable proxies for iteration; mainnet does not.

## Where to go next

- **"How does X actually work?"** → the corresponding numbered spec (see this directory's `README.md`).
- **"Why was X chosen over Y?"** → `docs/adr/` (immutable reasoning snapshots).
- **"What decisions are currently blocked on the human?"** → `docs/QUESTIONS.md`.
- **"What's on the backlog?"** → `docs/FUTURE_WORK.md`.
