# ADR-0039: Default lenses priority chain

**Status:** Accepted
**Date:** 2026-04-20
**Related:** ADR-0031, ADR-0033, ADR-0014

## Context

ADR-0031 established `?lenses=<csv>` as the URL-encoded lenses list and nailed down two properties:

- **First-attester-wins** inside the list.
- **Wholesale override** when the param is present — `?lenses=alice,bob` means exactly `[alice, bob]`, nothing appended, nothing prepended. Same URL → same view for every viewer; this is what makes lens-scoped links shareable.

ADR-0033 added address containers and extended the **default** (URL-less) chain to `[connectedAddress, viewedAddress]` — "Vitalik's memes, with my overrides on top." Other container flavors stayed at `[connectedAddress]`.

That default is too thin. Fresh users — no wallet connected, or a brand-new wallet with zero attestations — see empty grids everywhere. The system needs a **tail fallback tier** that carries some seed content regardless of who's viewing, so navigating to `/memes/` on a clean install still renders something. On devnet this tier is a bootstrap curator address + the EFS deployer; on mainnet, a user-configurable set.

We also want to reserve a **web-of-trust tier** — attesters the user has explicitly trusted — that sits between their own content and the global system tier. The UX for configuring web-of-trust isn't designed yet, but the slot should exist so adding it later is a config change, not a plumbing change.

## Decision

When `?lenses=` is **absent**, the default lenses chain is:

```
connectedAddress
  → viewedAddress (address container only)
  → webOfTrust[]     (user-configured; empty today)
  → systemLenses[] (tail fallback)
```

When `?lenses=` is **present**, it overrides wholesale. Unchanged from ADR-0031 and ADR-0033.

### Tier definitions

- **connectedAddress** — the user's own wallet from wagmi. Omitted when disconnected. Their attestations outrank everything.
- **viewedAddress** — only populated when the top-level URL segment classifies as an address container (ADR-0033). `/vitalik.eth/memes/` shows "my overrides → Vitalik's content → ..."; `/memes/` leaves this slot empty.
- **webOfTrust[]** — future user-configured attester list. Empty array today. Plumbed through every call site so enabling the feature later is a single config change, not a refactor across components.
- **systemLenses[]** — tail fallback. On devnet: `[DEVNET_BOOTSTRAP_CURATOR, deployerAddress]`. The deployer is read at runtime from `EFSIndexer.DEPLOYER` (immutable set in constructor). The bootstrap curator is a module-level constant in `utils/efs/containers.ts`:
  ```
  DEVNET_BOOTSTRAP_CURATOR = 0xaCf4C2950107eF9b1C37faA1F9a866C8F0da88b9
  ```
  Devnet-only. Gets replaced on mainnet (see Mainnet plan below).

Dedup is case-insensitive; zero addresses are dropped; order is preserved (first-wins still applies inside the chain per ADR-0031).

## Consequences

### Enables

- Fresh users see seeded content without configuring anything. `/memes/` on a clean install renders — one of the bootstrap curator's or deployer's files, per first-wins.
- "Vitalik's memes with my overrides" works exactly as ADR-0033 promised, plus tail fallbacks visible when nobody in the front of the chain attested the path.
- URL shareability intact. `?lenses=alice,bob` means exactly `[alice, bob]` to every viewer, everywhere.
- Web-of-trust becomes a pure-data change when it ships: populate the array, nothing else moves.

### Costs

- The default view depends on system-tier curator attestations. If devnet is re-deployed with the bootstrap curator's or deployer's seed content missing, the default view looks emptier until they attest. This is already true; ADR-0039 just makes it more load-bearing.
- One extra `useScaffoldReadContract({ contractName: "Indexer", functionName: "DEPLOYER" })` per `ExplorerClient` mount. Single read, cached by wagmi; noise-floor overhead.
- Anyone reading the URL bar can no longer reason about "who's attesting the content I see" without knowing the default chain. The Lenses chip in the toolbar should eventually surface the effective list; out of scope here.

### Mainnet plan

Devnet hardcodes `[DEVNET_BOOTSTRAP_CURATOR, deployerAddress]`. Mainnet will replace this with a user-configurable array — stored in localStorage, surfaced in a Settings UI, and defaulted to a small project-blessed seed list that ships in the repo. Changing the default chain post-mainnet doesn't break anything: the client picks up the new defaults on next visit, no on-chain migration. Tracked in `docs/FUTURE_WORK.md`.

## Alternatives considered

### A. Merge `?lenses=` into the chain at position 3 (rejected)
Proposed order: `connected → viewed → URL → bootstrap curator → deployer`. First-pass proposal. Rejected after flagging the ADR-0031 / ADR-0033 conflict: it would break URL shareability — the same link renders differently to different viewers, because the connected wallet silently prepends to the list. A link curator can no longer promise "you'll see exactly what I see."

### B. Keep `?lenses=` wholesale; extend only the default chain (adopted)
Today's decision. Costs nothing in shareability (URL semantics unchanged), and the default chain gets the desired extra tiers. No ADR supersession needed — ADR-0031 and ADR-0033 both only prescribed wholesale-override for the param; neither fixed the exact default composition as load-bearing.

### C. Hybrid — append system tier as tail fallbacks even when `?lenses=` is present (rejected)
`?lenses=alice,bob` would become `[alice, bob, <system tier…>]`. Softer than A — your own wallet isn't injected — but still breaks the "URL means exactly what it says" invariant. A link saying "look at Alice's and Bob's lens of this page" must mean exactly that; appending project-blessed curators invisibly is paternalistic and undermines the core sharing property ADR-0031 is built on.

### D. Web-of-trust-first, no system tier (rejected)
Drop the system tier entirely; rely on users building their web of trust. Rejected because it defeats the "fresh user sees something" goal — with no WoT configured and no connected wallet, the default view is empty, which is the problem this ADR solves.

## Implementation touch points

- `packages/nextjs/utils/efs/containers.ts` — `defaultLensesForContainer` gains `webOfTrust` and `systemLenses` params (both optional, default empty). Export `DEVNET_BOOTSTRAP_CURATOR` constant.
- `packages/nextjs/app/explorer/[[...path]]/ExplorerClient.tsx` — reads `Indexer.DEPLOYER`, builds `systemLenses = [DEVNET_BOOTSTRAP_CURATOR, deployer]`, passes through to the hook. `webOfTrust: []` today.
- No contract changes. Defaults live entirely client-side; the router's `?caller=` fallback (ADR-0016) remains the on-chain default when no lenses are resolved.
