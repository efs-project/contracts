# Launch Checklist

Two distinct launches:
- **Devnet (April 19, 2026)** — bicycle day. Forked Sepolia on a VPS, weekly reset, upgradeable contracts allowed for iteration.
- **Mainnet (target ~April 22, 2026 → likely later)** — permanent contracts (ADR-0030), no second chances.

Update statuses with `[x]` as items land. Add notes inline if blocked.

---

## Devnet (April 19, 2026)

### Infrastructure

- [ ] VPS provisioned with forked Sepolia (anvil/hardhat fork)
- [ ] IPFS node running (kubo or similar) for devnet file hosting
- [ ] Arweave gateway/uploader available (testnet or hosted)
- [ ] Magnet/torrent seed infrastructure (webtorrent tracker?)
- [ ] HTTPS test endpoint(s) for HTTP transport testing
- [ ] Weekly reset cron job (Sunday 00:00 UTC?)
- [ ] DNS / public URL for the devnet

### Contracts

- [ ] Devnet contracts deployed behind upgradeable proxy (resolved in `docs/QUESTIONS.md`: which proxy pattern)
- [ ] Upgrade procedure documented (storage layout enforcement via OpenZeppelin's `hardhat-upgrades`)
- [ ] Reset procedure includes redeploying all contracts and clearing all on-chain state
- [ ] EFSIndexer wired to EdgeResolver, MirrorResolver, EFSSortOverlay
- [ ] System anchors created: root, `/transports/onchain`, `/transports/ipfs`, `/transports/arweave`, `/transports/magnet`, `/transports/https`
- [ ] `setTransportsAnchor()` called on MirrorResolver

### Frontend / Client

- [ ] Production EFS Client (Vite/Lit, separate repo) reviewed for devnet readiness
- [ ] Internal devtools UI (`packages/nextjs/`) confirmed working against devnet
- [ ] Client knows how to construct `web3://` URLs pointing at the devnet router
- [ ] "DEVNET — RESETS WEEKLY" warning banner in client UI

### Communication

- [ ] Devnet announcement post drafted (positioning: "early access, expect breakage, don't store anything you care about")
- [ ] Discord/Telegram/community channel for devnet feedback ready
- [ ] Bug report / feedback flow documented

---

## Pre-Mainnet (target April 22, 2026 — likely slips)

### Pre-Mainnet Architectural Conversations

These are open architectural conversations identified during the ADR-0041 PIN/TAG schema split (PR #10) that are out of scope for that change but become much harder to revisit after mainnet. Each deserves its own focused session and ADR — list each conversation as `[ ]` until either an ADR lands or an explicit "no change for v1" decision is recorded in `docs/decisions.md`.

- [ ] **DATA schema deprecation conversation.** A suggestion surfaced in PR #10's review to remove the DATA schema entirely and replace file placement with `PIN(definition="storageURI", value=BLOB)`. Touches ADR-0001 (three-layer model), ADR-0002 (DATA standalone non-revocable), ADR-0004 (content dedup via `dataByContentKey`), ADR-0011 (transports), ADR-0012 (transport priority), ADR-0013 (edition-scoped mirror selection). The proposal removes the content-addressing layer that lets multiple uploaders converge on the same identity; that layer needs to be replaced by something equivalent or explicitly given up — not just deleted. Decision needed pre-mainnet: keep DATA as-is, redesign, or remove. Default if not addressed: keep DATA (record explicit "no change" decision).
- [ ] **Kernel layer-2 / layer-3 split conversation.** Today `EFSIndexer.sol` does both layer 2 ("I received an attestation; route to handler" — use-case-neutral EAS indexing) and layer 3 ("edges, nodes, paths, active sets" — the graph DB). The two are conceptually separable per the working sketch in `specs/01-System-Architecture.md`. Pre-mainnet split would let layer 2 be reused by other EAS-based projects and let layer 3 stand alone as a graph DB; post-mainnet split is much harder because ADR-0030 freezes EFSIndexer's interface. Cost: cross-contract calls in resolver hot paths add ≥2.6k gas per attestation, so the split must be designed deliberately. Decision needed pre-mainnet: split now, defer to v2 with an explicit migration story, or commit to the combined kernel forever.
- [ ] **Layer-3 audit of `_containsAttestations` (and similar) for file-system bleed.** Some indexes in `EFSIndexer.sol` may be more file-system-specific than graph-generic (the qualifying-folder write-time index from ADR-0008, `_containsAttestations` propagation from ADR-0010). A focused audit would catalog which storage maps belong to layer 3 (graph kernel) vs which should migrate to a layer-4 file-system overlay contract. Output feeds both the kernel split above and any future use-case overlays (social graph, knowledge base, lists). Decision needed pre-mainnet: audit + document layer assignment, even if no code moves; post-mainnet the layer assignment is locked into permanent storage shapes.

### External Audit

- [ ] **External audit pass on EFSIndexer** — single most important item. Engage Trail of Bits, OpenZeppelin, or run a Code4rena contest. Two-week minimum engagement. Treat critical findings as launch-blocking.
- [ ] All audit findings resolved or documented as accepted-risk (with reasoning)
- [ ] Audit report published

### Internal Review

- [ ] Final agent-review pass after all audit-driven fixes (Claude + Codex + Gemini cross-review)
- [ ] All P1/P2 items in PR review history confirmed resolved
- [ ] Test suite >270 passing (current state preserved)
- [ ] Gas snapshot captured for hot paths (upload, directory listing, web3:// resolution) — baseline for regression detection
- [ ] **Classifier parity test** — off-chain URL classifier (`packages/nextjs/utils/efs/containers.ts#classifyTopLevelSegment` and the production Vite/Lit client's equivalent) produces byte-identical `(flavor, uid)` tuples to `EFSRouter.classifyTopLevel(string)` across a fixture table: valid 40-hex address, all-zero address, ENS name (off-chain only — contract rejects), unregistered 64-hex, registered schema UID, attestation UID, malformed hex (odd-length, non-hex chars), empty string, plain anchor name, and anchor name that happens to look like `0x…`. ADR-0030 locks classifier semantics at mainnet deploy, so any off-chain drift becomes a permanent interop bug. `classifyTopLevel` is a pure external view — the parity test can run against a local hardhat deployment with no state required. Tracked as review comment #8 on PR #9.

### Mainnet Deploy Readiness

- [ ] Deploy script tested end-to-end on a fresh fork (not just incremental deploys)
- [ ] All `setTransportsAnchor`, `wireContracts`, etc. one-time calls verified to land in correct order
- [ ] Address mismatch assertions in deploy script confirmed working (revert on bad nonce prediction)
- [ ] `yarn hardhat:simulate` passes against the would-be mainnet config
- [ ] **Recovery plan documented**: if EFSIndexer has a bug post-deploy, what's the migration path? Even if the answer is "redeploy everything," the dependency graph must be written down.
- [ ] Deployer key custody plan (multisig, hardware wallet, etc.)

### Production UI

- [ ] Production EFS Client (external Vite/Lit repo) reviewed end-to-end
- [ ] Editions UX is intuitive — naive user understands "whose content am I seeing?"
- [ ] Gas costs surfaced upfront in upload flow (not post-hoc)
- [ ] "Permanent archive, not a Dropbox" positioning crystal clear in UI copy
- [ ] Mirror unavailability surfaced gracefully (not just blank previews)

### Ecosystem

- [ ] At least one compelling curator account seeded (Wikipedia snapshot, Project Gutenberg, government records, etc.)
- [ ] Mirror stewardship plan: who pins IPFS content, who funds Arweave uploads
- [ ] Public web3:// gateway compatibility verified (w3link.io, wevm.dev)
- [ ] Subgraph or off-chain indexer running (or external partner committed to running one)

### Strategic / Comms

- [ ] Launch positioning finalized: "permanent record" not "file service"
- [ ] EAS dependency communicated honestly (we are betting on EAS as foundation)
- [ ] Mainnet permanence communicated (no upgrades, no admin override) — this is a feature, market it
- [ ] Press / community announcement drafted

---

## Post-Launch (Week 1)

- [ ] Monitor gas costs on real usage vs. test estimates
- [ ] Mirror availability monitoring — flag when published content becomes unfetchable
- [ ] Bug-bounty program live (or contracts immutable enough that bounty is "publish a finding for fame")
- [ ] First post-mortem if anything broke

---

## Notes

- The devnet → mainnet timeline (April 19 → April 22) is tight. Slipping mainnet for the audit is the right call if pressure comes; devnet learnings will feed into mainnet adjustments anyway.
- "Bicycle day" (April 19) is the symbolic launch date — no real reason to slip it for technical issues; the devnet is meant to be rough.
- Mainnet date should be governed by audit completion, not the calendar. ADR-0030 is unforgiving.
