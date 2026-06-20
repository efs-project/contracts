# ADR-0060: `contentHash`/`size`/`cid` use a self-describing encoding (multibase-multihash + CID)

**Status:** Proposed
**Date:** 2026-06-20
**Deciders:** James (convention pinned before durable seeding is human-gated)
**Permanence-tier:** Durable (convention + reference vectors; no schema change)
**Related:** ADR-0049 (DATA empty; `contentHash`/`size`/`cid` as reserved-key PROPERTYs), ADR-0052 (PROPERTY non-revocable — the PIN is the revocable claim), ADR-0005 (`contentType` reserved-key precedent), ADR-0034 (`name` reserved key), ADR-0014 (lens-scoped PROPERTY reads), ADR-0019 (non-reverting hex parser), specs/10 (the normative convention + conformance vectors), `EFSIndexer.PropertyCreated` (the `valueHash` "canonical-hashing spec" reference), `docs/FUTURE_WORK.md` ("contentHash self-describing encoding spec + vectors"), `docs/FS_OPERATIONS_AUDIT.md` §gate.

## Context

ADR-0049 reshaped DATA to an empty schema and moved `contentHash` and `size` out
of DATA into **reserved-key PROPERTYs** bound to the DATA UID (with `cid` for the
IPFS side), lens-scoped per attester. The PROPERTY schema field is `string value`
— **frozen** and format-agnostic, so the *schema* is fine. The unsettled piece is
the **encoding convention** for these values, and two facts make getting it right
urgent and one-shot:

1. **PROPERTY values are non-revocable** (ADR-0052). A value, once minted and
   interned, is permanent; only the *binding* (the PIN) is revocable. An early
   bad/ambiguous value string can never be cleaned up — it persists forever and
   pollutes the `valueHash` interning/dedup index.
2. **The current workflow prose is algorithm-ambiguous.** `specs/04` implies a
   **bare keccak256 hex** for `contentHash`. A bare 64-hex digest is
   indistinguishable between keccak-256 (EVM-native) and sha2-256 (IPFS-native):
   a future SDK or Solidity verifier cannot tell which function to recompute
   against the bytes, so the claim is unverifiable. `EFSIndexer.PropertyCreated`
   already defers to a "forthcoming canonical-hashing spec"; this is that spec's
   decision record. The gap is flagged in `docs/FUTURE_WORK.md` and the FS-ops
   audit as a **gate before durable seeding**.

Because EFS already targets IPFS/IPLD (it has `ipfs://` mirrors, a `/transports/ipfs`
anchor, and a zero-download remote-pin flow that lifts the sha2-256 digest out of
a CID), the encoding should be the one the IPFS/IPLD world already speaks.

## Decision

Adopt a **self-describing, algorithm-tagged** encoding for the file-stat values.
The full normative spec — exact byte layout, the closed reserved-key registry,
verification semantics, and conformance vectors — is **specs/10**. The decision:

1. **`contentHash` is a multibase-prefixed [multihash].** The hash-function code
   (`0x1b` keccak-256, `0x12` sha2-256) and digest length travel inside the
   string, so it is self-describing. **Canonical emit form is multibase `base16`
   lowercase (prefix `f`)** — e.g. `f1b20<64 hex>` for keccak-256 — because it
   round-trips trivially to a Solidity `bytes32` via the existing non-reverting
   hex parser (ADR-0019), needing no on-chain base32 decoder. Readers SHOULD also
   accept `base32` (prefix `b`). keccak-256 is the **default** for native
   uploads (EVM-native); sha2-256 is available and is what a CID embeds.

2. **`cid` is a distinct reserved key** carrying a full IPFS CID
   (`CID.toString()`, CIDv1 `base32` `bafkrei…`). A CID is a superset of a
   multihash (it adds the IPLD content codec), so `cid` is the right key when the
   content is IPFS-addressable and doubles as the `ipfs://<cid>` mirror key and
   the zero-download remote-pin value. `contentHash` (bare digest, EVM side) and
   `cid` (IPFS-framed) are **complementary**; both MAY coexist on one DATA.

