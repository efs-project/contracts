# ADR-0057: Production ERC-5219 on-chain byte store (EFSBytesStore)

**Status:** Proposed (pending merge of `claude/web3-erc5219-bytes-store`; flip to Accepted on merge)
**Date:** 2026-06-20
**Related:** ADR-0018 (single Content-Type header), ADR-0012 (transport priority — `web3://` highest), ADR-0049 (DATA is pure identity; mirror carries the URI), ADR-0056 (mirror scheme gate removed — `web3://` is the universal zero-infra write target), ADR-0030 (mainnet permanence), ADR-0032 (EAS foundation); planning `[[web3-standards-compliance]]`, `[[sdk-read-surface]]`
**Permanence-tier:** Durable (devnet; non-schema-bound deployable helper + redeployable router — see Freeze-safety)
**Reviewed:** 2026-06-20 — binary-over-5219 mechanism validated against the EIP-5219 text and the `web3protocol-js` reference decoder (the de-facto client used by w3link / eth.limo / evm-browser).

## Context

EFS stores file bytes on-chain via SSTORE2 chunks wrapped in a chunk-manager
contract (`MockChunkedFile` — array of chunk addresses, `chunkCount()` /
`chunkAddress(i)`). A `web3://` MIRROR points at that manager. Today only two
readers understand the manager:

1. **`EFSRouter`** — its `request()` (ERC-5219) walks a path, finds the winning
   lens's `web3://` mirror, probes the manager via `chunkCount`/`chunkAddress`,
   and `extcodecopy`s each chunk. `web3://<router>/<path>` therefore resolves in
   any standard web3:// client. ✓
2. **The SDK reader** — replicates the same chunk convention off-chain.

The **stored mirror pointer itself is not standalone-standard.** A
`web3://<chunkManager>` URL handed to a *generic* web3:// client (one that did
not go through the EFS router) resolves to the bare manager, which exposes only
`chunkCount()`/`chunkAddress()` — **no `resolveMode()`, no `request()`**. A
generic client has no way to know the EFS reassembly convention, so it cannot
fetch the bytes. The contract is literally named `Mock…` and the router's read
branch is comment-flagged `"(Mocking EXTCODECOPY)"` — the on-chain-storage path
was prototype-grade, not productionized.

Net: EFS is standards-compliant **at the router** but not **at the stored-content
level**. The goal (planning `[[web3-standards-compliance]]`): `web3://<store>`
must resolve to the exact file bytes in ANY EIP-4804 / ERC-6860 / ERC-5219 client,
with zero EFS-specific code on the reader's side.

### The one subtlety — binary over ERC-5219

