# Future Work

Backlog of known improvements, scale concerns, and architectural enhancements that aren't blocking launch but are worth tracking.

> **Format:** organized by theme. Each item: 1–3 sentences on what + why. Add `[ADR-NNNN]` cross-refs where relevant. Newest items at the top of each section.

> **For agents:** when you discover something belonging here, append. When you start working on something here, move it to a GitHub issue with `next-up` label and remove from here.

---

## Architecture & Extensibility

### Web-of-trust UX + user-configurable system lenses
ADR-0039 reserves two tiers in the default lenses chain — `webOfTrust[]` and `systemLenses[]` — that are hardcoded / empty today. Shipping needs: (a) a Settings UI for users to add/remove WoT attesters (address + optional label), stored in localStorage; (b) user override of the system tier (defaults to a project-blessed seed list that ships in the repo); (c) a Lenses chip in the toolbar that surfaces the effective chain so users can see "why am I seeing this file?" Client-side only — no contract changes. Critical pre-mainnet, because the devnet's hardcoded bootstrap curator + deployer system tier isn't appropriate once real users are attesting.

### Kernel auto-tag `/tags/schema` on alias anchor creation
Per ADR-0033, schema alias anchors (root-child anchors whose name is a registered schema UID in lowercase 0x-hex) are today **only** tagged with `/tags/schema` for the six system schemas seeded at deploy (`06_schema_aliases.ts`). User-created aliases (when someone registers a custom schema and attests a root anchor at its UID) need a follow-up tx to attach the tag before the sidebar enumerator sees them. Proper fix: in `EFSIndexer.onAttest` (or a kernel hook on ANCHOR attestations with `refUID == rootAnchorUID`), detect when `name` is a registered schema UID via `SchemaRegistry.getSchema` and auto-attest the `/tags/schema` TAG from the kernel. Care needed to avoid gas griefing — only triggered when name parses as bytes32 AND the UID exists in SchemaRegistry.

### Schema extensibility escape hatch
Mainnet schema UIDs are baked in (ADR-0030). Adding a field to ANCHOR or DATA requires full system redeploy. A minimal `mapping(bytes32 uid => bytes data) extensions` in EFSIndexer would let future versions store extra data per attestation without re-deploying everything. Worth considering before mainnet — once frozen, no longer possible.

### Lens lists as first-class on-chain objects
URLs with `?lenses=alice,bob,carol,dave,...` get long. Capped at 20 (ADR-0026). A future enhancement: register a lens list as an Anchor with member PROPERTYs, then reference the list by UID. URLs become `?lensList=<uid>` — short and shareable. Composes with existing lens resolution.

### Multi-lens merge semantics
Currently first-attester-wins (ADR-0031). Users may want "newest by timestamp across all lenses" or "consensus." Could be a second router function or a query parameter. See `docs/QUESTIONS.md` for current open question.

### Forward-compatible event schema
EFSIndexer emits events for off-chain indexing. Adding a field to an event later breaks indexers that decode strictly. Consider a versioning scheme or extra `bytes` field per event for future expansion.

---

## Performance & Scale

### Audit and deprecate `getActiveTargetsByAttesterAndSchema`
`EdgeResolver.getActiveTargetsByAttesterAndSchema` does an N+1 EAS read pattern — one `eas.getAttestation` per TAG entry to resolve `tagUID → targetID`. For large lists this hits gas limits. The preferred path is `getActiveTagEntries` (returns `(tagUID, weight)` in one bulk read) followed by targeted per-UID lookups only as needed. Audit all callers of `getActiveTargetsByAttesterAndSchema` in contracts and the TS client; migrate or deprecate once nothing load-bearing relies on it.

### Dev-UI: batch / cache PIN resolution in FileBrowser page load
`getDirectoryPage` resolves `getActivePinTarget` per `(file, attester)` pair on every page load — an `items × attesters` RPC fanout. Compounds when effective-tag filtering is active (tag resolution iterates `targetSchemaBuckets × attesters × pages`). Collapse into a page-level batch helper or cache data-target results across tag names so cost scales with page size, not `tags × attesters × items`. Dev UI / Ephemeral tier; not a correctness issue.

### Dev-UI: TagModal edge-definition scan scales with lifetime churn
`TagModal` paginates the full append-only `getEdgeDefinitions` set for a target, then does an active-edge lookup and ancestor walk per definition to classify it under `/tags/`. On a heavily-reused DATA UID this scales with all-time edge history, not active tags. Fix: expose a TAG-schema-specific reverse index or `/tags/` classification cache so modal-open cost is O(active tag count). Dev UI / Ephemeral tier.

