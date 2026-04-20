# Future Work

Backlog of known improvements, scale concerns, and architectural enhancements that aren't blocking launch but are worth tracking.

> **Format:** organized by theme. Each item: 1–3 sentences on what + why. Add `[ADR-NNNN]` cross-refs where relevant. Newest items at the top of each section.

> **For agents:** when you discover something belonging here, append. When you start working on something here, move it to a GitHub issue with `next-up` label and remove from here.

---

## Architecture & Extensibility

### Kernel auto-tag `/tags/schema` on alias anchor creation
Per ADR-0033, schema alias anchors (root-child anchors whose name is a registered schema UID in lowercase 0x-hex) are today **only** tagged with `/tags/schema` for the six system schemas seeded at deploy (`06_schema_aliases.ts`). User-created aliases (when someone registers a custom schema and attests a root anchor at its UID) need a follow-up tx to attach the tag before the sidebar enumerator sees them. Proper fix: in `EFSIndexer.onAttest` (or a kernel hook on ANCHOR attestations with `refUID == rootAnchorUID`), detect when `name` is a registered schema UID via `SchemaRegistry.getSchema` and auto-attest the `/tags/schema` TAG from the kernel. Care needed to avoid gas griefing — only triggered when name parses as bytes32 AND the UID exists in SchemaRegistry.

### Schema extensibility escape hatch
Mainnet schema UIDs are baked in (ADR-0030). Adding a field to ANCHOR or DATA requires full system redeploy. A minimal `mapping(bytes32 uid => bytes data) extensions` in EFSIndexer would let future versions store extra data per attestation without re-deploying everything. Worth considering before mainnet — once frozen, no longer possible.

### Edition lists as first-class on-chain objects
URLs with `?editions=alice,bob,carol,dave,...` get long. Capped at 20 (ADR-0026). A future enhancement: register an edition list as an Anchor with member PROPERTYs, then reference the list by UID. URLs become `?editionList=<uid>` — short and shareable. Composes with existing edition resolution.

### Multi-edition merge semantics
Currently first-attester-wins (ADR-0031). Users may want "newest by timestamp across all editions" or "consensus." Could be a second router function or a query parameter. See `docs/QUESTIONS.md` for current open question.

### Forward-compatible event schema
EFSIndexer emits events for off-chain indexing. Adding a field to an event later breaks indexers that decode strictly. Consider a versioning scheme or extra `bytes` field per event for future expansion.

---

## Performance & Scale

### Sort overlay at >10K items
`computeHints` punts to client-side for lists >1K. `getSortedChunk` is O(N) traversal capped by `maxTraversal`. For lists of 100K+ items, pagination is sequential — no random access. Consider: time-bucketed secondary indices, hashed offset support, or accepting that very large lists need off-chain sort hints.

### Mirror cap drift over decades
`MAX_PAGES = 10` (ADR-0020) caps mirror scan at 500. Over decades, an attester accumulating revoked-but-still-indexed mirrors might push valid ones beyond the cap. Either: enforce on-chain mirror consolidation (revoke old, attest canonical set) periodically, or accept that very long-lived DATA may need fresh attesters.

### Garbage collection / index compaction
Append-only indices (ADR-0009) grow monotonically. Most revocations leave dead entries forever. A compaction primitive (re-attest the same content with same UID? — no, not how EAS works) is theoretically possible but has no clean design. Worth thinking about for the >10-year horizon.

