# Reference

External specs and library docs. Load only what you need for your current task.

## When to read what

### Smart contract work
- **`eas-docs.txt`** — required for any work touching attestations, schemas, or resolver hooks. Covers attestation lifecycle, schema registry, the `onAttest` / `onRevoke` resolver pattern, and EAS's data model.
- **`eas-sdk-docs.txt`** — required when writing tests, deploy scripts, or off-chain code that creates/queries attestations. Covers the EAS TypeScript/JS SDK.

### EFSRouter / `web3://` work
The Web3 URI stack. Read these when modifying EFSRouter, mirror resolution, content serving, or anything that returns headers/bodies via ERC-5219.

- **`EIPs/erc-4804.md`** + **`EIPs/erc-6860.md`** — the `web3://` URI scheme itself. 4804 is the original, 6860 is the updated version. Read 6860; reference 4804 for historical context.
- **`EIPs/erc-5219.md`** — Contract Resource Requests. The `request()` interface EFSRouter implements. **Required reading for any EFSRouter change.**
- **`EIPs/erc-6944.md`** — ERC-5219 Resolve Mode. How clients pick between manual mode and 5219 mode. Read if changing how the router advertises itself.
- **`EIPs/erc-7617.md`** — Chunk support for ERC-5219. Required when working on multi-chunk file serving (anything past one SSTORE2 chunk).
- **`EIPs/erc-7618.md`** — Content encoding. Read if adding compression or content-encoding response support.
- **`EIPs/erc-7774.md`** — Cache invalidation. Read if adding HTTP cache headers (ETag, Cache-Control) to router responses.
- **`EIPs/erc-6821.md`** — ENS Name support for `web3://` URLs. Read if working on ENS-aware path resolution or testing with `name.eth` style URLs.

### Web3 URI tooling
- **`web3protocol.md`** — JS library that parses and fetches `web3://` URLs. Read when writing client-side code that consumes EFS via the `web3://` scheme, or when debugging URL parsing edge cases.
- **`web3curl.md`** — CLI tool for fetching `web3://` URLs. Useful for manual debugging — call out an EFS file from the command line and inspect the response.

### Internal devtools UI work (`packages/nextjs/`)
The Scaffold-ETH 2 framework conventions used by the internal debug UI.

- **`scaffold-docs.txt`** — Scaffold-ETH 2 docs. Read when working in `packages/nextjs/` — covers the project structure, the `useScaffoldReadContract` / `useScaffoldWriteContract` hooks, the `deployedContracts.ts` generation, the burner wallet pattern, and the `DevWalletSwitcher`.

> **Production EFS Client UI** (the Vite/Lit app in a separate repo) does NOT use Scaffold-ETH and has its own conventions. Don't apply Scaffold-ETH patterns there.

### Schema design / new attestation types
- **`eas-docs.txt`** — schema registry semantics, schema UID derivation, resolver address binding. Critical context for understanding why schema UIDs are immutable and what changing one breaks.

## Quick task → file mapping

| Task | Load |
|---|---|
| Adding a new attestation field | `eas-docs.txt` |
| Modifying EFSRouter | `EIPs/erc-5219.md` + `EIPs/erc-6944.md` (+ `erc-7617` if chunked, `erc-7618` if encoding, `erc-7774` if caching) |
| Writing a deploy script | `eas-sdk-docs.txt` |
| Building a debug UI page | `scaffold-docs.txt` |
| Debugging a `web3://` URL | `web3protocol.md` or `web3curl.md` |
| Anything ENS-related on URLs | `EIPs/erc-6821.md` |
| Frontend reading attestations | `eas-sdk-docs.txt` |
