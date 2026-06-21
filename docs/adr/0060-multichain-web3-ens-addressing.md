# ADR-0060: Multi-chain web3:// addressing — per-chain ENS subdomains + movable default

**Status:** Proposed
**Date:** 2026-06-21
**Related:** ADR-0057 (EFSBytesStore), ADR-0058 (router web3:// serving), ADR-0037 (deterministic addresses), ERC-4804/6860 (web3://), ERC-6821 (ENS `contentcontract`)

## Context

EFS deploys **one `EFSRouter` per chain** (a router can only `extcodecopy` its own chain). EFS will live on many chains — Sepolia today; zkSync / Base / Arbitrum / … later — and the *default* chain is expected to move (Sepolia now → a mainnet-class chain such as zkSync at launch). We need a canonical, human-readable, chain-portable way to address EFS content via `web3://` that survives router redeploys and scales to N chains **without baking chainIds into every URL**.

`web3://` chain selection has two independent layers:
1. The URL `:chainId` host suffix selects the *name-resolution* chain (default = mainnet, chain 1).
2. The ENS `contentcontract` record (ERC-6821) can point a name's *content* at another chain via `<shortName>:0x<addr>`. It is **single-valued** → one record = one chain.

So a bare `web3://efs.eth/` can only ever mean one chain. That's fine for "the default," but it can't address every chain.

## Decision

Address EFS per-chain via **ENS subdomains under `efs.eth` (mainnet)** — not chainIds in URLs:

- **`efs.eth` = the default/canonical chain**, a movable pointer. Today `contentcontract = sep:0x<sepolia router>`; repoint to the mainnet-class router at launch. `web3://efs.eth/<path>` always means "the default chain."
- **`<chain>.efs.eth` = one subdomain per chain** (`sepolia.efs.eth`, `zksync.efs.eth`, `base.efs.eth`, …), each `contentcontract = <shortName>:0x<that chain's router>`. `web3://<chain>.efs.eth/<path>` addresses that chain explicitly, regardless of what is default.

Adding a chain = deploy its router + one mainnet ENS subdomain record. Moving the default = one record change on `efs.eth`; the explicit subdomains keep every chain addressable, so moving the default strands nothing.

**Router address stability:** deploy `EFSRouter` at a **deterministic same address on every chain** (CREATE3, same salt + same deployer/Safe) so the non-ENS fallback `web3://0x<router>:<chainId>/<path>` is uniform across chains (only the chainId varies). Today the router is plain-deployed (per-chain addresses); adopt CREATE3-uniform addressing before mainnet.

## Consequences

- ChainId is encoded **once per subdomain in ENS**, not in every URL → clean URLs (`web3://base.efs.eth/`, not `web3://efs.eth:8453/`).
- All names live under the single `efs.eth` you control → one governance point.
- **Short-name dependency (caveat):** the `contentcontract` `<shortName>:0x…` form only resolves in a web3:// client that knows the chain's short name (`ethereum-lists/chains`: `eth`, `sep`, `base`, `arb1`, `zksync-era`, …). The 3-part `eip155:` form throws in `web3protocol-js` (verified). For a chain a client doesn't know yet, the always-works fallback is the numeric form `web3://0x<router>:<chainId>/<path>` — which is why CREATE3-uniform router addresses matter.
- The production client builds `web3://<chain>.efs.eth/…` (or address-form) URLs behind a chain switcher; multi-chain is a UI concern with ENS as the canonical shareable layer.
- **Not yet implemented.** Near-term: set `efs.eth` (default → Sepolia) + `sepolia.efs.eth`. As chains deploy: add `<chain>.efs.eth`. Before mainnet: decide CREATE3-uniform router addressing.

## Alternatives considered

- **ChainId in every URL** (`web3://efs.eth:<id>/`): forces users to know chainIds, ugly, and still needs per-chain name resolution. Rejected for UX.
- **One name, one chain** (a single `contentcontract`, the current step): cannot address non-default chains. The subdomain layer is the scalable *extension* of that, not a rebuild — today's single record is just the first subdomain.
