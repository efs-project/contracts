# EFS System Architecture

## High-Level Vision
The Ethereum File System (EFS) is designed to be a fully decentralized, credibly neutral protocol for indexing and retrieving data. 
- **Credibly Neutral**: EFS has no admin keys, no upgradeability, no censorship capabilities, and no single point of ownership.
- **Onchain Native**: EFS works entirely onchain without relying on offchain indexers or centralized databases as external dependencies. Lookups of key data are natively indexed and efficient.
- **Extensible**: EFS is designed to be extended by developers. It avoids hardcoding application-specific functionality into the core protocol, encouraging the creation of modular and extendable Web UIs. See [Extensibility and Web UI](./05-Extensibility-and-Web-UI.md).

## Core Principles
EFS is built on the **Ethereum Attestation Service (EAS)**, utilizing onchain schemas and Ethereum addresses as key identifiers alongside conceptual folders ("Anchors"). The design of the protocol inherently considers standard query patterns, such as GraphQL, to accommodate application developers seamlessly.

EFS also heavily leverages existing standards whenever possible, including:
- **EAS (Ethereum Attestation Service)**: For data structuring and relationships.
- **ENS (Ethereum Name Service)**: For resolving human-readable names.
- **web3:// URIs (EIP-4804, EIP-6860, EIP-5219)**: For native EVM web routing and decentralized HTTP-like file serving.
- **Content Types**: For standardized data and file categorization.

## Component Overview
EFS relies fundamentally on EAS schemas to form a directed graph of named relationships:
- **Three-Layer Data Model**: EFS separates concerns into **paths** (Anchors — Schelling points for names), **data** (DATA — standalone file identity with content hash), and **retrieval** (MIRROR — transport-specific URIs). Files are placed at paths via PIN edges, decoupling identity from location. See [Data Models and Schemas](./02-Data-Models-and-Schemas.md).
- **Anchors as Schelling Points**: To create human-readable structures (like folders or filenames), EFS introduces **Anchors**. An Anchor acts as an intermediary node—a Schelling point—that groups underlying data or metadata.
- **Permissionless Writing, Curated Reading (Editions)**: Any piece of data can be written by any user. However, reading and resolving the "state" of this data is curated via specific user contexts called **Editions** (Address-Based Namespaces). This allows the filesystem to be viewed through an "edition" or folder state curated by an ordered list of trusted addresses.
- **Multi-Transport Retrieval**: Files can have multiple MIRRORs — on-chain (`web3://`), IPFS (`ipfs://`), Arweave (`ar://`), Magnet (`magnet:`), and HTTPS. Transport definition Anchors under `/transports/` define the supported types. Clients select the best available transport and verify content integrity via the DATA's `contentHash`.
- **EFSRouter as Web Server**: The EFSRouter acts as an EIP-5219 compliant decentralized web server natively on the EVM. It resolves web3:// URIs (EIP-4804/6860), translating standard HTTP-like requests to the subjective on-chain filesystem traversal and serving the final data or external content appropriately.
- **EdgeResolver for Edge Attestations (PIN + TAG)**: A dedicated resolver contract handles both PIN and TAG schemas separately from the `EFSIndexer`. **Cardinality lives in the schema UID** (ADR-0041) — PIN is the cardinality-1 edge (singleton per `(attester, definition, targetSchema)` slot, used for file placement and PROPERTY value binding); TAG is the cardinality-N edge (list per slot, carrying an `int256 weight`, used for folder visibility, descriptive labels, and schema-alias discovery). One shared resolver, two storage shapes: `_activeBySlot` (O(1) singleton) for PIN and `_activeByAAS` (struct-of-tuple `TagEntry[]`) for TAG. Removal in both cases is via `eas.revoke()`; PIN re-attestation at the same slot supersedes the prior PIN automatically.
- **MirrorResolver for Retrieval Validation**: A resolver contract for the MIRROR schema validates that `refUID` points to a valid DATA attestation and `transportDefinition` points to a valid Anchor. No singleton enforcement — multiple mirrors per transport type are allowed.

## Layered architecture (working sketch)

This is a **working draft** — orientation, not finished doctrine. The layers below are useful for thinking about where new work belongs, but the boundaries inside the contracts (especially layer 2 vs layer 3) have not been audited yet. Treat this as a guide for design discussion, not as binding law. Reshaping the layers should be flagged as a Tier 1 conversation.

```
┌─────────────────────────────────────────────────────────┐
│ 8. Apps                                                 │
│ 7. Web OS / UI shell                                    │
│ 6. EFS JS Library                                       │
│ 5. RPCs (web3:// resolver, HTTP gateways)               │
│ ─── network boundary ───                                │
│ 4. Use-case overlays (FILE SYSTEM, social, lists, …)    │
│ 3. DATABASE / Kernel (graph DB: nodes, edges, indexes)  │
│ 2. EAS Indexing (schemas, resolvers, attestation)       │
│ 1. EVM + EAS substrate                                  │
└─────────────────────────────────────────────────────────┘
```

### The solid distinction (load-bearing)

**Layer 3 (Database / Kernel) and Layer 4 (File System) are separate concerns.** The kernel is a generic graph database — nodes (Anchors), edges (PIN/TAG), content blobs (DATA), and the indexes that make those queryable on-chain. The file system is *one* use-case overlay built on top: filenames are anchor names; folders are anchors with children; "this file lives at this path" is `PIN(definition=anchorUID, refUID=dataUID)`. Other overlays (social graph, knowledge base, curated lists) compose the same primitives differently.

This separation is the load-bearing one for layered thinking. Future design discussions should keep file-system semantics out of layer 3. PIN and TAG, despite the file-system-friendly names, are **layer-3 graph primitives** — functional vs non-functional edges in OWL terms, `:db.cardinality/one` vs `:db.cardinality/many` in Datomic terms. The metaphor is friendly to file-system devs; the underlying concept is pure graph theory.

### Working hypotheses (need audit before becoming load-bearing)

- **The layer-2 vs layer-3 boundary inside `EFSIndexer.sol`.** Today one contract does both "I received an attestation; route it" (layer 2) and "edges, nodes, paths, active sets" (layer 3). These are conceptually separable, but the boundary hasn't been audited. A future split would let layer 2 be reused by other EAS-based projects and let layer 3 stand alone as a graph DB. Out of scope for now (cross-contract calls in resolver hot paths cost ≥2.6k gas per attestation; ADR-0030 mainnet permanence makes a wrong-first-cut split costly).
- **What counts as "layer-4 file-system overlay" vs "layer-3 graph primitive"?** Some indexes in `EFSIndexer.sol` may be more file-system-specific than graph-generic — the qualifying-folder write-time index from ADR-0008 and `_containsAttestations` propagation (ADR-0010) are candidates. A focused audit would catalog which storage maps belong to layer 3 vs which should migrate to a layer-4 overlay contract.
- **Where do `dataByContentKey` (content dedup) and SSTORE2 chunking sit?** Plausibly layer 2 (raw EAS-adjacent storage) or layer 3 (kernel-managed content addressing). Not settled.

These boundaries are flagged as **unsettled** rather than dictated. Don't reshape them ad-hoc; if a change starts to imply a particular boundary, surface that as a Tier 1 design conversation so the layers and the code can be aligned together.
