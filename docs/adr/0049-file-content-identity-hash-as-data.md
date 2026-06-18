# ADR-0049: DATA is pure identity — hash and size are data, not identity

**Status:** Proposed (r2 — DATA reshaped to empty after design review)
**Date:** 2026-05-31
**Deciders:** James (schema freeze is human-gated)
**Permanence-tier:** Etched (defines the frozen DATA shape)
**Supersedes the framing of:** ADR-0002/0004/0005 (DATA `contentHash`/`size` fields + `dataByContentKey` global canonical)
**Related:** ADR-0048 (freeze set + proxy/burn), ADR-0050 (redirect/canonical/symlink), specs/02 §3

## Context

A file's **identity** in EFS is the DATA attestation's EAS UID. MIRRORs, folder placements (PIN), and metadata (PROPERTY) all reference that **UID** — never the content hash. Two uploads of the same bytes get two different DATA UIDs: EFS is **not** content-addressed at the identity layer; content-addressing is a secondary index.

A content hash is **client-supplied and unverifiable on-chain** (the bytes are never on-chain), so any hash in DATA is an unverifiable *claim* — and "never trust the client" means a claim must not be welded into identity as if the chain had authenticated it. Worse, requiring `contentHash = keccak256(bytes)` makes it **impossible** to create a file identity for large remote content (pinning a 10 GB IPFS file would require downloading all 10 GB to hash it). And baking a `0` into a permanent field when the hash is unknown is dead weight frozen forever.

## Decision

**DATA becomes an empty schema (`""`), revocable `false` — pure identity.** A DATA attestation asserts "a file identity exists"; everything *about* the file hangs off its UID in the trust-scoped layers.

- **`contentHash` and `size` move out of DATA** into reserved-key PROPERTYs (`contentHash`, `size`), bound to the DATA UID via the existing key-anchor + cardinality-1 PIN pattern, **lens-scoped per attester** — a reader believes the hash/size from an attester they trust, and multiple coexisting claims (keccak, sha2-256, CID) are allowed. Hash values are self-describing (multibase multihash / CID), per the conventions spec.
- **This is a real Tier-1 schema change**, not a reinterpretation: emptying DATA mints a new DATA schema UID and retires the old on-chain `dataByContentKey` global-canonical index. (The `dataByContentKey` storage mapping is **retained as a dead slot, no longer written** — not deleted — so the contract's storage layout stays stable for the upgrade-safety snapshot; see the `AGENT-NOTE` at its declaration in `EFSIndexer.sol`.) It is safe to do **now** only because nothing is frozen on Sepolia yet (the localhost data is throwaway). It must land as this coordinated ADR, before redirect work (ADR-0050) depends on the settled shape.
- **Verified feasible:** EAS `SchemaRegistry` does no field-string validation (empty schema registers), and `_getUID` mixes time+bump so identical content still yields distinct DATA UIDs.

### Create flows
- **Native upload:** mint empty `DATA`; attach `contentHash` (keccak256) + `size` PROPERTYs you computed locally. (Optionally a `sha2-256`/`cid` claim for IPFS-world dedup.)
- **Pin a 10 GB IPFS file (no bytes held):** mint empty `DATA`; add `MIRROR(ipfs://CID)`; attach a `cid` PROPERTY (and the sha2-256 digest already inside the CID) — **zero download.**

### Dedup
- **Prevention** (don't create the duplicate) is client-side: before upload, query the property index for a trusted `contentHash` claim and offer "reuse existing DATA?" (then hardlink — a new PIN to the existing DATA — instead of a new DATA). Inherently best-effort; the chain can't verify a hash.
- **Resolution** (a duplicate redirects to canonical) is the REDIRECT primitive — see ADR-0050.

### Reverse lookup ("find the DATA for hash 0x…")
A general **on-chain property index** — `(scope, key, value) → attestations`, i.e. "name lookup, but for property values." This is resolver *logic* (lives in the PIN/`EdgeResolver` hook that sees a property bound to its DATA), so it is upgradeable across the dev window and frozen at burn — it does **not** block the schema freeze and is tracked as its own design (the index need not be perfect at genesis). An off-chain indexer is the always-available fallback. Cost: taxes the property-binding upload path; "per hierarchy level" scoping is a design parameter (the owner wants scoped lookup, e.g. "any DATA under /papers/ whose `contentHash` = 0x…").

### Frozen vs not
| Layer | Status |
|---|---|
| DATA field string `""`, revocable=false | **Frozen** (this ADR) |
| `contentHash` / `size` / `cid` reserved-key PROPERTYs + canonical-preimage + multihash encoding | Convention + reference test vectors (Durable) |
| Property index (find-by-value), dedup-prevention, display merge | Upgradeable resolver logic + client; frozen at burn |

## Consequences
- **Easier:** zero-download remote pins; hash agility + multiple trust-scoped hashes; minimal honest identity; the freeze no longer launders an unverifiable claim as identity.
- **Harder:** every file now needs ≥1 property attestation to carry its hash/size (more attestations per file); integrity/dedup correctness rests on documented conventions + the property index rather than an intrinsic field; the `dataByContentKey` first-writer canonical is gone (replaced by lens-scoped claims + REDIRECT).
- **Revisit:** the on-chain property-index design; a signature-PROPERTY convention for authenticity (#7 firmware); the canonical-preimage spec + vectors.

## Action items
1. [ ] Register DATA as `""`, revocable=false; update specs/02 §3 and `overview.md` (the "nine schemas" table + upload flow steps 2/8 that reference `contentHash`/`dataByContentKey`).
2. [ ] Spec reserved-key PROPERTYs (`contentHash`, `size`, `cid`), canonical preimage, multihash/multibase encoding + reference vectors.
3. [ ] SDK: native-upload helper attaches hash/size PROPERTYs; remote-pin helper extracts sha2-256 from a CID with no download.
4. [ ] Design the on-chain property index (separate ADR; resolver logic, frozen at burn).