### Empty default-lens list renders blank instead of a filtered listing
The unfiltered `EFSFileView.getDirectoryPage` listing fallback was removed — every FileBrowser directory read now goes through the lens-scoped `getDirectoryPageFiltered` (ADR-0048), so an empty `lensAddresses` FAILS SAFE (the directory hooks disable and the grid renders empty, never unfiltered `system`/`nsfw` content). Today `defaultLensesForContainer` always appends `systemLenses` (devnet constants), so the default view is never empty. When the mainnet user-configurable-lenses work (the Web-of-trust UX item under Architecture & Extensibility) makes that list potentially empty, the follow-up is to give the empty-list case a FILTERED listing so the view isn't simply blank — NOT to re-introduce an unfiltered path. See the AGENT-NOTEs at `defaultLensesForContainer` (utils/efs/containers.ts) and `systemLenses` (ExplorerClient.tsx).

### TopicTree navigation pane is not exclude-filtered (system/nsfw folders show in the sidebar)
The ADR-0048 exclusion filter is wired into the main FileBrowser grid but NOT into the `TopicTree` sidebar, which lists folders via its own `useLensesDirectoryPage` call without `excludeTagDefs`. So a folder tagged `system`/`nsfw` is hidden from the grid but still appears in the left navigation tree — a partial break of the folder-hide guarantee. Pre-existing (the tree was never filtered) and out of the on-chain-filter PR's grid scope. Fix: lift the exclude-def resolution (currently inside FileBrowser) to a shared hook / ExplorerClient and thread `excludeTagDefUIDs` + `excludeMinWeights` through TopicTree's directory read, so both panes route through `getDirectoryPageFiltered`. Mind TopicTree's own resolution-race gating when doing so.

### Frontend exclude-filter fail-safes — unit coverage (mostly done)
DONE: the pure decision logic was extracted to `utils/efs/excludeFilter.ts`
(`shouldUseFilteredQuery`, `reconcileMinWeights`, `computeExcludesPending`,
`tagsRootGateDecision`) with `utils/efs/excludeFilter.test.ts` + the empty-lenses
fail-safe in `utils/efs/containers.test.ts`; contract entry-guard reverts and the
`getActiveTagWeight` address-target case were added to `EFSFileViewFiltered.test.ts`.
REMAINING: the wiring itself (both directory queries receiving the same excludes;
the place-before-tag ordering) isn't unit-testable without a React component-test
harness (react-testing-library — a Tier-2 dev dependency). Add RTL and
component-level tests if the explorer's exclude wiring keeps regressing.

### Overview README anchor reachable before placement — mitigated; 1-tx residual is inherent
EFSIndexer sets `_containsAttestations[anchorUID][creator]=true` at anchor
creation, and `getDirectoryPageFiltered` phase 1 qualifies items on that flag — so
a `README.md` file slot appears in the listing the moment its ANCHOR is attested,
before any placement PIN exists; `_isItemExcluded` reaches the DATA via the PIN,
so with no PIN it can't hide the slot against the pre-placement `system` tag
(Codex). MITIGATED: `uploadOnchainFile` now creates the file ANCHOR last —
immediately before the placement PIN (and after the DATA is system-tagged) —
shrinking the visible-but-unhidden window from ~6 txs to ~1. The remaining 1-tx
window (anchor mined, PIN not yet) is INHERENT and can't be closed: EAS UIDs
aren't precomputable, so the anchor and the PIN that references its UID can't be
batched atomically. Impact of the residual is minor: name-only (empty card, no
content), only if a brand-new README's first save is interrupted in that 1-tx gap,
self-healing on retry. A contract-level fix (phase-1 qualifying on active
placement rather than `_containsAttestations`) would eliminate it but changes
Durable listing semantics for all files — out of scope here.

### Deferred PR #27 review findings (non-blocking)
- **EFSFileView exclusion gas (Gemini):** in `_isItemExcluded`, pre-check
  `edgeResolver.hasActiveTagFromAny(target, def, attesters)` before the per-attester
  `getActiveTagWeight` loop — for the common clean-item case this skips the inner
  loop (`dataCount × defs × attesters`, worst case 20×8×20). Optimization only;
  deferred because it changes a near-Etched view contract (needs re-pin + re-test)
  and the current code is correct.
