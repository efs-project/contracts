# EFS at a glance

One-screen summary of current architecture. This is the **canonical quick reference**: if code changes any of this, update here in the same PR.

For depth, see the numbered specs. For historical reasoning (why we chose X over Y), see `docs/adr/`.

## What EFS is

EFS (Ethereum File System) is an on-chain file system built on EAS (Ethereum Attestation Service). Files, folders, and the links between them are expressed as EAS attestations. Content can be stored on-chain via SSTORE2 or off-chain via IPFS, Arweave, HTTPS, or BitTorrent — the router resolves whichever is best.

The point is **permanent, credibly neutral archival**. Anyone can publish. Anyone can curate. No central party can silently revise what was published. Once deployed, EFS itself cannot be upgraded (see "Load-bearing invariants" below).

## Three-layer model

**Anchors** (paths) → **DATA** (content identity) → **MIRRORs** (retrieval URIs)

- **Anchors** are path nodes. Hierarchical (`refUID` points to the parent anchor). Permanent and non-revocable — once a folder exists, it exists forever.
- **DATA** is standalone file identity: `contentHash` + `size`. It does NOT belong to any specific path; it's pure content identity. Multiple paths can reference the same DATA.
- **MIRRORs** are retrieval URIs. Each MIRROR references a DATA via `refUID` and carries one URI. Multiple MIRRORs per DATA (ipfs://, ar://, web3://, https://, magnet:) let the router pick the best available transport.

**TAG** attestations are the glue: `TAG(definition=anchorUID, refUID=dataUID, attester=alice)` means "Alice says this DATA lives at this path." TAGs enable three things at once: cross-referencing (same DATA at many paths), removal without revocation (`applies=false` supersedes an earlier `applies=true`), and per-attester **editions** (next section).

Content-addressed dedup: the first DATA attestation for a given `contentHash` is canonical. Subsequent uploads of identical bytes reuse the existing DATA — only a new TAG is needed to place it at a new path.

## Editions (whose content are you looking at?)

Multiple attesters can place different DATA at the same Anchor. The router resolves which to serve via a URL parameter:

```
web3://<router>/docs/readme.md?editions=alice.eth,bob.eth
```

Attesters are tried in order; the first with active content at that path wins ("fallback list" model, per ADR-0031). Alice's `readme.md` is served if she has any; otherwise Bob's.

Without `?editions=`, the router falls back to `?caller=` (the requesting address), then to the EFS deployer as a final default. **Nobody sees foreign content unless they explicitly opt in** — viewer sovereignty is a core design property.

Reads are edition-scoped beyond just TAG resolution: mirrors and PROPERTYs on a DATA are also filtered to the winning attester. This prevents third parties from injecting a malicious mirror or a bogus `contentType` onto someone else's DATA.

## Six EAS schemas

| Schema | Revocable | Purpose |
|---|---|---|
| ANCHOR | no | Paths. Hierarchical via `refUID = parentAnchor`. |
| DATA | no | Content identity (`contentHash`, `size`). Standalone (`refUID = 0x0`). |
| MIRROR | yes | Retrieval URI for a DATA. Multiple allowed per DATA. |
| TAG | yes | Places a DATA at a path. Singleton per `(attester, target, definition)` — a new TAG on the same triple supersedes the old. |
| PROPERTY | yes | Key/value metadata on a DATA or Anchor (e.g. `contentType = "image/png"`). |
| SORT_INFO | yes | Declares a sort scheme for a folder (sort function + target schema). |

Full field definitions and resolver wiring: `02-Data-Models-and-Schemas.md`.

## Core contracts

| Contract | Role | State | Redeployable |
|---|---|---|---|
| EFSIndexer | Append-only kernel. All indices, path resolution, revocation tracking, qualifying-folder index. | Yes (heavy) | No — schema UIDs encode its address |
| EFSRouter | `web3://` URI resolution (ERC-5219). Edition-scoped content serving. | No | Yes — but URIs change |
| EFSFileView | Directory listing views over EFSIndexer. | No | Yes — fully stateless |
| TagResolver | TAG schema hook. Singleton placement via `_activeByAAS` swap-and-pop index. | Yes | No — wired into EFSIndexer |
| MirrorResolver | MIRROR schema hook. URI scheme allowlist + transport ancestry check. | Minimal | No — wired into EFSIndexer |
| EFSSortOverlay | Per-parent sorted linked lists. Lazy overlay on EFSIndexer. | Yes | No — wired into EFSIndexer |

"Not redeployable" means the contract's address is baked into one or more schema UIDs at registration. Replacing it breaks every attestation under those schemas.

## Upload flow (what a user's "save" actually does)

For a new file:

1. **Chunk the bytes.** SSTORE2 — content split into ~24KB chunks, each deployed as a raw-bytecode contract. A chunk-manager contract is deployed that knows how to reassemble them.
2. **Attest the DATA** (`contentHash`, `size`). If the hash already exists in `dataByContentKey`, reuse the canonical DATA — skip this step.
3. **Attest a MIRROR** pointing `web3://<chunkManager>:<chainId>` at the DATA. Additional MIRRORs (ipfs://, ar://, etc.) may be added for redundancy.
4. **Attest a PROPERTY** with `key="contentType"` on the DATA (e.g. `"image/png"`).
5. **Attest an ANCHOR** for the filename under the target folder (if the name slot doesn't already exist).
6. **Attest a TAG** linking the DATA to the file Anchor under the uploader's address.

Typical new upload: ~8 transactions. Gas-heavy by design — this is archival, not a commodity file service.

## Read flow (what `web3://<router>/path/file.png` does)

1. Router parses the URL: path segments + `?editions=`, `?caller=`.
2. Walks path segments from root using `EFSIndexer.resolvePath`, reaching the leaf Anchor.
3. For each edition attester in order, queries `TagResolver` for active TAGs at that Anchor → DATA. First attester with a match wins. Returns the DATA UID plus that attester's address.
4. Finds the best MIRROR for the DATA **from the same attester**, by transport priority: `web3:// > ar:// > ipfs:// > magnet: > https://`. Skips revoked mirrors and invalid URIs. Capped at 500 mirror scans per request.
5. Finds the `contentType` PROPERTY **from the same attester** on the DATA. Falls back to `application/octet-stream`.
6. Serves:
   - **`web3://` mirror** → reads SSTORE2 chunks via `extcodecopy`, concatenates, returns the bytes. Multi-chunk files use EIP-7617 chunk pagination.
   - **Other transports** → returns HTTP 200 with `Content-Type: message/external-body; access-type=URL; URL="<mirror>"; content-type="<mime>"`. Clients follow the redirect.

## Load-bearing invariants

Breaking these is painful or impossible to reverse:

- **Append-only indices** (`03-Onchain-Indexing-Strategy.md`). Revocation sets an `_isRevoked` flag; never mutate or compact existing entries. Readers filter on iteration.
- **Schema UIDs are immutable.** The UID hashes the field string; any field change produces a new schema UID. Old attestations stay under the old UID forever.
- **Edition-scoped reads.** Mirrors and PROPERTYs on a DATA are filtered to the edition attester at read time — cross-attester injection of mirrors or MIME types is blocked by design.
- **Mainnet contracts are permanent.** No upgrades, no admin override, no migrations. Devnet uses upgradeable proxies for iteration; mainnet does not.

## Where to go next

- **"How does X actually work?"** → the corresponding numbered spec (see this directory's `README.md`).
- **"Why was X chosen over Y?"** → `docs/adr/` (immutable reasoning snapshots).
- **"What decisions are currently blocked on the human?"** → `docs/QUESTIONS.md`.
- **"What's on the backlog?"** → `docs/FUTURE_WORK.md`.
