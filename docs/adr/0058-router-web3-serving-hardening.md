# ADR-0058: Harden the EFSRouter web3:// serving path (pagination round-trip, parity, sanitization)

**Status:** Proposed (pending merge of `claude/web3-router-hardening`; stacked on ADR-0057 / PR #29)
**Date:** 2026-06-20
**Related:** ADR-0057 (EFSBytesStore — found these gaps), ADR-0018 (single Content-Type header), ADR-0024 (Content-Type sanitization), ADR-0013 (lens-scoped mirror selection), ADR-0031 (first-attester-wins), ADR-0019 (non-reverting parsers), ADR-0030 (mainnet permanence — router redeployable pre-mainnet), ADR-0037 (pinned fork); EIP-4804/ERC-6860/ERC-5219/EIP-6944/EIP-7617
**Permanence-tier:** Durable (EFSRouter is redeployable — not hashed into any schema UID; becomes Etched at mainnet, so these are fixed now while cheap)
**Reviewed:** 2026-06-20 — pagination round-trip + lens-consistency validated against the `web3protocol-js` reference client; empirically verified end-to-end.

## Context

Making `EFSBytesStore` standards-compliant (ADR-0057) surfaced four gaps in the *router's* own `web3://<router>/<path>` serving path (the lens-resolved entrypoint generic EIP-4804/6860/5219 clients use), plus a fifth (chainId handling) that the move to real Sepolia unblocked. All are on a redeployable contract that becomes Etched at mainnet, so they are cheapest to fix now:

1. **Pagination breaks generic clients.** For a multi-chunk on-chain file the router emits `web3-next-chunk: ?chunk=<n>` (`EFSRouter.sol` web3:// branch). The `web3protocol-js` reference client only turns a `web3-next-chunk` value into a fetchable URL if it starts with `/` (→ `web3://<router>:<chainId><value>`) or is a full `web3://…` URL; a bare `?chunk=` is fed raw to its URL parser and **throws**. So every multi-chunk router read aborts after chunk 0 in any generic client — a silent truncation/corruption.
2. **Cross-lens corruption on pagination.** The router *re-resolves* the path through lenses on every `request()` call. If the next-chunk URL drops the original `?lenses=`/`?caller=`, chunk N+1 resolves under a different attester than chunk 0 — splicing a different lens's bytes mid-file (ADR-0013/0031 make each attester's content independent).
3. **Empty-store divergence.** A zero-chunk store resolves as **404** via the router but **200 empty** via `EFSBytesStore.request()` (ADR-0057). A zero-byte file is legitimate (DATA is pure identity, ADR-0049); the two read paths must agree.
4. **`statusCode` width + `contentType` sanitization.** The router declares `request() → uint256 statusCode` while the ERC-5219 reference decoder and `EFSBytesStore` use `uint16`. And `contentType` (an attester-controlled PROPERTY) is placed into the on-chain branch's `Content-Type` header **without** `_sanitizeHeaderValue`, even though the off-chain branch sanitizes it (an ADR-0024 header-injection hole on the on-chain branch only).

## Decision

Fix all five in `EFSRouter` (redeployable; no schema-UID coupling):

1. **Pagination — Approach A: the router serves every chunk; the next-chunk value re-emits the same path + routing params.**
   `web3-next-chunk = /<percent-encoded path segments>?<preserved lenses/caller>&chunk=<n+1>`. New helpers `_nextChunkURL` / `_percentEncode` / `_isUnreserved` (reusing `_uintToString`/`_stringsEqual`). The **round-trip invariant**: after the client's per-segment `decodeURIComponent` and `URLSearchParams` decode, it must reproduce byte-identical `resource[]` and the same lens-bearing `params[]` that produced chunk 0 — so every chunk comes from the same lens-resolved DATA/mirror. Path segments and param values are percent-encoded (RFC 3986 unreserved set left literal) so reserved bytes survive the round-trip; the old `chunk` param is dropped and the bumped one appended.
2. **Empty store → `(200, "", [Content-Type])`**, matching `EFSBytesStore` (ADR-0057). A zero-chunk store is a valid empty file, not "not found."
3. **`request()` `statusCode` → `uint16`** (interface + impl + the two JSON responders), matching the `web3protocol-js` decoder and `EFSBytesStore`. ABI-visible, but the router is redeployable and not yet Etched — aligning now avoids a permanent odd-one-out.
4. **Sanitize `contentType`** (`_sanitizeHeaderValue`, ADR-0024) at the source so the on-chain branch's `Content-Type` header is injection-safe like the off-chain branch.
5. **chainId-aware serving.** A `web3://<addr>:<chainId>` mirror is served on-chain (extcodecopy) only when it carries no `:chainId` suffix (EFS convention: same chain) or the suffix equals `block.chainid`. A suffix naming a **different** chain falls through to the `message/external-body` redirect, so a web3://-aware client resolves it on the right chain (EIP-6860) instead of the router silently extcodecopy-ing whatever (if anything) sits at that address on its own chain. New `_web3UriServesLocally` helper; malformed/absurd suffixes degrade to local-serve (never a revert). This was previously deferred because a strict check would break the `31337` devnet fork (mirrors carry logical `:11155111`); the move to real Sepolia (`block.chainid == 11155111`) removes that conflict, so it's fixed here.

### Why Approach A (not delegate-to-bucket)

- **B — next-chunk points at the bucket** (`web3://<store>:<chainId>/?chunk=<n>`): rejected. Existing stores deployed by the debug UI use the old `MockChunkedFile` bytecode (no `resolveMode`/`request`), so a bare bucket URL has no ERC-5219 surface and a generic client fails. The router reads both old and new stores only via `chunkCount`/`chunkAddress` + `extcodecopy`, so A works for both.
- **C — hybrid (probe `resolveMode`)**: rejected. Resurrects B's footguns for the 5219 case (handing the byte stream to an attester-controlled contract mid-file, after the router vouched for chunk 0 under a lens) and doubles the audit surface on an Etched contract, to save gas on a `view` — the wrong axis (correct → easy → performant).
- **A** keeps one code path, is lens-consistent by construction, works for all stores, round-trips through the reference client, and adds no new Etched coupling. Its cost is bounded string reconstruction on a `view` (not a gas-metered write).

## Consequences

- **Generic web3:// clients can fetch multi-chunk on-chain files via `web3://<router>/<path>`** at any size and any lens, byte-correct — completing the standards-compliance ADR-0057 started at the bucket level.
- **Cross-lens corruption closed:** every chunk in a paginated read is drawn from the same resolved attester (params preserved).
- **Router/bucket parity:** empty-store 200, `uint16` statusCode, and `contentType` sanitization now match between the two web3:// read surfaces.
- **ABI change (`uint256`→`uint16` statusCode).** Durable; the router is redeployable (address never in a schema UID). Done pre-mainnet so the public ABI is standards-correct before it Etches. Decodes identically for existing clients (same 32-byte slot; values fit 16 bits).
- **chainId reconciliation (FUTURE_WORK #91) is now resolved** by decision 5: cross-chain web3:// mirrors redirect instead of silently serving local bytes; same-chain/suffix-less serve on-chain. Safe on real Sepolia where `block.chainid == 11155111` matches mirror chainIds (the devnet-reset to Sepolia is what unblocked it).
- **Deferred (not in this PR), with reasons:**
  - **Reserved-byte anchor-name resolution.** The router matches `resource[i]` raw against canonical percent-encoded on-chain names, so a name with a reserved byte already fails to resolve through the reference client on chunk 0 (independent of pagination). Separate pre-existing issue; the pagination fix is consistent regardless (chunk N+1 re-emits the exact bytes chunk 0 resolved). Tracked in `docs/FUTURE_WORK.md`.
- Tests: router pagination header value (`/path?lenses=…&chunk=n+1`, path + lens preserved), full multi-chunk reassembly with lenses, empty-store 200, `contentType` sanitization on the web3 branch; existing 61 router tests still pass. Empirically verified against the real `web3protocol` client.

## Alternatives considered

- **Leave pagination as `?chunk=` and tell clients to special-case it.** Rejected: it's non-conformant; the de-facto client throws. Standards compliance means working with the reference client unmodified.
- **Delegate-to-bucket (B) / hybrid (C).** Rejected — see "Why Approach A" (mixed stores; redirect-mid-stream footguns).
- **chainId: reject (500) a cross-chain mirror instead of redirecting.** Rejected — a different-chain web3:// mirror is legitimately fetchable by a web3://-aware client, so delegating via `message/external-body` (decision 5) is strictly more useful than a 500, and matches how every other off-chain transport is handled. (Also considered: silently ignoring `:chainId` and extcodecopy-ing locally — the pre-existing behavior — which serves wrong bytes for a cross-chain mirror; that's the bug decision 5 fixes.)