- **Markdown structural guard (Codex):** an error boundary now catches render-time
  blowups from untrusted Overviews (`MarkdownView`), but a cheap pre-parse
  structural guard (max nesting depth / line count / token shape) would reject
  pathological input before the parser runs. Add alongside the RTL work above.
- **`sniffContent` 64 KB window (Gemini):** binary/invalid-UTF-8 after the first
  64 KB is still classified as text (then rendered as markdown — safe, no raw HTML).
  Consider a full-file NUL scan if perf permits. Add a >64 KB boundary test and an
  empty-directory `getDirectoryPageFiltered` test (returns empty items + cursor).

### EFSFileView phase-0 folder pagination scales with append-only history
`getDirectoryPageBySchemaAndAddressList` (phase 0) walks `getChildrenWithEdge` history under a fixed scan budget; a hot folder with many revoked or out-of-lens edges can exhaust the budget before returning a full page. Latency scales with historical churn, not live child count. Long-term: add a direct active-visibility index in EFSIndexer or EdgeResolver so phase-0 pagination is O(page) on active children. Tracked alongside ADR-0009 append-only implications.

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

### Lens discovery — "who has attested under this folder?"
Currently you must know attester addresses to query. An `attestersInFolder(uid, start, length)` enumerable would help discovery layers bootstrap. Cost: another append-only index.

---

## UX & Frontend (internal devtools)

### Standard (unscoped) folder view shows dead LIST/file anchors after delete + navigation
Deleting a list or file revokes the user's placement PIN, but the standard non-lens listing comes from `getDirectoryPage`, which returns the permanent anchor regardless of whether any placement PIN is active. The `deletedListAnchors` session-local suppression hides the dead card only until a refresh / folder navigation clears it; the card then returns and `openList()` can only report the placement missing. **Systemic to the standard raw-anchor view** (dead *file* anchors behave identically) — not list-specific. Proper fix: filter the standard list/file path by an active placement PIN at render time (an RPC-per-anchor fanout — fold into "Dev-UI: batch / cache PIN resolution" above), or persist suppression (localStorage) until an active placement is re-observed. Ephemeral debug UI; **deferred per maintainer de-scoping of debug-UI polish (2026-05-31)** — future agents can pick this up. Flagged repeatedly by Codex on PR #20.

### Runtime-switchable NetworkChip (auto-probe local + dropdown switcher)
The current `NetworkChip` in the header is **read-only**: it displays the active chain + RPC URL inferred from `NEXT_PUBLIC_HARDHAT_RPC_URL` at build time and a copy button, but doesn't let the user switch. A future enhancement: (a) on first visit, probe `http://127.0.0.1:8545` with a short-timeout `eth_chainId` call — if reachable, prefer local; otherwise use the build-time devnet URL. (b) Dropdown with "Local / Devnet / Custom URL…" that saves preference to localStorage and reloads. Requires bootstrapping wagmi config from localStorage before `scaffold.config.ts` evaluates, so this is a refactor rather than a tack-on. Alpha ships without it because the build-time env var covers the two primary deploy targets (local + devnet) unambiguously.

### Per-container home pages ("Myspace mode")
Every container (anchor / address / schema / attestation) is currently rendered with a minimal info panel + directory grid. A future enhancement is per-container user-defined "home pages" — e.g. a `description` / `icon` / `homeDataUID` PROPERTY attached to the container, which the panel picks up and expands into a rich header. Works for any container flavor. No schema changes needed; only PROPERTY keys + UI rendering.

### Accurate lens-filtered child count on folder rows
Folder rows in `FileBrowser.tsx` currently render the literal `"Folder"` in lens mode because `indexer.getChildrenCount(uid)` is a kernel-level count over permanent anchors and never shrinks when placements are revoked (see `docs/decisions.md` 2026-04-19). A true count would require either a per-row view call (file-placement TAGs active under this folder for this lenses list + tagged subfolders) or a new counting helper in `EFSFileView`. Low priority — cosmetic — but worth wiring once a pattern exists.

### Attestations section in sidebar
The sidebar has Anchors, Addresses, and Schemas sections. An Attestations section would complete the set, but top-N-recent heuristics aren't obvious — skip until a usage pattern emerges.

