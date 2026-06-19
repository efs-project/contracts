# ADR-0056: Remove the mirror URI scheme gate (allowlist → unrestricted)

**Status:** Accepted
**Date:** 2026-06-19
**Related:** Supersedes ADR-0023; ADR-0048 (proxy-ready resolvers), ADR-0011 (transport anchors), ADR-0022 (MAX_URI_LENGTH), ADR-0012 (transport priority — see Consequences), ADR-0013 (lens-scoped mirror selection); planning `[[mirror-scheme-policy]]`
**Permanence-tier:** Durable (devnet; resolver logic behind an upgradeable proxy, pre-burn)
**Reviewed:** 2026-06-19 — 4 independent expert subagents (freeze/upgrade-safety, adversarial security, on-chain-client/future-proofing, web-client render-safety). Verdict: the contract change is freeze-safe and correct; the conditions they raised are folded into Consequences and ship alongside (lens-scoping fix + debug-UI hardening).

## Context

`MirrorResolver.onAttest` enforces a hardcoded scheme **allowlist** (`_isAllowedScheme`, ADR-0023): a MIRROR URI must begin with one of 11 known prefixes or the attestation reverts. This blocks (a) any future transport scheme and (b) inline `data:` — the natural zero-infra path for small content. ADR-0023 justified the allowlist as XSS prevention.

On review, a scheme allow/denylist is the **wrong mechanism for an immutable contract**, for reasons that are independent of which schemes you pick:

1. **It is not the security boundary.** An *allowed* `https://`/`ipfs://` mirror can serve `text/html` with `<script>` exactly as well as `data:`/`javascript:`. A client that renders fetched mirror bytes in its trusted origin is vulnerable regardless of scheme. The real, unavoidable control is **client-side render isolation** (sandboxed iframe + CSP; SES/LavaMoat for active content), mandatory for *every* transport.
2. **It cannot be enforced robustly.** A prefix check is trivially evaded — case (`JaVaScript:`), zero-width / control characters (`java​script:`), leading whitespace, percent-encoding. Enforcing it *correctly* requires full URI normalization: gas-heavy, error-prone, and — being immutable — **un-patchable** when the next evasion appears.
3. **It cannot anticipate the future.** A denylist can't know tomorrow's dangerous scheme; an allowlist forecloses tomorrow's legitimate protocol. Neither belongs in permanent state.

Net: the gate blocks honest typos of exact strings while providing no real security and no durable guarantee. See planning `[[mirror-scheme-policy]]` for the full rationale and the client-side requirement.

## Decision

**Remove the scheme gate from `MirrorResolver.onAttest`.** Delete `_isAllowedScheme`. Any URI is accepted provided it passes the **robust, structural** checks the kernel *can* enforce on immutable state:

- **References a real transport** — `transportDefinition` is a descendant of `/transports/` (`_isDescendantOfTransports`, unchanged). A new protocol is added by authoring a `/transports/<scheme>` anchor (ADR-0011) — permissionless, additive.
- **Within length** — `MAX_URI_LENGTH` (ADR-0022, ~8 KB), unchanged. Also bounds inline `data:`.

Scheme policy and render safety move to the **upgradeable** layer (client + SDK), where they can be normalized and patched as browsers evolve. `data:`, `web3://`, and any future `scheme://` all work with no contract change.

Ships as an **implementation upgrade behind the existing ERC1967 proxy** (ADR-0048). The proxy address — and the `MIRROR` schema UID and the whole 9-schema freeze set — is **unchanged**. This is the affordance ADR-0048 created; the schema-freeze owner holds the upgrade keys (no burn timeline), so it lands via a Safe-gated `upgradeTo` whenever convenient.

## Consequences

- **Any transport is *retrievable*, now and forever** — declare a `/transports/<scheme>` anchor and mirror it. The kernel no longer gatekeeps the scheme namespace. **Ranking caveat (review correction):** the router's transport-priority ladder (`EFSRouter._getBestMirrorURI`, ADR-0012) is still hardcoded `web3:// > ar:// > ipfs:// > magnet: > everything-else`, so an unknown future scheme *works* but lands in the lowest (`else`) tier — it can't be ranked above `ipfs://` without a router change. That's a separate, **freeze-safe** follow-up (the router is a redeployable view): move per-transport priority to a PROPERTY on the `/transports/<scheme>` anchor. So "future transports work" is true for availability, not yet for preference. ADR-0012 is therefore *touched* (its ladder is now the residual choke point), not "unaffected."
- **`data:` + `web3://` inline content enabled** — unblocks the SDK's zero-infra small-file write defaults; also the only mirror kinds an on-chain contract client can read natively. (Inline `data:` payloads are permanent on-chain and capped by `MAX_URI_LENGTH` ≈ 6 KB usable after base64 + preamble.)
- **Freeze preserved** — proxy impl swap; no schema-UID/address churn, no client/SDK fixture changes.
- **Security posture is honest, not theatrical.** The kernel stops pretending to do scheme safety; the client/SDK owns render isolation (a launch-blocker, tracked in `[[mirror-scheme-policy]]` + `specs/overview.md` load-bearing invariants). **Exposure is unchanged-to-improved *conditional on the client's render-layer scheme guard + CSP* (review correction):** for the *rendered-bytes* path (sandboxed iframe) removing the gate adds zero exposure — that path was never scheme-gated. The one surface that genuinely grows is the *navigable-URI* path (a raw `javascript:`/`data:` URI placed in an `<a href>`, a top-level navigation, or a gateway that redirects to the `message/external-body` `URL=`). The allowlist *was* incidentally guarding that; it now moves to the client (never render a mirror URI as a live link / never navigate to it). This ships with the debug-UI hardening below.
- **Lens-scoping fix shipped alongside (review finding).** `EFSFileView.getDataMirrors` was not lens-scoped (returned *all* attesters' mirrors), so a foreign attester's now-arbitrary-scheme mirror could surface in a viewer's list. Fixed at the API: **`getDataMirrors(dataUID, attester, start, length)` now REQUIRES the lens** (matching ADR-0013 + the lens-scoped-reads invariant), and all callers were updated. The cross-attester enumeration is kept only as the explicitly-named **`getDataMirrorsAllAttesters`** (debug/discovery; never used on a trusted render path), which the debug UI uses while rendering foreign mirror URIs inert.
- **Robustness:** the remaining checks (non-empty, length, transport-ancestry) are exact structural predicates with no string-normalization ambiguity — nothing to evade.
- Tests flip: was "assert `data:`/`javascript:` revert"; now "assert an arbitrary scheme (`data:`, `foo://`) is accepted with a valid transport anchor + length; a bogus `transportDefinition` still reverts." Update `specs/02` §Mirror and `specs/overview.md` (drop the scheme-allowlist note).

## Alternatives considered

- **Keep the allowlist, add schemes.** Rejected: permanently closed to future protocols; every new one needs a contract change.
- **Replace with a minimal denylist** (`javascript:`/`vbscript:`/`file:`). Rejected: same evasion + immutability + can't-anticipate problems as any scheme check; provides no enforceable guarantee, so it's complexity + false confidence on permanent state for ~zero benefit.
- **Owner-settable scheme policy.** Rejected: adds mainnet admin surface, contra ADR-0030.
- **Full on-chain URI normalization then check.** Rejected: gas-heavy, still un-patchable against novel evasions, still not the real boundary.
