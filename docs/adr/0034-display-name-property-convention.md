# ADR-0034: `name` PROPERTY as display-name fallback

**Status:** Accepted
**Date:** 2026-04-18
**Related:** ADR-0002 (DATA standalone), ADR-0003 (TAG-based placement), ADR-0005 (contentType as PROPERTY), ADR-0014 (edition-scoped PROPERTY lookup), ADR-0016 (deployer fallback), ADR-0031 (editions model), ADR-0033 (root containers)

## Context

Every first-class EFS object is a `bytes32` — anchors, DATAs, addresses-as-containers, schemas, attestations. Several of those have no intrinsic human-readable label:

- Addresses — ENS gives us `vitalik.eth` for a small subset; everything else is `0x8626…1199`.
- Schemas — `SchemaRegistry` stores only the field-list string; no `name` column.
- Attestations — none.
- Anchors — the anchor's `name` field is the path segment within its parent, not a standalone "what is this?" label for chips without room for a full path.

Rendering raw hex everywhere reads badly, and will read worse once comments, mentions, and notifications arrive. "0x8626…1199 commented on 0x3f4a…12ab" is unusable; "James commented on `memes/cat.jpg`" is the product.

ENS is the obvious source for address labels but (1) it only covers addresses, (2) it requires mainnet lookups that stay off-chain per ADR-0033, and (3) it is global — one name per address — which doesn't capture the social reality that *my* name for an address (`"my brother Ted"`) should override *the world's* name for it.

A first draft of this ADR placed a PROPERTY *directly* on the container via `refUID`:

```
PROPERTY(refUID = <containerUID>, key = "name", value = "…")
```

That collided with the existing design for DATA (ADR-0002 / ADR-0003): DATAs are free-floating content identity that gets *placed* at anchors via TAG, not attached via `refUID`. The user pointed out the inconsistency — "no real reason for PROPERTY and DATA to be different" — so this ADR now establishes the symmetric model: PROPERTY is a free-floating value, placed via TAG under an `Anchor<PROPERTY>` that holds the key.

Anchors are the static tree the user navigates. Free-floating content (DATA, PROPERTY) attaches to anchors via TAG. The per-attester singleton semantics of `TagResolver._activeByAAS` then give us "Alice's current name for Vitalik" as a natural consequence, not a bespoke lookup.

## Decision

### 1. Unified free-floating model

PROPERTY schema becomes symmetric with DATA:

```
PROPERTY schema:  string value             (non-revocable)
DATA schema:      bytes32 contentHash, uint64 size    (non-revocable)
```

A PROPERTY attestation is a standalone value (`refUID = 0x0`, `recipient = 0x0`). Placement is via TAG under an `Anchor<PROPERTY>(name="<key>")` — the name anchor holds the key; the free-floating PROPERTY holds the value; the TAG binds them under one attester.

Per-attester singleton comes for free from `TagResolver._activeByAAS[definition][attester][PROPERTY_SCHEMA_UID]`. Alice's current "name" value for Vitalik is whichever PROPERTY she last TAG'd under `Vitalik / name` — a new TAG from Alice supersedes her previous one automatically (ADR-0003). Revocation of the TAG (not the PROPERTY) removes the binding.

PROPERTY itself is non-revocable — values are permanent, the *binding* is what gets moved. This mirrors DATA's non-revocability: the bytes of a file don't get "unpublished"; only the TAG that places them at a path can be revoked.

### 2. The `name` convention

A human-readable display name for any container `C` is:

```
C                                             // any bytes32: anchor / DATA / address-as-bytes32 / schema UID / attestation UID
└── Anchor<PROPERTY>(parent=C, name="name")   // the key anchor — `schemaUID = PROPERTY_SCHEMA_UID`
    └── TAG(definition=nameAnchor, refUID=property, attester=alice)
        → PROPERTY(value="Vitalik Buterin")
```

For an address container, the name anchor is created with `recipient = addr` rather than `refUID = containerUID` — the anchor schema lets `recipient` substitute for `refUID` when the parent is an address (specs/02 §Anchor; ADR-0033).

Reserved key: the anchor name `"name"` is reserved for the display-name convention at any container. Clients MUST NOT overload `"name"` for arbitrary user labels (use `"label"` or `"alias:<context>"`). The reservation is per-container, not global — a file-DATA's `name` anchor is its display name, an anchor's `name` anchor is its display name, etc.

Length: names SHOULD be ≤ 64 characters; clients SHOULD truncate with ellipsis for display; they MUST NOT reject. (Enforcing a max on-chain would need a PROPERTY resolver; out of scope.)

### 3. Resolution — the display-name hierarchy

When a client needs a display name for a container UID `C`, it resolves in order and stops at the first hit:

1. **If `C` is an address:** ENS reverse-lookup (off-chain, `publicClient.getEnsName`). Mainnet only; skipped otherwise. Clients cache aggressively.
2. **`name` via TAG + PROPERTY, edition-scoped:**
   - Look up `nameAnchor = Indexer.resolveAnchor(C, "name", PROPERTY_SCHEMA_UID)`. If missing, go to step 3.
   - For each attester in the active editions list (ADR-0031 order: explicit `?editions=` → `[caller]` → `[DEPLOYER]`), fetch `_activeByAAS[nameAnchor][attester][PROPERTY_SCHEMA_UID]`.
   - First attester with an active entry wins. Read the TAG, follow `refUID` to the PROPERTY, decode `value`.
