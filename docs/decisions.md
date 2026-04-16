# Decision Log

Informal dated log of small decisions agents made while working. Lighter than ADRs — one or two sentences per entry. Promote to a full ADR if the decision turns out to be durable or controversial.

> **For agents:** add an entry here for any Tier 2 or Tier 3 decision (per `AGENTS.md`) that doesn't merit a full ADR. Newest at top.

> **Format:** `### YYYY-MM-DD — [agent] Short title` followed by 1-3 sentences.

---

### 2026-04-16 — [claude] dev-process branch initial structure

Created `dev-process` branch from main with: lean `AGENTS.md` as canonical entrypoint, `CLAUDE.md` as one-line pointer to AGENTS.md, `docs/agent-workflow.md` for escalation tiers and workflow rules, 32 ADRs (29 from dev's notes + 3 architectural retroactive), `docs/QUESTIONS.md`, `docs/FUTURE_WORK.md`, `docs/LAUNCH_CHECKLIST.md`, `docs/decisions.md`. Tier 2 is the default escalation tier per the human's guidance. ADRs follow the immutable-once-accepted convention; supersession is the only way to evolve them. Architecture lives in `specs/` — agent-facing docs point to specs rather than duplicating.

---

## Older entries

*(populate as decisions accumulate)*