3. **`size` is a base-10 ASCII byte count** — no leading zeros, no sign, no unit,
   no fixed width. One canonical string per length (so values intern/dedup);
   decimal because it is the obvious unambiguous default and needs no algorithm
   tag.

4. **The reserved-key set is closed and registered** (specs/10 §5):
   `contentType`, `name`, `contentHash`, `size`, `cid`. Multiple coexisting
   hashes (keccak + sha2) are expressed **by encoding** — a self-describing
   `contentHash` slot plus the separate `cid` key — not by minting an
   algorithm-suffixed keyspace.

5. **No schema change.** PROPERTY stays `string value` (frozen); DATA stays empty
   (ADR-0049). This ADR is a Durable *convention* gated to land **before any
   durable data is seeded** under these keys — after seeding, the format is
   permanent for those values.

Verification stays a **lens-scoped, read-time, off-chain** consumer
responsibility (ADR-0049/0014): the kernel never checks hash↔bytes; a reader
decodes the multihash code, recomputes that function over fetched bytes, and
compares. Retraction is by **revoking the PIN binding, never the value**
(ADR-0052).

## Consequences

- **Enables.** Permanently verifiable claims — a 2050 verifier reads the
  function out of the value. EVM and IPFS hash worlds coexist cleanly
  (`contentHash` keccak default + `cid` sha2). Cheap Solidity verification (base16
  → `bytes32` with the existing parser). Conformance vectors let an SDK author
  and a Solidity verifier produce byte-identical values.
- **Costs / implies.** **SDK and any verifying contract MUST agree** on specs/10
  exactly — a deviation produces a distinct, permanent, non-deduping value.
  `specs/04` workflow prose must change from bare keccak hex to the canonical
  `f1b20…` form (owned by another agent; specs/10 §8 is the target). Writers must
  emit the single canonical encoding (base16 lowercase; no leading zeros on
  `size`) or fragment the interning/dedup index.
- **Gate.** This convention **must be pinned (Status: Accepted) before durable
  data is seeded** under `contentHash`/`size`/`cid`. Until then it is Proposed
  and blocks durable seeding, per `docs/FUTURE_WORK.md` and the FS-ops audit.
- **Revisit.** Adding hash functions (blake3, sha3-256) is a future specs/10
  revision — additive (new multihash codes), not a break, since old values stay
  valid and self-describe. The single-`contentHash`-slot vs algorithm-suffixed-keys
  question (specs/10 §5.1) is flagged for maintainer confirmation.

## Alternatives considered

- **Bare keccak-256 hex (`0x…`, status quo in `specs/04`).** *Rejected.*
  Algorithm-ambiguous (keccak vs sha2 indistinguishable) and, being
  non-revocable, permanently unverifiable. This is the exact gap the ADR closes.
- **A `keccak256:`/`sha2-256:` ASCII-prefix scheme.** *Rejected.* Self-describing
  but bespoke — not the IPFS/IPLD vocabulary EFS already targets, no shared
  tooling, and invites prefix-spelling drift (`keccak-256:` vs `keccak256:`),
  re-introducing ambiguity. Multihash is the standardized form of the same idea.
- **CID as the sole canonical form for `contentHash`.** *Rejected as the default.*
  A CID forces an IPLD content codec (`raw`/`dag-pb`) choice that is meaningless
  for a pure EVM keccak digest, and CIDv1 default base32 does not round-trip to
  `bytes32` as cheaply as base16. CID is kept as the distinct `cid` key for the
  IPFS-addressable case, where the content codec is meaningful.
- **An on-chain `contentHash` field on DATA (pre-ADR-0049 shape).** *Rejected by
  ADR-0049 and not reopened here.* The bytes are never on-chain, so a hash field
  welds an unverifiable client claim into permanent identity and blocks
  zero-download remote pins. Keeping hash as a lens-scoped PROPERTY claim is the
  settled position; this ADR only fixes that claim's *string encoding*.
- **Mandate a single hash algorithm (keccak-only).** *Rejected.* IPFS dedup and
  the zero-download remote pin need the sha2-256 digest that lives inside a CID;
  forcing keccak-only would forfeit IPFS interop. Self-describing values let both
  coexist at no schema cost.
