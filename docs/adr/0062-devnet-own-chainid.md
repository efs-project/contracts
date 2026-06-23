# ADR-0062: Devnet gets its own chainId (26001993), distinct from the local fork

**Status:** Accepted
**Date:** 2026-06-21
**Related:** ADR-0037 (pinned Sepolia fork — superseded in part), ADR-0061 (multi-chain deployedContracts), ADR-0060 (multi-chain web3:// addressing)

## Context

The debug UI targets three environments: **live Sepolia** (`11155111`), the **shared community devnet** (a Sepolia fork on the VPS), and a developer's **local hardhat fork**. Per ADR-0037 every fork — local, CI, and the devnet VPS — runs at chain id **`31337`** so their contract addresses come out byte-identical. That unification was deliberate while the three were truly interchangeable.

It breaks down the moment we want **Devnet and Local to be distinct, stable, user-selectable networks**:

- wagmi keys chains by chain id, so two entries both at `31337` can't coexist in the switcher or the config — only one `31337` slot exists.
- A wallet on `31337` literally cannot tell the devnet apart from the user's own local node (both show as "Localhost 31337"), so a user could sign against the wrong one without noticing.

An interim attempt to keep one `31337` slot and pick the RPC dynamically (local-first, devnet-fallback, probed at runtime) was **rejected**: a network's identity flipping under the user based on a request timeout is unsafe — data and (eventually) contracts can differ between environments, and a transient error must never silently move you to a different chain.

## Decision

Give the devnet its **own chain id, `26001993`**, making it a first-class network distinct from the local fork:

- The devnet VPS `anvil` runs `--chain-id 26001993` (was `31337`); contracts are redeployed against it, producing a `deployedContracts[26001993]` block (the per-chain merge generation of ADR-0061 carries it alongside `31337`/`11155111` with no generator change). Addresses are unchanged — CREATE/CREATE2 don't depend on chain id — so only the network identity differs.
- The debug UI defines `26001993` as a real wagmi chain ("EFS Devnet", RPC = the VPS) with proper `wallet_addEthereumChain` metadata. The switcher offers **Sepolia + Devnet** as stable explicit choices; **Local** (`31337`) is shown additionally only when a local node is configured/available. Selection is the user's, persisted — never automatic.
- The local fork keeps `31337` (ADR-0037 determinism for local/CI is unchanged). A `HARDHAT_CHAIN_ID` override (default `31337`) lets a node be run at `26001993` for local block generation / parity.

`26001993` was chosen by the human and **verified unregistered** against the ethereum-lists/chains registry (chainid.network) before adoption. An earlier candidate, `5318008`, was rejected in review: it is the registered **Reactive Kopli** chain — a vanity id is exactly the kind already taken, which would reintroduce the very wallet-collision this ADR removes. Lesson for any future pick: avoid vanity numbers and verify the id against the registry first.

## Consequences

- **Three real, stable networks.** Sepolia / Devnet / Local are protocol-distinct; the platform — not a heuristic — enforces separation. A wallet shows which one you're on; data/addresses are namespaced per chain in `deployedContracts`.
- **Requires a devnet redeploy (ops).** "Devnet" only functions — especially **writes** (attestations, faucet) — once the VPS node actually runs `--chain-id 26001993`: an EIP-155 tx signed for `26001993` is rejected by a `31337` node. The VPS `--state` file must be wiped on cutover (chain-id change). This is a separate devnet-repo change and the gating step.
- **Wallet UX:** the burner wallet is unaffected (app-managed). An external wallet (MetaMask) treats `26001993` as a custom network → a one-time "add network" approval on first connect, with metadata we supply. This is _more_ correct than today's `31337`, which collides with every user's own local node.
- **web3:// URIs on the devnet carry `:26001993`** (ADR-0060) — deliberate, hence choosing the id with care now.
- **Supersedes ADR-0037 in part:** forks are no longer all `31337`. Local + CI stay `31337` (determinism intact); the devnet diverges to its own id. The "byte-identical addresses across environments" property still holds (chain-id-independent), but the "same chain id everywhere" simplification no longer does.

## Alternatives considered

- **Keep `31337`, switch RPC at runtime (fallback/probe).** Rejected: unsafe auto-flipping of network identity; a wallet still can't distinguish devnet from a local node.
- **Keep the 2-entry-per-build model** (Sepolia + whichever of Local/Devnet the build targets). Works for the deployed app but can't show Local and Devnet as distinct simultaneous choices, which is the requirement.
- **Give the _local_ fork a new id instead.** Rejected: `31337` for local hardhat is entrenched across ADR-0037, CI `deploy-pin-check`, and every contributor's setup; moving the shared devnet is the smaller blast radius.
