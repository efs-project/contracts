# Decision Log

Informal dated log of small decisions agents made while working. Lighter than ADRs — one or two sentences per entry. Promote to a full ADR if the decision turns out to be durable or controversial.

> **For agents:** add an entry here for any Tier 2 or Tier 3 decision (per `AGENTS.md`) that doesn't merit a full ADR. Newest at top.

> **Format:** `### YYYY-MM-DD — [agent] Short title` followed by 1-3 sentences.

---

### 2026-04-21 — [claude] Commit / PR / agent-attribution conventions

Adopted GitHub-native multi-agent conventions: area-prefix + imperative commit subjects (not strict Conventional Commits — matches OpenZeppelin/Uniswap/Go house style); sentence-case kernel trailers (`Co-authored-by:`, `Reviewed-by:`, `Suggested-by:`, `Tested-by:`) plus an invented `Permanence-tier:`; PR template with required Permanence tier + Specs/ADRs fields; GitHub-native Review via `gh pr review` with GraphQL `resolveReviewThread` for thread resolution; per-comment speaker prefix `[model · role]` for attribution hygiene. AI-disclosure norm follows Foundry/TypeScript (2024) lifted to per-comment granularity. Logged in `docs/agent-workflow.md` § Commits, PRs, and agent attribution; template at `.github/PULL_REQUEST_TEMPLATE.md`. Historical commits keep existing `Co-Authored-By:` title case — the sentence-case fix is prospective only.

### 2026-04-20 — [claude] `yarn preview` now group-kills its children on shutdown

Problem: every `yarn preview` cycle was leaking a `hardhat node` process. User accumulated 7 stale forks over a day, enough to spin the fans visibly. Root cause: `scripts/claude-preview-launch.mjs` spawned `yarn hardhat:fork` and `yarn workspace @se-2/nextjs dev`, then on SIGINT/SIGTERM called `child.kill()` on the top-level yarn. Yarn doesn't forward signals to its descendants, so the outer yarn exited but left `hardhat node` (two `yarn` layers deeper) reparented to launchd and running forever.

Fix: spawn both children with `detached: true` (new process-group leader) and swap `child.kill()` for `process.kill(-child.pid, signal)` to signal the whole group. One transparent knock-on: detached children aren't in the terminal's foreground group anymore, so they don't receive Ctrl+C directly — but the launcher's SIGINT handler already fans signals out via `killTree`, and neither child reads stdin, so the end-to-end behavior is unchanged for the user.

---

### 2026-04-20 — [claude] Removed `web3protocol` preview path in `FileBrowser.tsx`

On devnet (app hosted at `*.nip.io` / eth.limo origin), clicking a file preview triggered Chrome's **Local Network Access** permission prompt ("Access other apps and services on this device — Block / Allow"). Root cause: `FileBrowser.fetchFileContent` dynamically imported `web3protocol`, which bundles WASM, constructs its own `Client` with an RPC URL from `NEXT_PUBLIC_HARDHAT_RPC_URL`, and fetches outside wagmi's configured transport. That out-of-band fetcher crosses the public→private-IP boundary on first preview click and trips LNA, which users read as malware and bounce from.

Fix: deleted the web3protocol attempt entirely; the direct `publicClient.readContract` + gateway path was already the fallback and covers both on-chain SSTORE2 chunks (via `web3-next-chunk` pagination) and `message/external-body` delegation for IPFS/Arweave/HTTPS mirrors. The web3protocol branch also collapsed duplicate Content-Type headers (breaking external-body detection) and fell through on empty bodies anyway — strictly extra surface area. If a "native transport helper" (opt-in local IPFS node, etc.) is added later, it must be an explicit user toggle, never automatic from a preview click. Package `web3protocol` left in `package.json` for now; tree-shakeable and can be removed in a cleanup pass.

---

### 2026-04-19 — [claude] Folder child-count renders as "Folder" in edition mode

In `FileBrowser.tsx` the folder row previously rendered `{childCount} items` using `indexer.getChildrenCount(uid)`, which is an append-only kernel count over all permanent anchors and never decreases when placements are revoked. In edition-scoped mode the count is always visually wrong after any delete. Replaced with the literal string `"Folder"` when `useEditionsQuery` is true; the raw count still shows in non-edition mode where it matches what's visible. An accurate edition-filtered count would require either a second indexer query per row or a new `_activeByAAS`-counting view — deferred to FUTURE_WORK.

---

### 2026-04-16 — [claude] dev-process branch initial structure

Created `dev-process` branch from main with: lean `AGENTS.md` as canonical entrypoint, `CLAUDE.md` as one-line pointer to AGENTS.md, `docs/agent-workflow.md` for escalation tiers and workflow rules, 32 ADRs (29 from dev's notes + 3 architectural retroactive), `docs/QUESTIONS.md`, `docs/FUTURE_WORK.md`, `docs/LAUNCH_CHECKLIST.md`, `docs/decisions.md`. Tier 2 is the default escalation tier per the human's guidance. ADRs follow the immutable-once-accepted convention; supersession is the only way to evolve them. Architecture lives in `specs/` — agent-facing docs point to specs rather than duplicating.

---

## Older entries

### 2026-04-16 — [claude] Production EFS Client repo URL recorded

The production EFS Client (Vite/Lit) lives at https://github.com/efs-project/client. Recorded inline in `AGENTS.md`. Resolves the Tier 2 question on production client discoverability. Actual review of the client's code is still deferred to a dedicated session per `docs/LAUNCH_CHECKLIST.md`.
