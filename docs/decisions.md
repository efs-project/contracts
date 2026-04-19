# Decision Log

Informal dated log of small decisions agents made while working. Lighter than ADRs — one or two sentences per entry. Promote to a full ADR if the decision turns out to be durable or controversial.

> **For agents:** add an entry here for any Tier 2 or Tier 3 decision (per `AGENTS.md`) that doesn't merit a full ADR. Newest at top.

> **Format:** `### YYYY-MM-DD — [agent] Short title` followed by 1-3 sentences.

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
