# ADR-0049: File content identity — hash is data, not identity

**Status:** Proposed
**Date:** 2026-05-31
**Deciders:** James (schema freeze is human-gated)
**Permanence-tier:** Etched (defines the frozen DATA shape)
**Related:** ADR-0048 (proxy-ready resolvers + freeze set), ADR-0032 (EAS as foundation), specs/02 §3 (DATA), §2 (PROPERTY), §3a (MIRROR)

## Context

A file's **identity** in EFS is the DATA attestation's EAS UID. MIRRORs (`refUID = DATA`), folder placements (PIN `refUID = DATA`), and metadata (PROPERTY `refUID = DATA`) all reference that **UID** — never the content hash. So the identity/placement/retrieval layer is independent of how (or whether) we hash the bytes.

DATA today is `bytes32 contentHash, uint64 size` where `contentHash = keccak256` of the file bytes. That field does two jobs: **dedup** (`EFSIndexer.dataByContentKey[contentHash]` = first DATA per hash) and **integrity** (a downloader can re-hash and compare).

**The problem (write-time impossibility).** Forcing `contentHash = keccak256-of-bytes` makes it impossible to create a file identity for large remote content-addressed files without downloading them: pinning a 10 GB file already on IPFS would require the browser to download all 10 GB just to compute keccak256. This breaks central use cases (firmware mirrors, podcast archives, CAD libraries — indexing the existing content-addressed web). Meanwhile that content **already has an address** (its IPFS CID, a sha2-256 multihash) the pinner knows for free.

