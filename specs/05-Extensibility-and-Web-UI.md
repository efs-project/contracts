# Extensibility and Web UI

EFS is meant to serve as foundational infrastructure rather than a highly opinionated product, aligned with the vision in [System Architecture](./01-System-Architecture.md). Extensibility is a core tenet, and the interfaces interfacing with EFS should not rely on proprietary systems. Standard workflows are documented in [Core Workflows](./04-Core-Workflows.md).

## Permissionless and Modular Interfaces
- **No Hardcoded Features**: Front-end applications navigating EFS should avoid hardcoding functionality directly to centralized components. Everything should be resolved natively using EAS data.
- **Extensible Rendering**: Because `Data` attestations store `contentType`, the frontend should use a modular renderer pattern. If the `contentType` is `image/png`, it loads an Image component. If it's a 3D model, it loads a WebGL viewer. If it's a recognized new MIME type, developers can inject new viewers permissionlessly.

## Avoid Centralized Infrastructure
- Web UI clients should query directly from standard Ethereum RPC nodes or credibly neutral indexing networks (like The Graph/envio, if utilizing a standard subgraph schema identical to the onchain logic).
- To adhere to EFS's vision, indexers must accurately reflect the subjective nature of EFS—they should allow querying by Edition (specific address graph) or a user's local web of trust, without forcing a globally curated feed.

## Supporting New Workflows
- If developers wish to create a "Social Media App" on top of EFS, they do not need a new protocol. They can define a standard folder convention (e.g., `/users/0x123/posts/`) and create `Data` attestations correctly embedding `text/plain` or `text/markdown` URIs. 
- The Web UI simply serves as a strict lens over this specific directory path, utilizing filtering (e.g., Tag schemas for formatting or replies). This enables arbitrary read/write capability without permissioned protocol forks.
