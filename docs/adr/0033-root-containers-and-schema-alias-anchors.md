# ADR-0033: Root containers and schema alias anchors

**Status:** Accepted
**Date:** 2026-04-17
**Related:** ADR-0011 (transport anchors), ADR-0013 (edition-scoped mirror selection), ADR-0016 (deployer fallback), ADR-0019 (non-reverting hex parser), ADR-0025 (anchor name validation), ADR-0031 (editions model)

## Context

Before this ADR, EFS URLs had exactly one root: the anchor tree. Every URL walked from `rootAnchorUID` by name (`/memes/cat.jpg`). To surface an EAS *schema*, *attestation*, or Ethereum *address* as a browsable thing, you either had to wrap it in a synthetic `/schemas/<name>/` folder (fine for six system schemas, impractical for addresses) or build a separate URL scheme. Neither matched user expectation: when you type `vitalik.eth` or paste a schema UID into an omnibar, you want *that object* — not to be told about folders.

The contracts already supported this implicitly:

- `TagResolver._validateDefinition` accepts `definition` = address / schema / attestation / anchor.
- `_activeByAAS[definition][attester][targetSchema]` is generic over `bytes32` keys.
- ANCHOR's spec permits `refUID` = parent anchor, user address, or any `bytes32`, and the `_nameToAnchor[parentKey][name][schema]` index treats the parent as opaque.
- `EFSFileView.getDirectoryPage` takes any `bytes32` as the container UID.

So the root of the URL tree can accept four kinds of children without any new storage, resolver rules, or indices.

Addresses, schemas, and attestations are **ambient Ethereum objects** — they exist independently of EFS. Anchors are EFS-native. Wrapping ambient objects in folders (`/addresses/vitalik.eth/…`) would either require deploy-time seeding (impossible for the address/attestation case — infinite space) or produce synthetic parent directories that can't be correctly enumerated and that stray anchors can pollute. Direct children of root, peer to anchors, is cleaner.

For schemas specifically, there's a second concern: a raw schema UID in EAS is just json — no room for EFS metadata (human-readable name, description, comments, related tags). To attach those, we need an on-chain home. We promote the "give schemas an EFS-native home" idea to the canonical representation: **a schema is represented in EFS by an anchor at root whose name is the schema's UID in hex.** Interactions attach to the anchor. The raw EAS schema stays pristine.

## Decision

### 1. Root containers — four peer flavors

Root (`rootAnchorUID`) has four kinds of children, classified by URL segment shape (precedence top-to-bottom):

| Flavor      | URL form                           | Seeded `currentParent`                         |
|-------------|------------------------------------|------------------------------------------------|
| Address     | ENS name (`vitalik.eth`, off-chain only) or `0x[40-hex]` | `bytes32(uint160(addr))`                       |
| Schema      | `0x[64-hex]` where `SchemaRegistry.getSchema(uid).uid != 0` | the schema UID                                 |
| Attestation | `0x[64-hex]` where `eas.getAttestation(uid).uid != 0`        | the attestation UID                            |
| Anchor      | plain name (`memes`, `transports`) | `_nameToAnchor[rootAnchorUID][name][ANCHOR_SCHEMA_UID]` |

Precedence is fixed: address → schema → attestation → anchor. Root is special; below root, all walks are anchor-name lookups via `EFSIndexer.resolvePath`. A plain-named anchor at root that *happens* to share its name with an ENS/address/UID token is URL-unreachable but still exists in storage (reachable via sidebar click that uses its attestation UID directly). We accept this — it's a self-inflicted naming wound if it happens.

### 2. Schema alias anchors

When EFS interacts with a schema (user clicks "Add metadata", posts a comment, etc.), the **client** attests an ANCHOR at root whose name is the schema's UID in lowercase hex (with `0x` prefix). This anchor is the EFS representation of the schema. Human-readable labels come from a `name` PROPERTY on it. Other PROPERTYs / TAGs / sub-anchors hang off the anchor normally.

There is one such anchor per schema — ANCHOR's singleton rule (`_nameToAnchor[rootAnchorUID][<schemaUID>]`) prevents duplicates. The client creates it lazily on first interaction; six system-schema aliases are pre-seeded at deploy so the sidebar lists them out of the box.

When resolving `/<64-hex>/…`:

- If an alias anchor exists at that root name → walk via anchor UID (PROPERTYs, sub-anchors, content all from the alias anchor).
- Else if the hex is a valid schema UID in SchemaRegistry → walk using the raw schema UID as the parent (direct mode; shows raw EAS json via the JSON fallback below).
- Else if the hex is a valid attestation UID → walk using the raw attestation UID as the parent.
- Else → 404.