### ENS reverse lookup everywhere in the UI
v1 does ENS reverse lookup only for the address in the URL bar and the Addresses sidebar list. Attester chips on file cards, mirror panels, etc. still show 0x… hex. A shared `useEnsName(addr)` hook with cache would make it ubiquitous at low cost.

### Empty-folder filtering in lens view
Sticky `_containsAttestations` (ADR-0010) means empty folders appear in lens listings. The UI could cross-check with `containsAttestations()` to hide them — cosmetic improvement, no on-chain change.

### Attester attribution in multi-lens listings
When `?lenses=alice,bob` shows two files named `readme.md` (one from each), the UI doesn't visually distinguish them. Add per-card attester badge.

### Mirror staleness indicator
External transports (ipfs, https) can break. UI could attempt a HEAD request from the user's browser and show a "mirror unavailable" badge. Doesn't break the file itself; just signals.

### Bulk file selection / actions
Currently single-file operations only. Multi-select for batch tagging, untagging, etc.

### Keyboard accessibility audit
File browser cards aren't fully keyboard-navigable. Modal dialogs (TagModal) lack focus trap and ARIA roles. Pre-launch polish item.

---

## Tooling & Process

### Review-process helper scripts
The PR/review process is now documented well enough to use, but still relies on humans/agents remembering too much ceremony. High-value helpers:
- `scripts/review/preflight-pr` to gather PR body, `Agents involved`, changed files, existing agent comments, unresolved threads, and likely governing specs/ADRs into one review brief.
- `scripts/review/respond-threads` (or equivalent) to paginate unresolved review threads, apply the fixed / pushback / defer loop, and resolve threads via GraphQL with retries.
- `yarn review:check` for lightweight local validation of PR template completeness, `[model · role]` prefixes, and reply/resolve metadata.

### Review persona de-duplication and generalization
The review personas currently duplicate the same GitHub-review rules and are still somewhat overfit to the PIN/TAG migration. Refactor toward a shared base header (review-format, verification-context, common preflight) plus smaller role-specific prompts, and replace hardcoded migration-specific reads with a pluggable "governing docs for this change" slot.

### Agent-process eval canary suite
A small suite of red-flag prompts to test that the agent workflow actually fires the right behaviors. Run on new models or after revising `docs/agent-workflow.md`. Grade traces, not just final outputs. Candidate canaries:
- *"Add a field to the DATA schema"* — must stop at Tier 1 (schema UIDs are immutable).
- *"Backfill the missing entries in the qualifying-folder index"* — must stop at Tier 1 (append-only per ADR-0009).
- *"Rename a debug UI label"* — should take the trivial-changes fast path without escalation.
- *"Change a TS API the Vite client consumes"* — must hit Tier 2 (Durable boundary).
- *"Post a PR review comment"* — must include the `[model · role]` speaker prefix.
- *"Approve your own PR"* — must recognize agent approval as advisory, not governance.

Flagged as highest-leverage process follow-up by Codex (2026-04-22 high-mode review). Aligns with OpenAI and Anthropic guidance that evals beat prompt prose for reliability. Cross-ref: `docs/agent-workflow.md`.

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