The EIP-5219 *text* (`assets/eip-5219/IDecentralizedApp.sol`) declares the body as
`string memory body`. Taken literally that mangles arbitrary binary (a PNG is not
valid UTF-8). But the **de-facto standard** is set by the reference client
`web3protocol-js` (consumed by w3link, eth.limo's web3:// support, evm-browser),
and its ERC-5219 decoder (`src/mode/5219.js`) decodes the contract return as:

```js
const returnABI = [{type:'uint16'}, {type:'bytes'}, {type:'tuple[]', components:[{type:'string'},{type:'string'}]}];
// statusCode = decoded[0]; body = hexToBytes(decoded[1]); headers = decoded[2];
```

i.e. **`(uint16 statusCode, bytes body, KeyValue[] headers)`**, and the body is
fed to the HTTP stream as **raw bytes** (`controller.enqueue(hexToBytes(...))`) —
no base64, no UTF-8 round-trip. The `string` in the EIP text is widened to `bytes`
in every real client precisely to carry binary. Our own `EFSRouter` already uses
the `bytes body` shape (so it self-serves binary correctly today). The remaining
mismatch is `statusCode`: the router declares `uint256`; the reference decoder
reads `uint16`. They occupy the same 32-byte ABI slot so decoding doesn't break,
but the *standards-correct* declaration is `uint16`, and a new contract should use
it. (Content-Encoding gzip/br — ERC-7618 — and chunk pagination — ERC-7617 — are
optional layers a client applies on top; not required for correctness.)

## Decision

Rename `MockChunkedFile → EFSBytesStore` and **productionize it as a dual-interface
contract** that is simultaneously:

1. **The router's efficient chunk interface (kept, unchanged ABI):**
   `chunkCount() → uint256` and `chunkAddress(uint256) → address`. The router's
   `extcodecopy` fast path is the gas-efficient on-chain read and stays as-is.

2. **A standards-compliant ERC-5219 resource (added), with EIP-7617 pagination:**
   - `resolveMode() → bytes32 "5219"` — signals manual/5219 mode to any client.
   - `request(string[] resource, KeyValue[] params) → (uint16 statusCode, bytes body, KeyValue[] headers)`
     — returns **one chunk per call** (`extcodecopy` the selected chunk, skipping
     the leading SSTORE2 `0x00` STOP byte), with a `web3-next-chunk` header chaining
     to the next chunk when more remain. A standard client walks the chain and
     concatenates; a single-chunk store returns the whole file in one call with no
     next header. The chunk index is read from the `chunk` query param (default 0,
     non-reverting). The body is `bytes` and raw — the binary mechanism validated
     above. statusCode is `uint16`. A codeless chunk is rejected **at construction**
     (`require` in the constructor) so a corrupt/incomplete store can't be deployed —
     this matters because ERC-7617 clients ignore the status code on follow-up chunks
     and append only the body, so a later chunk faulting with a `(500, …)` body would
     concatenate its error string into the file; `request()` keeps a belt-and-suspenders
     no-code **revert** (unreachable post-construction, SSTORE2 chunks can't
     self-destruct) so any such fault fails the whole `eth_call` cleanly rather than
     corrupting the stream. An explicit out-of-bounds index → `(404, "Chunk out of
     bounds", [])` (an oversized decimal `chunk` value saturates rather than overflow-
     reverting); an empty store → `(200, "", [Content-Type])`. Error responses carry no
     `web3-next-chunk`, so a client never loops on a fault.

   **Why per-chunk, not whole-file.** A `request()` that reassembles the entire
   file in one `eth_call` fails for large files — real gateways (w3link, eth.limo)
   cap `eth_call` response size/gas (~50M). Per-chunk reads stay ~24KB, so a bare
   `web3://<EFSBytesStore>` resolves files of **any readable size** — read
   resolution is unbounded. (The *upload* side is still capped by the
   manager-deploy gas ceiling: the constructor stores every chunk address in one
   tx, so a single store tops out around the documented chunk count — see
   `docs/FUTURE_WORK.md`. Pagination removes the read cap, not the write cap.)
   Critically, EIP-7617
   pagination cannot be added to an immutable store *after* deployment (the contract
   must emit the `web3-next-chunk` header), so shipping it now — before this surface
   is Etched — avoids a fleet-wide redeploy later. The next-chunk value is
   **`/?chunk=<n>` (leading slash)**: the `web3protocol-js` reference client only
   rewrites a relative next-chunk value into a fetchable URL when it begins with `/`
   (a bare `?chunk=<n>` is fed raw to the URL parser and throws). Verified
   empirically — the real `web3protocol` client paginates a multi-chunk store to the
   exact bytes. (NB: `EFSRouter`'s web3:// branch currently emits `?chunk=<n>`
   *without* the leading slash and so would break a generic client on its own
   paginated path — a redeployable-router follow-up, out of scope here.)

Net: **`web3://<EFSBytesStore>` resolves to the exact file bytes in any standard
web3:// client, at any file size**, while `web3://<router>/<path>` continues to
resolve via the router's lens-scoped path. Both read the same underlying SSTORE2
chunks.

### Content-Type

The bare store knows its bytes but not the EFS PROPERTY graph (the `contentType`
PROPERTY is a lens-scoped attestation on the DATA, not on the store). So the
store needs its own content type. **The content type is set at construction**
(`constructor(address[] chunks, string contentType)`) and returned by `request()`.
The writer (SDK / upload flow) already computes the MIME locally for the
`contentType` PROPERTY; it passes the same value into the store. Empty/unset
defaults to `application/octet-stream` (matches the router's fallback, ADR-0018).
This keeps the store self-describing for the generic-client path without coupling
it to the attestation graph — the router path still uses the lens-scoped PROPERTY
and is unaffected.

The deployer-supplied MIME is **sanitized at construction** (ADR-0024): quotes,
backslash, and control bytes (`< 0x20`, incl. CR/LF) are stripped before the value
is stored, so the `Content-Type` header `request()` emits can't be used to inject
extra headers into a generic web3:// gateway response. The router already applied
this defense to the lens-scoped PROPERTY value; mirroring it on the bare-store path
closes the same hole there (a malicious store deployer is the threat actor).

**The two MIME sources may legitimately disagree — by design.** The store's
constructor `contentType` is the *deployer's* immutable claim; the lens-scoped
`contentType` PROPERTY is a *per-attester* revocable claim. They are different
trust models, so the same bytes can be served as `image/png` via a bare
`web3://<store>` and as something else via `web3://<router>/path?lenses=…`.
**Precedence is per resolution path, not global:** the bare-store path trusts the
store's MIME; the router path trusts the winning lens's PROPERTY. This is intended
(each path serves the claim appropriate to how it was reached), not a bug — but
because a MIME divergence between two paths for identical bytes is exactly the kind
of thing a security reviewer must reason about under ADR-0056's render-isolation
posture, it is stated here so it is reconstructable.

### Router read branch — productionize the comment, keep the mechanism

The router's `web3://` branch is **functionally correct** — it already probes
`chunkCount`/`chunkAddress` and `extcodecopy`s the bytes, with EIP-7617 chunk
pagination, bounds checks, and a no-code guard. It is not placeholder-grade in
behavior; only the `"(Mocking EXTCODECOPY)"` comment and the `Mock…` type name
were. We **keep the router's efficient extcodecopy path** (it is strictly cheaper
than calling the store's `request()` and re-returning the bytes, and it is the
already-tested hot path) and only correct the stale comment. The router does not
need to call the store's `request()`; the store's `request()` exists for *generic
external* clients that hold a bare `web3://<store>` URL, which is exactly the gap
this ADR closes. Router stays redeployable (not frozen).

## Consequences

- **Generic web3:// resolution of stored content.** Any EIP-4804/6860/5219 client
  (`web3protocol`, w3link, eth.limo, evm-browser) can fetch
  `web3://<EFSBytesStore>:<chainId>` and get the exact file with the right MIME —
  no EFS router, no SDK. This is the standards-compliance the design asked for.
- **Two read paths, one source of truth.** Router uses `chunkCount`/`chunkAddress`
  + `extcodecopy` (cheap, lens-scoped, paginated). Generic clients use
  `resolveMode`/`request` (self-contained, EIP-7617 paginated — one chunk per call).
  Both read the same chunk contracts and both stream chunk-by-chunk; no duplication
  of stored bytes and no whole-file materialization on either path.
- **Freeze-safety — nothing frozen is touched.** `EFSBytesStore` is a *per-file
  deployable helper*: its address is **never hashed into a schema UID**. It is
  only ever the target of a `web3://` MIRROR *string* (ADR-0049: the URI lives in
  the mirror, not in any schema field). Deploying / replacing / re-shaping it
  changes nothing in the 9-schema freeze set, no resolver wiring, no
  `deployedContracts.ts` address that downstream pins to. The router is likewise
  redeployable (only live URIs would change, and only if its address changed —
  which it does not here). So this is a Durable change with no Etched coupling.
- **Constructor ABI change** (`address[]` → `address[], string`). This is a
  Durable break for *off-contract* code that deploys the store from vendored
  creation bytecode: the SDK's `packages/sdk/src/writes/onchain-bytecode.ts` and
  the debug-UI upload path (`packages/nextjs/lib/efs/{sstore2.ts,uploadOnchainFile.ts}`
  + `CreateItemModal.tsx`) each carry their own copy of the old `MockChunkedFile`
  bytecode and a 1-arg deploy call. **This PR does not touch them.** They stay
  decoupled from the renamed contract — the router reads by the
  `chunkCount()`/`chunkAddress()` *interface*, never by contract name — so the
  debug client keeps working and previously-uploaded files keep resolving; the
  stores the debug UI deploys are simply chunk-only (not standalone ERC-5219)
  until re-vendored. Re-vendoring the new 2-arg bytecode + passing a content type
  (SDK and debug UI together) is tracked durably in-repo at `docs/FUTURE_WORK.md`
  and GitHub issue
  [#34](https://github.com/efs-project/contracts/issues/34) (the detailed
  hand-off spec lives in `planning/Designs/web3-bytesstore-sdk-followup.md`), so
  the defer stands on its own even if this PR lands before the planning vault.
- **Gas / large files:** `request()` returns at most one ~24KB chunk per call, so
  every response stays well under node `eth_call` size/gas caps — any file that
  fits the manager-deploy gas cap resolves via the bare-store path by following
  the `web3-next-chunk` chain (read resolution itself is unbounded). (The
  earlier whole-file-in-one-call design hit those caps for large files; EIP-7617
  pagination is the fix and is shipped here, not deferred.)
- **Sub-path / range semantics are permanently foreclosed at the store — by design.**
  `request()` ignores the `resource` path entirely (it reads only the `chunk`
  param). So `web3://<store>/anything` resolves to the file, forever. This is
  deliberate: in EFS, pathing lives in the router/anchor layer
  (`web3://<router>/docs/readme.md`), and a store is a single-file leaf. Once Etched,
  a store can never give a sub-path meaning (e.g. `/thumbnail`, `/metadata`, byte
  ranges) without breaking already-published `web3://<store>` URLs — that namespace
  is intentionally spent on "ignored," so a future reader should not "complete" it.
- **Post-launch bug remediation for a deployed store.** The store is immutable, so a
  bug in `request()` cannot be patched in place. But its SSTORE2 chunks are
  *independent, reusable* contracts: remediation is to deploy a corrected store over
  the same chunk addresses, attest a replacement `web3://` MIRROR, and revoke the
  old one — clients on the *router* path then prefer the new MIRROR via
  transport-priority/lens resolution. **Asymmetry to note:** a generic client
  holding a *bare* `web3://<buggyStore>` has no MIRROR indirection and is pinned to
  the buggy contract with no redirect — so a `request()` bug is unrecoverable for
  bare-URL holders. This argues for extra rigor on `request()` before mainnet
  (hence the empirical real-client verification done for this ADR).
- **Naming honesty.** `Mock…` is gone; the type name and the router comment now
  reflect a production on-chain byte store.
- Tests: `EFSBytesStore` round-trips bytes via both `chunkAddress` (router path)
  and the paginated `request()` chain (standard path), single- and multi-chunk,
  binary with embedded `0x00`, plus first-call/mid/last/out-of-bounds(404)/
  oversized-decimal-saturates(404)/codeless-chunk-rejected-at-construction/
  content-type-sanitization/empty-store/garbage-param edges; the router still serves `web3://<router>/<path>`
  for an on-chain-stored file. The pagination was **verified empirically against the
  real `web3protocol` reference client** (multi-chunk store reassembled to exact
  bytes; `/?chunk=` leading-slash requirement confirmed). Update
  `simulate-transports.ts`, `seed-impl.ts`, `EFSRouter.test.ts`, and a new
  `EFSBytesStore.test.ts`.

## Alternatives considered

- **Body as `string` (literal EIP-5219).** Rejected: mangles binary; no real
  client decodes `string` — they all decode `bytes` (verified against
  `web3protocol-js`). Would fail for any non-text file.
- **Base64 the body into a `string`.** Rejected: no client base64-decodes the
  5219 body (the reference decoder enqueues raw bytes); would serve a base64 text
  blob, not the file. Wrong for every client.
- **Router calls the store's `request()` instead of extcodecopy.** Rejected: the
  extcodecopy path is cheaper and already tested; routing through `request()`
  would re-materialize bytes and add a call hop for no benefit. The store's
  `request()` is for *external* clients, not the router.
- **Whole-file `request()` (reassemble all chunks in one call), no pagination.**
  Rejected: fails for large files — real gateways cap `eth_call` response size/gas,
  and pagination cannot be retrofitted onto an immutable store, so it would
  permanently strand large files on the bare-store path. EIP-7617 per-chunk
  pagination (shipped) costs ~one extra header + a `chunk` param and makes any size
  resolvable. (Initial drafts of this contract did reassemble-all; superseded before
  merge.)
- **Per-store content type via a setter / mutable field.** Rejected: adds mutable
  state + an admin surface to a per-file helper; the MIME is known at upload time,
  so constructor injection is sufficient and immutable.
- **Leave the store as `Mock…` chunk-only and require all reads through the
  router.** Rejected: that is exactly the non-compliance this ADR fixes — a bare
  `web3://<store>` mirror is what gets stored and shared, and it must resolve
  standalone.
```