**Two facts that decide the design:**
1. `contentHash` is **client-supplied and unverifiable on-chain** (the bytes aren't on-chain). So keccak256's only real advantage — being the cheap EVM-native hash — *does not apply to this field*. It is just stored bytes the client computes off-chain.
2. EAS physics: **changing** the frozen DATA field orphans all DATA; **adding** schemas/PROPERTYs later orphans nothing; **resolver logic is upgradeable** (then burned to immutable), but the **fields it can read are frozen** at registration.

## Decision

**Keep `DATA = "bytes32 contentHash, uint64 size"`, revocable `false`, and freeze it AS-IS. No field change. No migration. No orphaning.** The owner's steer — "the hash is *data* attached to the file, not baked into identity" — is realized **without touching the frozen schema**, by reinterpretation + additive layers:

1. **`contentHash == bytes32(0)` is a first-class, valid value** meaning "this file identity carries no inline byte-hash." A DATA minted with `contentHash = 0` is fully placeable, retrievable, listable — never a degraded/error state. This is the normal path for pinning remote content. (`size` may be `0` = unknown, or the cumulative size IPFS/Arweave report without a download.)
2. **The durable, agile, trustworthy hash lives in self-describing PROPERTYs** bound to the DATA UID via the existing key-anchor + cardinality-1 PIN pattern (exactly like `contentType`/`name`). Reserved keys, values are **multibase-encoded multihash / CID strings**, lens-scoped per attester:
   - `hash:keccak256`, `hash:sha2-256`, future `hash:blake3`, … — flat-bytes integrity, self-describing algorithm.
   - `cid` — an IPFS/IPLD CID, explicitly a **DAG locator**, not a flat-bytes digest.
   This gives algorithm agility, multiple coexisting claims per file, and trust-scoping — all in the additive/upgradeable layer, none of it frozen into identity.
3. **`dataByContentKey[contentHash]` stays an advisory, native-keccak-only fast-path index — it never gates placement or retrieval.** A new multibase-multihash **advisory** dedup index lives in upgradeable-then-frozen resolver logic on the **PIN/EdgeResolver hook** (NOT `PropertyResolver` — that hook is standalone/`pure` and cannot read the parent DATA at attest time). Advisory forever: a hash front-runner can capture a pointer but can never block an honest uploader.

### Create flows

- **Native upload (you hold the bytes):** mint `DATA(contentHash = keccak256(bytes), size)`. Optionally also attach a `hash:sha2-256` PROPERTY for IPFS-world dedup. Unchanged from today.
- **Pin a 10 GB IPFS file (you don't hold the bytes):** mint `DATA(contentHash = 0, size = <cumulative size from CID, no download>)`; add a `MIRROR(ipfs://CID)`; attach a `cid` PROPERTY (the CID, locator-grade). **Zero bytes downloaded.** Anyone else pinning the same CID attaches the same `cid`/`hash:sha2-256` claim, so the advisory index can group them.

### Frozen vs not

| Layer | Status |
|---|---|
| DATA field string `bytes32 contentHash, uint64 size`, revocable=false | **Frozen** (unchanged) |
| `contentHash == 0` = "no inline hash" semantics | Convention (documented invariant) |
| Hash/CID PROPERTY reserved keys + multihash encoding | Convention + reference test vectors |
| Advisory dedup index (keccak fast-path + multihash) | Upgradeable resolver logic → frozen at burn |

## Why not the alternatives

The panel stress-tested four models. All three judges converged on **this** outcome regardless of which they named "winner":
- **In-field `bytes32 + uint8 hashAlg`** — disqualified: a fixed 32-byte slot forecloses non-256-bit and future algorithms (sha2-512, blake3-512, post-quantum), so the dominant remote corpus falls back to `0` anyway. Freezes agility out.
- **In-field full multihash `bytes contentId`** — its self-describing format is right, but putting it *in identity* freezes a variable-length field and gas cost forever, when it belongs in the additive PROPERTY layer.
- **Keep field, make `contentHash` optional** — this is the chosen shape; the judges' synthesis is "this field shape + the hash-as-PROPERTY architecture," i.e. M4's zero-migration field with M1's integrity story.

## Residual risks (conventions to settle before launch — none require a schema change)

1. **Cross-address dedup is unsolved on-chain** (same bytes via keccak vs IPFS CID vs Arweave txid land in different keys). **Accepted:** on-chain dedup degrades *discovery* only, never correctness. Convergence is a client/lens concern (group by matching claims / MIRROR.uri).
2. **Integrity = unenforced convention.** The resolver can't validate a client-supplied digest. Freeze a **canonical preimage spec** ("raw flat file bytes, no DAG/transport framing") + multibase/multicodec encoding + **reference test vectors**, or 100 years of client drift breaks bit-identical verification. This is the dominant long-horizon integrity risk.
3. **Right-to-be-forgotten hole.** A hash PROPERTY is non-revocable and permissionless: anyone can attest a permanent fingerprint of sensitive content (medical #10, oral history #6) against a DATA UID without consent, unremovable. No clean on-chain defense. Default native-upload SDK to `contentHash=0` for sensitive contexts; consider a salted/HMAC commitment convention for commitment-without-fingerprint.
4. **CID ≠ flat-bytes integrity.** An IPFS CID is a UnixFS-DAG digest, not a hash of the flat bytes. Use distinct reserved keys (`cid` = locator, `hash:*` = flat-bytes) so a verifier never false-alarms re-hashing flat bytes against a DAG digest.
5. **Authenticity ≠ integrity (#7 firmware).** A hash proves bytes-equal-X, not signed-by-vendor. Detached signatures are a separate convention PROPERTY (declared algorithm/key-encoding), not in scope of this ADR.
6. **Advisory pointer front-run.** `dataByContentKey` first-writer-wins is harmless only while strictly advisory; no client may ever gate placement/retrieval on it.

## Consequences

- **Easier:** pinning the existing content-addressed web becomes a zero-download operation; hash agility, multiple hashes, and trust-scoped integrity all become possible and evolvable; the frozen surface shrinks to the minimum; **DATA can be frozen now, exactly as it stands.**
- **Harder:** integrity/dedup correctness now rests on documented client conventions + reference vectors rather than on-chain enforcement; clients must implement the multihash/CID convention and lens-scoped hash resolution.
- **Revisit:** a salted-commitment convention for sensitive content; a signature-PROPERTY convention for authenticity; whether to add an upgradeable resolver index over normalized MIRROR.uri for cross-address grouping before the burn.

## Action items

1. [ ] Freeze DATA as-is; record the `contentHash == 0` first-class semantics in specs/02 §3.
2. [ ] Spec the reserved hash/CID PROPERTY keys, the canonical preimage definition, and multibase/multicodec encoding, with reference test vectors.
3. [ ] Implement the advisory multihash dedup index on the PIN/EdgeResolver hook (upgradeable logic; advisory-only; validated before burn).
4. [ ] SDK: default sensitive-context uploads to `contentHash = 0`; helpers to extract sha2-256 from a CID and attach hash/CID PROPERTYs without downloading.
5. [ ] Document the cross-address-dedup, right-to-be-forgotten, and CID-vs-flatbytes caveats in specs/02.