### `_containsAttestations` full de-propagation
Currently sticky (ADR-0010). No longer affects folder visibility (that's tag-only post-2026-04-18), but still leaves stale flags on ancestors after file placements are revoked. Full reference-counted de-propagation would clean this up but costs gas at every untag. Low priority now that folder visibility has moved.

### Large directory pagination across attesters
`getDirectoryPageBySchemaAndAddressList` works for 20 attesters max (ADR-0026). For "follow 100+ curators" use cases, requires either: relaxing the cap (gas concerns), client-side aggregation (complex but cheap), or a future merge endpoint.

### Off-chain CDN integration
Every web3:// request hits eth_call directly. No HTTP cache headers (ETag, Last-Modified, Cache-Control) in router responses. Adding these would let gateways cache aggressively, dramatically reducing eth_call load for popular content.

---

## Missing APIs

### Bulk operations
Publishing 100 files = ~800 transactions (8 per file). A multicall pattern or batch helper contract would meaningfully improve UX for content publishers. Could be a separate non-core contract.

### Content-addressed lookup in EFSFileView
EFSIndexer has `dataByContentKey`. EFSFileView doesn't expose "where is this content placed?" as a high-level query. Add `getPathsForContent(bytes32 contentHash)` — useful for de-duping uploads, finding canonical paths, etc.

### Bulk revocation
Revoking 1000 old TAGs = 1000 transactions. EAS supports multi-revoke; consider exposing a router/helper that batches.

### Edition discovery — "who has attested under this folder?"
Currently you must know attester addresses to query. An `attestersInFolder(uid, start, length)` enumerable would help discovery layers bootstrap. Cost: another append-only index.

---

## UX & Frontend (internal devtools)

### Runtime-switchable NetworkChip (auto-probe local + dropdown switcher)
The current `NetworkChip` in the header is **read-only**: it displays the active chain + RPC URL inferred from `NEXT_PUBLIC_HARDHAT_RPC_URL` at build time and a copy button, but doesn't let the user switch. A future enhancement: (a) on first visit, probe `http://127.0.0.1:8545` with a short-timeout `eth_chainId` call — if reachable, prefer local; otherwise use the build-time devnet URL. (b) Dropdown with "Local / Devnet / Custom URL…" that saves preference to localStorage and reloads. Requires bootstrapping wagmi config from localStorage before `scaffold.config.ts` evaluates, so this is a refactor rather than a tack-on. Alpha ships without it because the build-time env var covers the two primary deploy targets (local + devnet) unambiguously.

### Per-container home pages ("Myspace mode")
Every container (anchor / address / schema / attestation) is currently rendered with a minimal info panel + directory grid. A future enhancement is per-container user-defined "home pages" — e.g. a `description` / `icon` / `homeDataUID` PROPERTY attached to the container, which the panel picks up and expands into a rich header. Works for any container flavor. No schema changes needed; only PROPERTY keys + UI rendering.

### Accurate edition-filtered child count on folder rows
Folder rows in `FileBrowser.tsx` currently render the literal `"Folder"` in edition mode because `indexer.getChildrenCount(uid)` is a kernel-level count over permanent anchors and never shrinks when placements are revoked (see `docs/decisions.md` 2026-04-19). A true count would require either a per-row view call (file-placement TAGs active under this folder for this edition list + tagged subfolders) or a new counting helper in `EFSFileView`. Low priority — cosmetic — but worth wiring once a pattern exists.

### Attestations section in sidebar
The sidebar has Anchors, Addresses, and Schemas sections. An Attestations section would complete the set, but top-N-recent heuristics aren't obvious — skip until a usage pattern emerges.

### ENS reverse lookup everywhere in the UI
v1 does ENS reverse lookup only for the address in the URL bar and the Addresses sidebar list. Attester chips on file cards, mirror panels, etc. still show 0x… hex. A shared `useEnsName(addr)` hook with cache would make it ubiquitous at low cost.

### Empty-folder filtering in edition view
Sticky `_containsAttestations` (ADR-0010) means empty folders appear in edition listings. The UI could cross-check with `containsAttestations()` to hide them — cosmetic improvement, no on-chain change.

### Attester attribution in multi-edition listings
When `?editions=alice,bob` shows two files named `readme.md` (one from each), the UI doesn't visually distinguish them. Add per-card attester badge.

### Mirror staleness indicator
External transports (ipfs, https) can break. UI could attempt a HEAD request from the user's browser and show a "mirror unavailable" badge. Doesn't break the file itself; just signals.

### Bulk file selection / actions
Currently single-file operations only. Multi-select for batch tagging, untagging, etc.

### Keyboard accessibility audit
File browser cards aren't fully keyboard-navigable. Modal dialogs (TagModal) lack focus trap and ARIA roles. Pre-launch polish item.

---

## Tooling & Process

### GitHub Action: auto-trigger Claude review on PR open
Currently agent reviews are manual. A `.github/workflows/agent-review.yml` triggering Claude on PR open would close that loop. Cross-review with Codex similarly automatable.

### `make questions` shortcut to surface open items
The QUESTIONS.md file works only if the human checks it. A daily-use shortcut (alias, Makefile target, or shell function) to print open questions reduces friction.

### ~~`// AGENT-Q:` in-code question marker~~ — *landed in agent-workflow.md; remove from backlog.*
For questions tied to specific lines (rather than whole-task questions), an in-code marker pattern that agents grep for. Lighter than QUESTIONS.md for quick clarifications.

### Integration test suite for full upload + read cycle
Current tests cover individual contracts. An end-to-end test (`yarn fork` → `yarn deploy` → upload via simulated client → read via web3:// → verify bytes) would catch wiring drift before deploy.

### Gas budget regression tests
Track gas usage of hot paths (upload flow, directory listing, router resolution) over time. Catch regressions early.

---

## Security & Audit

### Devnet IPFS upload auth
The public devnet's `POST /api/v0/add` endpoint is currently unauthenticated — any browser can pin arbitrary bytes into the devnet's IPFS daemon. Acceptable for an ephemeral "resets weekly" devnet and for alpha testing, but ship-blocking for any long-lived deployment that intends users to rely on pinned content persisting. Pre-launch work: add a token-gated auth layer (devnet operator whitelist, or EAS-attested uploader list) on the reverse proxy, or accept that uploads must originate from the app (which can sign them) rather than arbitrary clients.

### Devnet Arweave write path
Public ingress is gateway-only (`/arweave/<txid>` reads succeed; `POST /arweave/` returns 405). For the alpha that's fine — the dev flow puts content on IPFS primarily — but the production client must not attempt to publish ar:// mirrors to the devnet's arweave endpoint without a write path. Either provision a signed-upload route or document ar:// as read-only on this devnet. Cross-ref ADR-0011 (transport anchors).

### External audit on EFSIndexer
Single most important pre-mainnet item. EFSIndexer is permanent and the kernel of the system — one external pass from a credentialed firm (Trail of Bits, OpenZeppelin, Code4rena contest) is worth the cost. See `docs/LAUNCH_CHECKLIST.md`.

### Anchor name length cap
`_isValidAnchorName` (ADR-0025) doesn't currently cap byte length. A 100KB filename is technically allowed. Add a cap (e.g. 255 bytes) to prevent storage-cost griefing.

### Fuzzing / property tests for path resolution
`resolvePath`, `_findDataAtPath`, mirror selection are good targets for property-based testing (Foundry/Echidna). Adversarial path construction is the relevant attack class.

---

## Discovery & Ecosystem

### Curator seeding for launch
Without a discovery layer, EFS is a dark forest. Seeding with anchor curators (Wikipedia snapshot, Project Gutenberg, government records, etc.) bootstraps the ecosystem. Pre-launch coordination.

### Public web3:// resolver guidance
Document how third parties can run their own EFS-aware web3:// gateway. Lower the dependency on any single gateway.

### Subgraph / The Graph integration
Build and publish a subgraph that aggregates EFS attestations into queryable views. Off-chain indexing closes the gap on rich queries the on-chain kernel doesn't support.