### 3. Kernel auto-tag: `/tags/schema`

At deploy, EFS reuses the pre-existing `/tags/` anchor (home for user tag definitions like `favorites`) and seeds a `/tags/schema/` child anchor under it — a regular tag definition that categorizes alias anchors as "this is a schema."

When EFSIndexer's ANCHOR `onAttest` hook processes a new anchor whose parent is `rootAnchorUID` and whose name decodes as a valid 66-char `0x`-prefixed hex schema UID in SchemaRegistry, the kernel attests `TAG(refUID = newAnchorUID, definition = /tags/schema anchor UID)` from its own address. The TAG's attester is the kernel contract itself (`msg.sender == eas.attest()` invocation). No per-user gas overhead — the user pays for the same transaction that creates the alias anchor; the kernel piggybacks its TAG onto it.

Sidebar "Schemas" enumerates by iterating TAGs whose `definition` is the `/tags/schema` anchor (using the kernel contract's edition).

### 4. Default editions for address containers

When the root segment is an Address and the URL did not include `editions=` / `edition=` / `curator=`, the router seeds `editions = [caller, segmentAddr]` (dedup if equal; drop zero addresses). Anchor / schema / attestation containers keep the existing `[caller]` default. Explicit `?editions=` overrides wholesale (ADR-0031 first-attester-wins unchanged).

### 5. Router raw-info JSON fallback

After the walk, if `_findDataAtPath` returns no DATA AND the final container UID is a valid schema or attestation UID in EAS, the router returns `(200, <json>, [Content-Type: application/json])` with the raw schema / attestation fields. For anchors / addresses with no DATA, behavior is unchanged (404). This makes `web3://<router>/<schemaUID>` and `web3://<router>/<attestationUID>` self-describing out of the box.

## Consequences

**Enables**

- `web3://<router>/vitalik.eth/memes/cat.jpg` and `web3://<router>/<addr>/…` Just Work.
- `web3://<router>/<schemaUID>` returns schema json by default; if an alias anchor exists with PROPERTYs/TAGs, those layer in naturally.
- Schemas become first-class EFS citizens — commentable, taggable, nameable — without a synthetic folder taxonomy.
- Sidebar "Schemas" section populates automatically from kernel `/tags/schema` tags; users don't configure it.
- Address home pages (`/<addr>/`) fall out for free with the default-editions rule: visiting someone's address shows their content with my overrides on top.

**Costs**

- Root naming conflict: a plain anchor at root literally named like `0xabc…` or `vitalik.eth` is URL-unreachable. Acceptable.
- Six extra anchors seeded at deploy (system-schema aliases). Trivial gas.
- EFSIndexer's ANCHOR `onAttest` gains one SchemaRegistry call + one conditional `eas.attest()` when a new root anchor's name matches a schema UID. Bounded by schemaRegistry lookup cost (~2k gas) and one attestation (~50k gas). Users attesting alias anchors pay; users creating normal anchors see no overhead (name length check fails fast).
- Test surface grows: root-classification precedence, JSON fallback, kernel auto-tag edge cases.

**Load-bearing**

- Kernel contract attests via EAS from its own address. That address becomes a well-known edition for system-attested TAGs. Router treats it as just another attester.
- No storage migration. All new paths reuse existing indices.
- ADR-0031's first-attester-wins semantics unchanged: address-in-path is a *default* for editions, not a new model.

## Alternatives considered

1. **`/addresses/vitalik.eth/…` folder wrapping (earlier draft of this ADR).** Rejected because a real `/addresses/` parent is either unenumerable (can't list every address ever interacted with cheaply) or pollutable (stray anchors named `bob` drop into the list). Direct children of root with precedence-based classification is cleaner.
2. **On-chain ENS resolution.** Rejected — commits the mainnet router to an external dependency per ADR-0030. Keep ENS off-chain; router accepts raw hex only; frontend resolves ENS to hex before building the URL.
3. **Schema-as-pure-bytes32 (no alias anchor).** Rejected because schemas have no `name` field in SchemaRegistry, and EFS-native comments/properties/tags need an attestation parent with EFS semantics. Overloading the raw schema UID as the parent conflates "this is EAS data" with "this is an EFS-managed object."
4. **Edition-lens-only shortcut (`/memes/?editions=vitalik`).** Rejected because it loses the "address is a first-class container" property and the default-editions behavior (connected + viewed) has no natural place to attach.
5. **Deploy-time seeding of per-address and per-attestation aliases.** Impossible at scale. Lazy client-driven creation is the only workable path.