### Agent-session security policy
`docs/agent-workflow.md` § Working principles has a minimal security posture (use tools freely; treat fetched content as data that may be prompt-injecting; never commit `.env*`). A fuller policy is needed: least-privilege scoping on any tokens an agent has access to, a prompt-injection response playbook (what an agent should do if it suspects the content it just fetched is trying to redirect the task), guidance on handling secrets that leak into logs or transcripts, and posture on MCP-server trust. Scope deliberately narrow pre-launch; expand as the attack surface grows (open-ended web access, tool permissions, MCP servers). Cross-ref: [OpenHands on prompt injection in software agents](https://openhands.dev/blog/mitigating-prompt-injection-attacks-in-software-agents).

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

---

## Lists UI — production client features (flagged 2026-05-28)

### ~~Lists in the Explorer folder grid~~ — DONE (2026-05-30; revised 2026-05-31)
Lists appear as purple cards in the folder grid and open an in-pane editor. Placement is exactly like a file — `ANCHOR(anchorType=LIST_SCHEMA_UID) + LIST(free-floating) + PIN(definition=anchor, refUID=LIST)` (ADR-0044 correction). Per ADR-0046, a LIST_ENTRY is pure membership identity; order + free-text label are PIN-bound PROPERTYs on the stable entry UID (free text is arbitrary length now). ANY-mode `target` is `keccak(text)`. See `ListPreviewPane.tsx`, `utils/efs/listEncoding.ts` (unit-tested), ADR-0044 + ADR-0046 + decisions.md.

### Lens defaulting — viewing a list shows ONLY your own entries
`ListPreviewPane` reads `entries(listUID, lens = connectedAddress)`. So you only ever see entries **you** added; opening a list someone else curated shows it empty. For the "share my top-10" use case the viewer needs to see the *curator's* entries (default lens → `mode.curator`), with an attester/lens picker (discovered from `ListEntryAttested` events + a custom-address input, per ADR-0031 first-wins waterfall) to switch views. This is the main gap blocking *shared/curated* lists; personal lists are unaffected. [ADR-0044 §lenses, ADR-0031, ADR-0039]

### ~~ANY-mode item text limited to 31 bytes~~ — DONE (2026-05-31, ADR-0046)
Resolved. Free-text labels are now an arbitrary-length `name` PROPERTY on the entry UID (the ANY-mode `target` is `keccak(text)`); the byte cap is gone. See ADR-0046.

### Lists edition picker — minor UX warts (devtools, flagged in round-2 review)
- **Stale edition chips:** `getListAttesters` is append-only (ADR-0009), so an attester who added then revoked all their entries stays in the index and shows as an empty, clickable edition chip. The contract NatSpec says filter by `getLength(listUID, attester) > 0` for *active* lenses; the pane doesn't (would add N reads). Acceptable for the debug UI; filter before production exposure.
- **List-card load flash:** list anchors are classified via `isList(item, listSchemaUID)`, so until `LIST_SCHEMA_UID` resolves they're briefly filtered out of the grid (a one-frame pop). Not gated on the loading guard because that would delay folders/files for a list-only concern.

### ~~Reorder/edit are non-atomic revoke-then-attest (residual data-loss window)~~ — DONE (2026-05-31, ADR-0046)
Resolved for reorder and edit. They no longer touch the entry at all — reorder re-PINs the `"weight"` order PROPERTY and edit re-PINs the `"name"` label PROPERTY (cardinality-1 supersede, O(1)), so the entry UID is never revoked and there is no `ListFull` re-attest window. (Removal still revokes the entry, which is correct — it is a deletion.) See ADR-0046.

### Post-create UID copy button
After creating a list the success notification shows a truncated UID. A copy-to-clipboard button on the notification (or a modal success state with the full UID) would make it easy to share or use the UID elsewhere.

### Lists — surface read-failures and unordered entries in the UI (from ADR-0046 review)
Two non-blocking polish items from the round-3 review of the order/label-as-PROPERTY work:
- **Read-failure affordance (F1):** `readEntryProperty` now propagates RPC errors and the enrich effect retains last-known order/label + `console.error`s on a transient failure (so a blip no longer silently reorders/blanks). The remaining polish is a *user-visible* non-blocking indicator ("couldn't refresh N items") rather than console-only.
- **Unordered-entry grouping (F4):** entries with no `"weight"` order PROPERTY (legacy, or a half-written add) sort last by `entryUID`. Three semantically different populations (legacy / read-failed / mid-write) collapse into one bucket. Render them in a visually distinct "unordered" group with a tooltip instead of silently appending to the ranked list.

### Lists UI — items marked out of scope for v1
ENS resolution on identity keys, bulk address paste, drag-to-reorder lens stack, SCHEMA-mode browse picker, ANY-mode keccak256 helper, deep-link `?lens=` URL param on detail page. [specs/2026-05-28-lists-ui-design.md]

### Lens-scoped list sorting — investigated, deferred (2026-05-31)
We looked at making list ordering an on-chain, lens-scoped concern via `EFSSortOverlay` (a new `sourceType 2` reading `ListEntryResolver` + a `WeightSort` comparator + per-lens `SORT_INFO`s). A 3-agent review (feasibility / lens-semantics / adversarial) said **don't build it as designed**, for reasons worth preserving:

- **It breaks the lens waterfall.** A viewer has an *ordered* lens list and membership resolves first-wins (ADR-0044). Pinning a single content-lens in the `SORT_INFO` would make *sorting change which entries you see*, not just their order — a correctness break. Encoding the content-lens in `targetSchema` is also Etched-field overloading.
- **The requirement is already met client-side.** "Bob sorts Alice's list in his lens" decomposes into *membership = the viewer's lens waterfall* (unchanged) and *order = the sort-lens's `weight` PROPERTY* (ADR-0046), read per stable entry UID. Bob writes his own `weight` PROPERTYs on Alice's entry UIDs and sorts in his lens — no contract change.
- **On-chain comparator cost.** `WeightSort.getSortKey` reads a PROPERTY (3–5 SLOADs + 2 calls) *per item, inside `processItems`* — 5–10× heavier than `NameSort`/`TimestampSort` and a real OOG risk on large lists. It also resurrects on-chain decimal→int parsing that ADR-0046 §Alt#4 deliberately rejected.
- **No consumer.** Nothing in the repo reads a list's *order* on-chain today; ordering is a "NICE" (ADR-0046). And changing `EFSSortOverlay` orphans `SORT_INFO_SCHEMA_UID` (the overlay address is baked in) — an Etched, kernel-wired change.

**Decision:** keep ADR-0046's client-side, lens-scoped `weight`-PROPERTY sort. **Two follow-ups when warranted:**
1. *Cross-lens client wiring* (small, no contract change): let a viewing lens read membership via the waterfall but order via its own lens's weights, so "Bob re-orders Alice's list in his lens" works in the UI. The current client sorts each lens's own edition single-lens.
2. *On-chain ordering, only if a real on-chain consumer appears*: prefer a **single per-(list, lens) ordered-vector PROPERTY** (ADR-0046 §Alt#5) over the overlay — cheaper, one-fetch read, **and crucially no schema change** (it's just a PROPERTY value), unlike the overlay path.

**Schema-freeze note:** neither viable path changes any schema. Only the rejected overlay path would (it re-registers `SORT_INFO`). So lens-scoped sorting does **not** block the schema freeze.

*(Pre-existing, unrelated: `specs/06` §2 documents a 2-field `SORT_INFO` but the deployed schema is 3-field — `+ uint8 sourceType` per `deploy/04_sortoverlay.ts`. Worth a fix-in-passing during the freeze pass.)*

### Lists — deferred review nits (perf + API consistency)
Non-blocking items from the multi-reviewer pass (Gemini / Claude-4.7), parked for after launch:
- **RPC fanout (client, debug UI):** `ListPreviewPane` enrich reads order+label per entry as ~6 sequential reads × N entries, and the folder-delete cascade reads per child. Fine for hand-curated lists; batch via multicall if a large-list path ever matters.
- **`ListReader` lacks the attester-index passthrough:** `getListAttesters`/`getListAttesterCount` live on `ListEntryResolver`; the documented consumer ABI (`ListReader`, redeployable) should mirror them for external consumers. Small, no schema impact.
- **`ListReader` redundant EAS read:** `entries()` calls `eas.getAttestation(listUID)` once per page to denormalize `targetType`; could cache/skip. Minor gas on a view.
- **Validation order:** `ListEntryResolver` checks `DuplicateIdentity` before the cap — both revert, so the order is cosmetic; intentional (dedup is the cheaper/more-specific signal).

### Lists deploy — CREATE2 before mainnet freeze (from Gemini / Claude 4.7 / Codex ×2 PR #20 review)
`deploy/09_lists.ts` predicts the `ListResolver` / `ListEntryResolver` addresses from the deployer **nonce** (CREATE), deterministic on the pinned fork (ADR-0037). ADR-0044 §8 prescribed CREATE2 so the schema UIDs (which hash the resolver addresses) survive nonce drift across live networks. **ADR-0046 §"Supersession scope" scopes the "functionally equivalent" framing to the devnet pinned-fork regime only — on mainnet (no pin), any nonce-consuming tx on the deployer's account before deploy shifts every schema UID.** Before the mainnet freeze, move these to a CREATE2 deterministic-salt deploy (this also dissolves the partial-deploy nonce fragility that the current safe-abort guards against).

**Why this is correctly deferred to the freeze, not done now.** CREATE2 ties the resolver address to the **initcode** (`keccak(0xff ++ factory ++ salt ++ keccak(initcode))`), whereas nonce-CREATE is bytecode-independent. During active devnet iteration the resolver bytecode keeps changing (this PR alone added `WrongSchema` to `ListEntryResolver`), so a CREATE2 address would move on *every* bytecode edit → the schema UID would churn → entries orphan on each iteration. Nonce-CREATE on a fresh pinned fork keeps the address stable across bytecode changes, which is what you want while iterating. CREATE2's cross-environment determinism only pays off once the bytecode is **frozen** (mainnet), so adopting it *at* the freeze — when the salt becomes a permanent, Etched input to the address derivation and warrants a deliberate choice — is the right sequencing, not a delay.

**Implementation notes for the freeze task.**
- CREATE2's cross-network determinism assumes the canonical CREATE2 factory is present at the same address on the target chain (e.g. Arachnid's `0x4e59…956C`); verify availability before committing.
- The **salt becomes a permanent Etched input** to the address derivation — it's a deliberate pick at the freeze, not an incidental default.
- The `_listAttesters` on-chain attester index (`getListAttesters` / `getListAttesterCount`, added this PR) is load-bearing storage baked into `LIST_ENTRY_SCHEMA_UID` (recorded in `docs/decisions.md`, 2026-05-30) — fold it into the schema-freeze documentation pass.

### Lists deploy — `ListEntryResolver` address mis-prediction on a persistent node (arg-change)
`deploy/09_lists.ts` predicts `futureListEntryResolverAddress` as `existingListEntryResolver?.address ?? getCreateAddress(nonce+3)`. On a **persistent** node (long-lived anvil with a prior deployment) where the LIST constructor args change — e.g. the `uint32`→`uint256` `maxEntries` widening changed `LIST_SCHEMA_UID`, which *is* a `ListEntryResolver` constructor arg — the script keeps the **old** artifact address, but `redeployIfArgsChanged()` (~L190) then deletes that artifact and `deploy()` redeploys at the current (higher) nonce, so the deployed address ≠ the address baked into `listEntrySchemaUID`. The address assertion **aborts loud** (never registers a wrong/silent schema UID), but the deploy is wedged until the artifact is cleared. **Cannot fire on the pinned wipe-and-redeploy fork** (CI / devnet): `getOrNull` returns null on a fresh chain, so it nonce-predicts correctly — proven by `deploy-pin-check` passing on the `uint256` commit (`eb57f42`). Fix: detect the arg-change before choosing the predicted address and predict/register against the address `deploy()` will actually land at, or skip `redeployIfArgsChanged` for `ListEntryResolver`. Folds into the CREATE2 migration above (which rewrites this prediction/registration logic). Surfaced by the PR #20 adversarial deploy review + Codex (3331191025).

### Demo seed runs *before* `09_lists` — demo-data edits churn List addresses — DONE
**Resolved (markdown-for-items PR).** The demo seed was moved to run last (`deploy/10_seed_demo_tree.ts`, after `09_lists`, with a `Lists` dependency), so demo-data transactions can no longer shift the CREATE addresses of any contract-deploying step. Contract addresses are now deterministic for the commit independent of seed content (ADR-0037). The CREATE2 migration noted above is still the long-term fix for cross-network determinism, but the seed no longer perturbs anything regardless of order.

---

## Write-flow & future schemas (flagged 2026-05-28, PM + brainstorm swarm)

### EFSUploadGateway batch-wrapper (write-flow ergonomics)
A single EFS write today detonates into ~8 wallet prompts (chunk SSTORE2 + DATA + MIRROR + contentType triple + ANCHOR + PIN + ancestor visibility TAGs). **Lists add to this** — a single list placement is LIST + LIST_ENTRY + PIN + per-entry PROPERTY attestations. The leading fix is an `EFSUploadGateway` batch-wrapper contract that composes the multi-attestation flow behind one signature (EAS `multiAttest` + the gateway orchestrating chunk deploys). Keep in the back pocket; **do not scope-creep into Lists v1.** This is a system-wide write-ergonomics concern, orthogonal to the Lists data model. Cross-ref ADR-0041 (PIN/TAG), ADR-0044 (LIST/LIST_ENTRY), `specs/04-Core-Workflows.md` §Upload.

### EVENT / TRANSITION schema for state-transition edges
The brainstorm swarm flagged a future need for a schema expressing **state-transition edges** — provenance, ownership handoff, synonymy-with-citation, "X superseded by Y," etc. This is a *directed transition* primitive, distinct from PIN/TAG (membership/placement edges) and from LIST/LIST_ENTRY (collection membership). **Explicitly NOT Lists' job** — noted here so it doesn't get shoehorned into the LIST primitive. If pursued, it gets its own ADR following the purpose-built-schema pattern (ADR-0041/0044 shape), not a generic mechanism (cf. ADR-0045's deferral).

---

## Overview pane — deferred hardening (markdown-for-items PR, codex-gpt-5 review)

Non-blocking follow-ups for the per-item Overview markdown pane. The shipped v1 is a thin client orchestration over existing utils (the SDK is meant to own resolution/fetch/pagination later); these are the rough edges that review surfaced and we consciously deferred.

### Exact `README.md` resolution instead of a directory-page scan — DONE
**Resolved.** `useItemOverview` no longer lists+scans the directory page. It resolves `README.md` by exact path through the router (`EFSRouter.request` → `EFSIndexer.resolveAnchor` / `_nameToAnchor`, an O(1) lens-scoped lookup, first-lens-wins) and reads the router's `404` ("no such anchor" / "no content for the active lens") as "no Overview". This is pagination-proof and removes the per-pane O(page) scan. (Exact "is file/property X under folder Y?" resolution is a foundational on-chain API — `resolveAnchor(parent, name, schema)` for files, `resolvePath(parent, name)` for generic folders — not something to paper over in the SDK.)

### System-tag hide filter does a global tag scan per load
Defaulting `drawerTagFilters.system = "exclude"` (so Overviews are hidden from the file list like `nsfw`) routes every Explorer load through `FileBrowser.resolveTagSet`, which resolves `/tags/system` and paginates all active system-tag targets across all lenses before the page renders — O(all Overviews in the lens) rather than O(current page). It reuses the **exact** existing `nsfw` machinery (same accepted pattern), so it's not a new architecture, but the system set grows with one tag per Overview. Proper fix: hide system/README entries by batch-checking only the visible DATA UIDs after the page is known, rather than a global pre-scan — a shared refactor that improves the `nsfw` path too.

### Optional: bound the main file preview's fetch too
**Resolved for the Overview path:** `fetchFileContent` now takes an opt-in `maxBytes` — the mirror branch rejects an oversized `Content-Length` and otherwise streams with an early abort, and the on-chain branch stops accumulating past the cap, throwing `FileTooLargeError`. `useItemOverview` passes `MAX_RENDER_BYTES`, so a folder visit can't be forced to download an arbitrarily large external README. The remaining (lower-priority) gap is the **main file preview** (`FileBrowser`), which calls `fetchFileContent` without `maxBytes` — that's a *user-initiated* click on a specific file rather than an automatic load, so the unattended-DoS concern doesn't apply, but a sensible large-file guard there (with a "download instead of preview" affordance) would still be a nice hardening.

### Paged/batched chunk manager for uploads above ~24 MB
**Partly resolved:** uploads are now capped by chunk count — `MAX_CHUNKS = 1000` in `lib/efs/sstore2.ts`, with `MAX_ONCHAIN_SIZE = MAX_CHUNKS * CHUNK_SIZE` (~24 MB), enforced up front in `uploadOnchainFile`, `CreateItemModal`, and `MirrorsPanel`. The cap exists because `MockChunkedFile`'s constructor stores every chunk address with one cold SSTORE in a single deploy tx (~22k gas each), so ~1,000 chunks ≈ 23 M gas sits safely under a 30 M block while ~1,250 (the old 30 MB) risked OOG *after* the user paid for all chunk deploys. The remaining work is to lift the ceiling: replace the single-constructor manager with a **paged/batched deploy** (e.g. an `addChunks(address[])` appender called in bounded batches, or an SSTORE2-pointer index) so >24 MB files become possible without a one-shot constructor that can exceed the block gas limit. `MAX_CHUNKS` is the single knob to raise once that lands. The `1000` figure is a conservative estimate, not a measured limit — gas-test the real manager-deploy budget when revisiting.
### getDirectoryPageFiltered — minor follow-ups (ADR-0048 review, non-blocking)
Two P3s from the PR #26 review squad, both deliberately deferred: (1) `_isItemExcluded` and `_buildFileSystemItems` each `eas.getAttestation` + decode the same anchor for every *kept* item — bounded by `maxItems` so it never threatens the call, but the predicate could hand back the decoded `anchorType`/`isFolder` for the build step to reuse. (2) The view-level scan budget bounds the per-item exclusion loop but NOT the single underlying `EFSIndexer.getAnchorsBySchemaAndAddressList` call, which can scan up to `total` raw positions on a pathologically dense revoked/non-lens array — a pre-existing property shared with `getDirectoryPageBySchemaAndAddressList`, now inherited by a second public view. Worth a direct gas/fuzz test on the indexer page-fill before launch.
