# File-Metadata Encoding Convention (`contentHash`, `size`, `cid`)

> **Status: Accepted** (James ratified 2026-06-20 — see ADR-0060). This spec
> defines the **canonical string format** for the reserved-key file-stat
> PROPERTYs that ADR-0049 moved out of DATA. It changes **no schema**: PROPERTY
> remains `string value` (frozen). It pins the *encoding* of that value, because
> PROPERTY is **non-revocable** (ADR-0052) — a value minted under an ambiguous
> format is permanent. This spec MUST be pinned before any durable data is
> seeded under these keys.

**Related:** ADR-0049 (DATA empty; `contentHash`/`size`/`cid` as reserved-key
PROPERTYs), ADR-0052 (PROPERTY non-revocable; the PIN is the revocable claim),
ADR-0005 (`contentType` reserved-key precedent), ADR-0034 (`name` reserved key),
ADR-0060 (this convention's decision record), specs/02 §2 (Property Schema),
specs/04 (upload workflow), `EFSIndexer.PropertyCreated` (the `valueHash` topic).

---

## 1. Why an encoding convention is needed

A file's **identity** in EFS is its DATA UID (ADR-0049). Everything *about* the
file — content type, display name, and the file-stat metadata covered here —
hangs off that UID as a lens-scoped PROPERTY, bound by a cardinality-1 PIN
(specs/02 §2). The PROPERTY schema field is `string value`, frozen and
format-agnostic: it carries any string. That freedom is the problem. The
workflow docs historically implied a **bare keccak256 hex** for `contentHash`
(`specs/04`). A bare digest is:

- **Algorithm-ambiguous.** A 64-hex-char string is indistinguishable between
  keccak-256 (EVM-native) and sha2-256 (IPFS-native). A verifier in 2050 — SDK
  or Solidity — cannot tell which function to run against the bytes, so it
  cannot verify the claim at all.
- **Permanent.** PROPERTY values are non-revocable interned content (ADR-0052).
  Once a bare-hex `contentHash` is seeded and PINned, that exact string is the
  permanent canonical value; the only retraction is revoking the *binding* (the
  PIN), never the value. An early bad format cannot be cleaned up.

The fix is a **self-describing** value: the algorithm and digest length travel
inside the string itself. The string answers "which hash function?" without an
out-of-band registry.

---

## 2. Canonical format: multibase-prefixed multihash

**`contentHash` values are encoded as a [multibase]-prefixed [multihash].**

A **multihash** is `<hash-fn-code><digest-length><digest-bytes>`, each of the
first two written as an unsigned-varint. For all hash functions EFS uses today
the code and length are single bytes (< 0x80), so a multihash is literally
`0xCC 0x20 <32 digest bytes>` for a 256-bit digest. The **multibase** prefix is
a single leading character naming the base the bytes are then rendered in.

This makes the value self-describing along two axes — *which function* (the
multihash code) and *which text encoding* (the multibase prefix) — with one
short, registry-free, IPFS/IPLD-native string.

### 2.1 Multihash function codes used by EFS

| Hash function | Multicodec name | Code (hex) | Digest length | Use |
|---|---|---|---|---|
| sha2-256 | `sha2-256` | `0x12` | 32 (`0x20`) | **Canonical/default** for `contentHash` (James ratified 2026-06-20); IPFS/IPLD-native; the digest inside a CIDv1 — so a file's EFS `contentHash` and its IPFS CID share one digest |
| keccak-256 | `keccak-256` | `0x1b` | 32 (`0x20`) | Optional alternate the self-describing format CAN carry (EVM-native); NOT the default |

These two are the **only** registered functions for `contentHash` at genesis.
Both are drawn from the canonical [multicodec table]; EFS does not invent codes.
Additional functions (e.g. `blake3` `0x1e`, `sha3-256` `0x16`) MAY be added by a
later revision of this spec, but a writer MUST NOT emit a function not listed
here without that revision — an unrecognized code is a permanent, unverifiable
value.

### 2.2 Multibase: `base16` (lowercase hex) is canonical; `base32` is accepted-on-read

| Base | Multibase prefix | Alphabet | Status |
|---|---|---|---|
| `base16` | `f` | lowercase hex `0-9a-f` | **Canonical** for `contentHash` — emit this |
| `base32` | `b` | RFC 4648 lowercase, no padding | Accepted on read (matches CIDv1 default; see §4) |

**Writers MUST emit `base16` (prefix `f`) for `contentHash`.** Rationale:
base16 round-trips trivially to/from a Solidity `bytes32` (strip `f`, strip the
2-byte multihash header, parse 64 hex chars), so a Solidity verifier needs only
the non-reverting hex parser already in the codebase (ADR-0019) — no base32
decoder on-chain. Lowercase is fixed (not uppercase `F`/base16upper) to give
**exactly one** canonical string per digest, mirroring the
one-representation-per-name discipline of anchor names (specs/02 §1).

**Readers SHOULD accept both `f` (base16) and `b` (base32)** and decode by the
multibase prefix. `base32` appears because a `cid` value (§4) is `base32` by
CIDv1 default; a reader that already decodes multibase handles both for free.

> **Canonical-string warning.** Because the value is non-revocable and is the
> `keccak256(bytes(value))` preimage behind `PropertyCreated.valueHash`, two
> different encodings of the *same* digest (e.g. `f1b20…` vs `b…`, or lowercase
> vs uppercase hex) are **distinct interned values** with **distinct**
> `valueHash` topics — they will not dedup against each other and both persist
> forever. Emitting the single canonical form (`base16` lowercase) is what keeps
> the interning/dedup story (ADR-0052) and the off-chain value index coherent.

### 2.3 The exact `contentHash` string

```
contentHash = <multibase-prefix> || baseEncode( <hashFnCode> || <digestLen> || <digestBytes> )
```

For a sha2-256 digest `D` (32 bytes) — the **canonical/default** function (James
ratified 2026-06-20) — the canonical value is:

```
"f" + lowerhex( 0x12 || 0x20 || D )
```

i.e. the literal string `f1220` followed by the 64 lowercase-hex chars of the
digest. (`f` = base16, `12` = sha2-256, `20` = length 32.) A reader strips `f`,
confirms the `1220` header, and the remaining 64 hex chars are the sha2-256
digest as a `bytes32` — the **same digest embedded in the file's IPFS CID** (§4),
so EFS's `contentHash` and its CID carry one hash, not two.

For the optional keccak-256 alternate, the header is `1b20` instead (`f1b20…`,
`1b` = keccak-256); a reader dispatches on the multihash code either way.

---

## 3. `size`

**`size` is the content length in bytes, encoded as a base-10 ASCII string with
no leading zeros, no sign, no separators, and no unit suffix.**

- `value = "0"` for empty content; `value = "1024"` for 1 KiB; etc.
- **No leading zeros** (`"007"` is non-canonical) — one canonical string per
  length, so two writers agree byte-for-byte and the value interns/dedups.
- **No fixed width.** A fixed-width or zero-padded form was rejected: it adds no
  parsing benefit (decimal-string → integer is trivial in JS and Solidity) and
  breaks the no-leading-zeros canonical rule. Arbitrary length is fine —
  PROPERTY `value` is an unbounded string and there is no anchor-name length cap
  (ADR-0058), so even an astronomically large `size` fits.
- Decimal (not hex) is chosen for human readability and because it is the
  obvious default a naive SDK author reaches for, minimizing the
  ambiguity surface. `size` is **not** self-describing (it needs no algorithm
  tag — a byte count is unambiguous), so the simplest unambiguous encoding wins.

`size` is the byte length of the **content the `contentHash` covers** — the same
preimage. A `size`/`contentHash` pair from one attester describes one byte
string.

---

## 4. `cid`

**`cid` carries an IPFS [CID] (Content IDentifier) as its own canonical
self-describing string** — the standard `cid.toString()` form, which for CIDv1
is `base32` (multibase prefix `b`), e.g. `bafkrei…`.

A CID is *already* a superset of a multihash: `<cid-version><content-codec><multihash>`.
So a `cid` value embeds a sha2-256 (or other) digest **plus** the IPLD content
codec (`raw` `0x55`, `dag-pb` `0x70`, …) that says how the bytes are framed for
IPFS. That extra codec is exactly what a `contentHash` multihash omits.

### 4.1 `cid` vs `contentHash` — when to use which

They are **distinct reserved keys with distinct jobs**, and both MAY coexist on
one DATA:

- **`contentHash`** — a *bare digest of the file bytes*, function-tagged
  (canonical/default **sha2-256**, §2). Use it for content-identity /
  dedup-prevention lookups and for verification (the base16 form round-trips to a
  `bytes32` regardless of function). Because the default sha2-256 digest is the
  *same digest a CIDv1 embeds*, a file's `contentHash` and its `cid` carry **one
  hash, not two**. `contentHash` says nothing about IPFS framing (no IPLD codec) —
  that is what `cid` adds.
- **`cid`** — an *IPFS-addressable identifier*. Use it when the content is (or
  will be) retrievable from IPFS, so the value doubles as the key for an
  `ipfs://<cid>` MIRROR. A `cid` is the right key for the **zero-download remote
  pin** (ADR-0049): pinning a 10 GB IPFS file mints empty DATA + an
  `ipfs://CID` MIRROR + a `cid` PROPERTY, extracting the sha2-256 digest already
  inside the CID with no bytes downloaded.

### 4.2 Relationship to `ipfs://` MIRROR URIs

A `cid` PROPERTY and an `ipfs://<cid>` MIRROR are **complementary, not
redundant**, and SHOULD agree:

- The **MIRROR** (`uri = "ipfs://bafkrei…"`) is a *retrieval* claim — "fetch the
  bytes here" — consumed by the router's transport layer (specs/02 §3a).
- The **`cid` PROPERTY** (`value = "bafkrei…"`) is a *metadata/identity* claim —
  "this content's CID is X" — consumed by content-identity / dedup lookups and
  the property index, independent of whether any mirror currently resolves.

A writer adding an `ipfs://` MIRROR SHOULD also attach the matching `cid`
PROPERTY so the content is discoverable by CID without scanning mirror URIs. The
bare CID (no `ipfs://` scheme prefix) is the canonical `cid` *value*; the scheme
prefix belongs only on the MIRROR `uri`.

---

## 5. Reserved-key PROPERTY registry

The set of reserved PROPERTY **key-anchor names** is **closed and listed here**.
Each is the `name` of a `forSchema = PROPERTY_SCHEMA_UID` key anchor under a
container, bound to a value by a cardinality-1 PIN (specs/02 §2). A client MUST
NOT overload a reserved key for a different purpose. (Reservations are
per-container conventions, exactly as ADR-0034 framed `name`.)

| Reserved key | Container | Canonical value format | Defined by |
|---|---|---|---|
| `contentType` | DATA | IANA media type, e.g. `image/png`; fallback `application/octet-stream` | ADR-0005 |
| `name` | any | display string, NFC-normalized; SHOULD be ≤ 64 chars (clients truncate, never reject) | ADR-0034 |
| `contentHash` | DATA | multibase-`base16` multihash; canonical/default `f1220…` (sha2-256); optional alternate `f1b20…` (keccak-256) — **§2** | ADR-0049 + **this spec** |
| `size` | DATA | base-10 ASCII byte count, no leading zeros — **§3** | ADR-0049 + **this spec** |
| `cid` | DATA | IPFS CID string (CIDv1 default `base32`, `bafkrei…`) — **§4** | ADR-0049 + **this spec** |

Non-reserved but conventional keys (free for client use, NOT governed here):
`previousVersion` (a DATA UID), `description`, `icon` (specs/02 §2).

### 5.1 Multiple coexisting hashes

ADR-0049 permits multiple coexisting hash claims. They coexist **by encoding, not
by minting extra keys**: because a `contentHash` value is self-describing, the
*same* `contentHash` key anchor can hold either a sha2-256 (`f1220…`, the
canonical default) or a keccak-256 (`f1b20…`, the optional alternate) value, and a
reader dispatches on the multihash code. The cardinality-1 PIN means one
attester's `contentHash` slot holds **one** value at a time, so:

- With **sha2-256 canonical** (James ratified 2026-06-20), the common case needs
  no dual hash at all: `contentHash` and `cid` share the *same* sha2-256 digest,
  so one digest serves both EVM-side identity/dedup and the IPFS CID. An attester
  wanting an additional **keccak** claim (e.g. for a contract that wants the
  EVM-native function) carries it in the self-describing `contentHash` slot
  (`f1b20…`) — or keeps sha2 in `contentHash` and the CID in `cid`.
- This avoids needing a `contentHash:keccak` / `contentHash:sha2` keyspace
  explosion or a multi-value (TAG) binding. The self-describing prefix plus the
  `contentHash`/`cid` split covers the dual-hash case cleanly.

> **Resolved (James ratified 2026-06-20, ADR-0060):** keep the **single
> self-describing `contentHash` slot** with **sha2-256 canonical** (sharing the
> CID digest); keccak-256 remains an optional alternate the format CAN carry. No
> algorithm-suffixed keyspace.

---

## 6. Verification semantics

- **The hash is a lens-scoped *claim*, never authenticated identity.** Per
  ADR-0049 the bytes are not on-chain, so the kernel cannot and does not verify
  `contentHash`↔bytes. A `contentHash` is what *one attester* asserts about the
  content; a reader trusts it exactly insofar as they trust that attester (lens
  scoping, ADR-0014). It is **not** the file's identity (the DATA UID is).
- **Who verifies, and when.** Verification is the **consumer's** job, **at read
  time**, off-chain (or in a verifying contract that has the bytes):
  1. Fetch the bytes via a MIRROR.
  2. Read the lens-scoped `contentHash` value; decode the multibase + multihash
     header to learn the function (`0x1b` ⇒ keccak-256, `0x12` ⇒ sha2-256).
  3. Recompute that function over the fetched bytes; compare digests; compare
     `size` to the byte length.
  4. A mismatch means the *attester's claim is wrong* (or the mirror is lying) —
     surface it; it is never a kernel-level failure.
- **Self-describing is what makes step 2 possible.** A bare-hex value gives the
  verifier no function to run; the multihash code is load-bearing for
  verifiability.
- **Retraction is by revoking the PIN binding, never the value** (ADR-0052). To
  withdraw a wrong `contentHash`, an attester revokes the PIN that binds it (or
  supersedes it with a new PIN at the same slot). The non-revocable value
  attestation itself stays interned — possibly shared by other bindings — and is
  never the unit of retraction.
- **`valueHash` is not the content hash.** `EFSIndexer.PropertyCreated` emits
  `valueHash = keccak256(bytes(value))` — the keccak of the *string* (e.g. of
  `"f1b20c5d2…"`), used as the value's interning/dedup content key. It is **not**
  `keccak256(file bytes)`. Do not conflate the two; the canonical `contentHash`
  string defined here is what gets interned, and *its* keccak is `valueHash`.

---

## 7. Conformance vectors

For each input byte string, an SDK author and a Solidity verifier MUST produce
**byte-identical** values. Digests verified against Node `crypto`/`viem`
(`sha256`, `keccak256`); CIDs verified against `multiformats`
(`CID.create(1, raw, sha256)`). The **canonical/default** `contentHash` is the
**sha2-256 `base16`** form (`f1220…`, James ratified 2026-06-20) — bolded below;
it shares its digest with the `cid`. The keccak-256 rows are the optional alternate
the format can carry; the `base32` and `cid` columns are accepted-on-read /
IPFS-side forms.

### Vector 1 — empty content (`""`, 0 bytes)

| Field | Canonical value |
|---|---|
| `size` | `0` |
| sha2-256 digest | `0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| **`contentHash`** (sha2, base16 — canonical/default) | `f1220e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| **`cid`** (CIDv1 raw + sha2-256, shares the digest) | `bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku` |
| keccak-256 digest (alternate) | `0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470` |
| `contentHash` (keccak, base16 — alternate) | `f1b20c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470` |
| `contentHash` (keccak, base32) | `bdmqmlusgagdpoiz4sj7h3mw4y4b4bziawzj4varhhn57vwaelwc2i4a` |

### Vector 2 — `abc` (3 bytes: `0x61 0x62 0x63`)

| Field | Canonical value |
|---|---|
| `size` | `3` |
| sha2-256 digest | `0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad` |
| **`contentHash`** (sha2, base16 — canonical/default) | `f1220ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad` |
| **`cid`** (CIDv1 raw + sha2-256, shares the digest) | `bafkreif2pall7dybz7vecqka3zo24irdwabwdi4wc55jznaq75q7eaavvu` |
| keccak-256 digest (alternate) | `0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45` |
| `contentHash` (keccak, base16 — alternate) | `f1b204e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45` |
| `contentHash` (keccak, base32) | `bdmqe4a3fplvelkkpy7khxkbgzdlgpqgr43rtuzfag3wej5mpuewwyri` |

### Vector 3 — `hello\n` (6 bytes: `hello` + LF `0x0a`)

| Field | Canonical value |
|---|---|
| `size` | `6` |
| sha2-256 digest | `0x5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03` |
| **`contentHash`** (sha2, base16 — canonical/default) | `f12205891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03` |
| **`cid`** (CIDv1 raw + sha2-256, shares the digest) | `bafkreicysg23kiwv34eg2d7qweipxwosdo2py4ldv42nbauguluen5v6am` |
| keccak-256 digest (alternate) | `0x1d63660020a5b5062fb35d9f82afa81581442281c43343763ab1d340e9861bae` |
| `contentHash` (keccak, base16 — alternate) | `f1b201d63660020a5b5062fb35d9f82afa81581442281c43343763ab1d340e9861bae` |
| `contentHash` (keccak, base32) | `bdmqb2y3gaaqklnigf6zv3h4cv6ublakeeka4im2doy5ldu2a5gdbxlq` |

### 7.1 Reconstruction recipe (for an implementer)

To regenerate the canonical `contentHash` from the file bytes:

1. Compute the **sha2-256** digest `D` of the bytes (canonical/default function).
2. Prepend the multihash header bytes `0x12 0x20` (sha2-256, length 32) to `D`.
3. Lowercase-hex-encode the 34-byte result.
4. Prepend the multibase prefix `f`. → `f1220<64-hex sha256>`.

(For the optional keccak-256 alternate, use function code `0x1b` in step 2 →
`f1b20…`. A reader dispatches on the multihash code regardless.)

To regenerate `cid` (CIDv1, raw codec, sha2-256): `CID.create(1, 0x55,
multihash(0x12, sha256(bytes))).toString()`. The leading `bafkrei` is the
CIDv1/base32/raw/sha2-256 signature shared by every vector above. Note the `cid`
and the canonical `contentHash` embed the **same** sha2-256 digest `D`.

---

## 8. Migration of existing prose

`specs/04` (upload workflow) currently says "compute `keccak256(bytes)` for
`contentHash`" and "byte count as decimal string" for `size`. The `size` prose
is already correct (§3). The `contentHash` prose MUST be updated to compute the
**sha2-256** digest and emit the canonical multibase-multihash form (`f1220…`,
sha2-256 — James ratified 2026-06-20) rather than a bare keccak `0x…` hex, so the
`contentHash` shares the IPFS CID digest. This must land **before any durable data
is seeded** — the gate ADR-0060 records. (That edit is owned by another agent per
the worktree split; this spec is the normative target it points at.)

[multibase]: https://github.com/multiformats/multibase
[multihash]: https://github.com/multiformats/multihash
[multicodec table]: https://github.com/multiformats/multicodec/blob/master/table.csv
[CID]: https://github.com/multiformats/cid