3. **Schema fallback:** if `C` is a schema UID and `SchemaRegistry.getSchema(C).uid != 0`, show the field-list string (deployer-seeded alias anchors handled transparently by step 2).
4. **Short-hex fallback:** `0x8626…1199` for addresses, `0x3f4a…12ab` for other 32-byte UIDs.

Step 2 is the load-bearing step. Steps 1, 3, 4 are narrow-purpose.

### 4. Edition scoping

The default viewer is the connected wallet; the default fallback is the deployer (ADR-0016). Unconfigured viewers see the deployer's naming — which is what the pre-seeded aliases produce. A viewer who TAGs their own `name` PROPERTY under any container's name anchor overrides the deployer's label *for themselves* — matching ADR-0014's "your view, your names" property.

Cross-attester injection is blocked by the `_activeByAAS[nameAnchor][attester][…]` split: a malicious attester cannot force their naming of Vitalik into my view. I'd have to add them to `?editions=` first.

### 5. Deploy-time seeding

The user's guidance: "lazy unless it's an important one." We pre-seed only the containers users are likely to see raw:

1. **System schemas** (6) — each alias anchor per ADR-0033 gets an `Anchor<PROPERTY>(name="name")` child, a free PROPERTY with `value="ANCHOR"` / `"DATA"` / etc., and a TAG binding them. Handled by `06_schema_aliases.ts`.
2. **Dev personas** (20, localhost/devnet only) — each Hardhat deterministic address gets the same treatment, with `value="Satoshi Nakamoto"` / etc. Handled by `07_persona_names.ts`. Skipped on live networks.
3. **EFS contracts** — Indexer / Router / etc. are deferred (FUTURE_WORK) unless the production UI actually renders them as bare addresses.

Arbitrary DATAs, attestations, and user addresses are NOT pre-seeded — they'd fall through to step 4 (short-hex) until a user attests a name.

### 6. Client mutation UI

A container's info panel gets an editable "Name" field. Submitting:
1. If the name anchor doesn't exist under the container, attest `Anchor<PROPERTY>(parent=C, name="name")`.
2. Attest a free-standing `PROPERTY(value=<input>)`.
3. Attest a `TAG(definition=nameAnchor, refUID=propertyUID, applies=true)`.

Can be batched into a single `multiAttest`. The new TAG supersedes the caller's previous name binding per `_activeByAAS` singleton semantics (ADR-0003).

## Consequences

**Enables**

- Comments, notifications, mentions, feeds, timelines — anywhere an address/schema/attestation/DATA UID appears, we render a name.
- Per-viewer naming. My address book is mine; another viewer sees theirs (or the deployer's).
- No new schema kinds, no new resolver, no new index — reuses the existing TAG singleton machinery and the `_nameToAnchor` directory for key-anchor lookup.
- Schemas and attestations get EFS-native human labels without touching EAS (ADR-0032 intact).
- Symmetric with DATA — one mental model (free-floating value + TAG placement under a key anchor) covers both.

**Costs**

- Three attestations per name seed instead of one (anchor + property + tag). Worth it for the uniformity; batch via `multiAttest`. Pre-launch acceptable; mainnet deploy only runs the small schema-alias set.
- Reserved anchor name `"name"` at each container — follows the `"contentType"` reservation precedent (ADR-0005).
- ENS dependency in step 1 requires a mainnet RPC round-trip in the client. Clients cache; non-mainnet viewers skip step 1.

**Load-bearing**

- `TagResolver._activeByAAS` singleton is the security boundary. Without it, any attester could inject display names onto anyone else's view — a phishing vector ("0xdeadbeef" displayed as "Vitalik Buterin").
- Schemas and attestations have no ENS analog; step 2 is the only meaningful label source. This is why the deploy-seeded aliases matter — unconfigured viewers would otherwise see raw schema UIDs.

## Alternatives considered

1. **Direct PROPERTY on container** via `refUID = containerUID`. Drafted first, rejected: breaks symmetry with DATA, needs per-container-kind validation in the PROPERTY resolver, and conflates value with placement.
2. **A dedicated `NAME` schema with fields `(bytes32 target, string name)`.** Rejected — duplicates the TAG-placement pattern, needs its own per-attester singleton index, no structural gain.
3. **An anchor-based name registry under `/names/<name>/ → TAG(address)`.** Rejected — forces reverse lookup ("what is this address called?") to scan the name space; doesn't edition-scope naturally.
4. **ENS-only; no EFS-native names.** Rejected — doesn't cover schemas/attestations/anchors, and forces mainnet dependency for a primitive we already have.
5. **Global name registry (first-attester-wins or dictator).** Rejected — violates per-viewer sovereignty. My label should never leak to your view unless you trust me.
6. **Store names in the anchor's `name` field directly.** Rejected — the anchor's `name` is the path segment (used for routing; unique via `_nameToAnchor`). Overloading would fight the invariant and wouldn't cover addresses/schemas/attestations at all.
