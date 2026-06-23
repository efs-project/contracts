# ADR-0063: `data:` inline-mirror transport for small files

**Status:** Accepted
**Date:** 2026-06-22
**Related:** ADR-0011 (transports as `/transports/*` anchors), ADR-0012 (transport priority), ADR-0022 (`MAX_URI_LENGTH = 8192`), ADR-0053 (SystemAccount), ADR-0056 (no URI-scheme allowlist; client render-isolation), ADR-0057 (single-chunk on-chain store)

## Context

Saving a file "on-chain" in EFS stores the bytes via SSTORE2 — one deployed contract per ~24 KB chunk plus a manager contract — each a separate wallet transaction and block wait. For a *small* file (a markdown Overview, a tiny config), that is several deploys to store a few hundred bytes. The debug-UI minimal-clicks work made the *attestation* side cheap (one `multiAttest` per DAG layer); storage deploys are now the remaining per-popup cost for small files.

RFC-2397 `data:` URIs (`data:<mediatype>;base64,<bytes>`) let the bytes ride **inline in the MIRROR attestation's `uri` field** — zero storage deploys. The pieces to make this round-trip already exist:

- `MirrorResolver` imposes **no** URI-scheme allowlist (ADR-0056) — render safety is the client's job — so a `data:` URI validates. It does require the MIRROR's `transportDefinition` to be a descendant of `/transports/` (ADR-0011), so `data:` needs a `/transports/data` anchor.
- The canonical `web3://` router serves any non-`web3://` URI as a `message/external-body; access-type=URL; URL="…"` redirect (`EFSRouter.sol`), which a client resolves natively — a `data:` URI renders inline. So `data:` files are addressable via `web3://<router>/path`, **not** debug-UI-only.

## Decision

Add **`data`** as a default transport anchor under `/transports/`, authored in the bootstrap seed (`deploy-lib/orchestrate.ts` `BOOTSTRAP_SCAFFOLDING` + `deploy-lib/safePlan.ts` `SCAFFOLDING`) exactly like the other default transports — bringing the seeded set from 11 to 12.

Client policy (debug UI, `lib/efs/uploadOnchainFile.ts`):
- A file **≤ 4096 bytes** is stored inline as `data:<contentType>;base64,…` when the final URI is within ADR-0022's 8192-byte cap and `/transports/data` resolves; otherwise it falls back to SSTORE2.
- The read path renders `data:` (`utils/efs/transports.ts` → `fetch()` handles it natively).
- The "paste a link" / "add mirror by URI" write paths **reject** a hand-typed `data:` URI — inline data is a property of the *upload* path, not an external link to paste.

`data` is **seeded by default, not auto-created on first use** (see Alternatives). The client does **not** enforce creator identity for `/transports/data`: a transport anchor is a shared vocabulary UID, and its creator has no continuing authority over MIRRORs that reference it. If the path resolves, the client can use it; if it is absent or lookup fails, the client falls back to SSTORE2.

## Consequences

- Small files (Overviews, configs ≤ 4 KB) save with **zero storage deploys** — fewer popups, the headline win for the common debug-UI case. Larger files use SSTORE2 unchanged.
- The bytes live in the MIRROR attestation's calldata/data (permanent in EAS storage + archive nodes) rather than an `extcodecopy`-able SSTORE2 store — a *different* permanence shape, acceptable at the ≤ 4 KB cap.
- **Router priority unchanged (ADR-0012):** `data:` is NOT inserted into the router's mirror-priority tiering. If a DATA has both a `data:` and a `web3://` mirror, `web3://` still wins; `data:` is served only when it is the selected mirror (e.g. the sole mirror).
- The default transport count is now 12; the deploy-time verification derives the child list from `SCAFFOLDING`, so it auto-covers the new anchor (no hardcoded count to drift).
- **Already-frozen chains** (live Sepolia bootstrapped before this) may lack `/transports/data`; until the path exists, the client transparently falls back to SSTORE2. New fork/devnet/mainnet deploys seed it automatically.
- Client render-isolation (ADR-0056) still applies: `data:` content is fetched and rendered in the sandbox, never navigated-to as a top-level URL.

## Alternatives considered

- **Auto-create `/transports/data` on first use** (resolver- or client-side). Deferred: `MirrorResolver` cannot create anchors, and client-side creation would add another wallet prompt to the write path this PR is trying to shrink. Permissionless transport creation remains the general model for future, non-default transports; this PR only seeds the known default and falls back cleanly if it is absent.
- **Leave `data:` dormant / SSTORE2-only.** Rejected: carrying inert-but-present code generated recurring edge-case bugs (it leaked into paste/mirror write gates), and the inline win for small files is real.
- **A one-tx multi-chunk storage factory.** Orthogonal (helps large files, not the inline case) and deferred — ADR-0057 chose single-chunk-per-tx for ERC-5219 / router parity.
