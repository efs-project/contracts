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
- **Attestations as Files/Folders**: Every entity in the filesystem is represented as an EAS attestation. See [Data Models and Schemas](./02-Data-Models-and-Schemas.md).
- **Anchors as Schelling Points**: To create human-readable structures (like folders or filenames), EFS introduces **Anchors**. An Anchor acts as an intermediary node—a Schelling point—that groups underlying data or metadata.
- **Permissionless Writing, Curated Reading (Editions)**: Any piece of data can be written by any user. However, reading and resolving the "state" of this data is curated via specific user contexts called **Editions** (Address-Based Namespaces). This allows the filesystem to be viewed through an "edition" or folder state curated by an ordered list of trusted addresses.
- **EFSRouter as Web Server**: The EFSRouter acts as an EIP-5219 compliant decentralized web server natively on the EVM. It resolves web3:// URIs (EIP-4804/6860), translating standard HTTP-like requests to the subjective on-chain filesystem traversal and serving the final data or external content appropriately.
- **EFSTagResolver for Subjective Categorization**: A dedicated resolver contract handles Tag attestations separately from the `EFSIndexer`. It enforces a singleton tagging pattern per `(attester, target, definition)` triple, and maintains append-only discovery indices. Tags target specific DATA attestation UIDs (edition-specific) rather than shared Anchor UIDs, ensuring that tagging one user's edition does not affect other users' editions of the same file. Tag definitions are normal Anchors stored under a reserved `/tags/` folder in the filesystem tree.
