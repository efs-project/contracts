# Agent Workflow

Rules for any AI agent working in this repo — Claude Code, Codex CLI, Cursor, Gemini, GitHub Actions, etc. Read this before any non-trivial task.

## Escalation tiers — when to ask the human

The human runs several agents in parallel. Wrong-direction work compounds expensively. **When in doubt, default to Tier 2.**

### Tier 1 — STOP AND ASK NOW (blocking)

Stop work immediately. Ask in chat. Do not commit, do not "prepare" speculative work, do not just append to QUESTIONS.md and continue. Wait for an answer.

Triggers:
- About to do something that **contradicts an existing ADR**.
- About to **modify a schema UID, contract address, or anything that breaks deployed state**.
- About to do something that would **require user data migration** post-launch.
- Choosing between **two or more non-trivial architectural approaches** with no clear winner from existing docs.
- About to **delete or rewrite >200 lines** of working, tested code.
- About to **write to a storage structure an ADR designates as append-only, immutable, or permanent** — regardless of code size. (Line count is a weak proxy; immutability violations can be small.)
- Discovering that completing the task as specified would **break a different invariant** the human probably didn't consider.

### Tier 2 — ASK BEFORE NEXT COMMIT (semi-blocking, default for ambiguity)

Finish the immediate task. At end of turn: surface the question in chat AND append to `docs/QUESTIONS.md`. Do not start the next commit until resolved.

Triggers:
- New external dependency (npm package, Solidity library, MCP server, CI service).
- **Public API change** (new function signature, removed function, behavioral change visible to consumers).
- **Deviation from project convention** observable from existing code.
- **Significant performance or gas trade-off** (>10% in either direction on a hot path).
- A decision that **deserves an ADR** (durable, hard to reverse, affects future agents).
- The human's instruction has **two reasonable interpretations** and you picked one.

### Tier 3 — NOTE FOR LATER (non-blocking)

Append to the appropriate file and keep working. **Tier 3 items do NOT go in `docs/QUESTIONS.md`** — that file is auto-loaded at session start and must stay reserved for Tier 1/2 blockers.

- **In-code `// AGENT-Q:` comments** — task-specific questions bound to code lines. Preferred for most Tier 3 questions.
- **In-code `// AGENT-NOTE:` comments** — observations bound to specific lines (not questions).
- **`docs/FUTURE_WORK.md`** — nice-to-have improvements, scale concerns, refactor opportunities.
- **`docs/decisions.md`** — small decisions you made that future agents should know about (one-line entries with date and reasoning).

## Asking well

When you escalate (Tier 1 or 2), the human's time is the constrained resource. Make the question:

- **Specific.** "Should we do A or B?" with file paths and trade-offs. Not "what should we do?"
- **Backed by reasoning.** Why is this hard? What did you consider? What's your default if no answer?
- **Bounded.** What does answering unblock? What does NOT answering let you keep doing?

Good Tier 1 question:

> Working on EFSRouter mirror selection. Found that `_getBestMirrorURI` returns the highest-priority mirror, but ADR-0013 says edition-scoped only. With `?editions=alice,bob` and Alice has only `https://`, Bob has `web3://`, current code serves Alice's https://. ADR-0013 implies first-attester-wins (so https:// is correct), but the user-facing behavior of "always serve the best transport" might be what's actually wanted. Two options:
> - A: Strict ADR-0013 — first attester with any mirror wins, even if low-priority.
> - B: Promote priority across attesters — best mirror across the edition list.
> No path forward without your call. Defaulting to A if you don't reply for 30 minutes.

## When you make a decision

If you make a Tier 2 or 3 decision and act on it, **document it**:

- **Tier 2** decisions: add or update an ADR, OR add an entry to `docs/decisions.md` with date and reasoning. Mention in PR description.
- **Tier 3** decisions: one-line entry in `docs/decisions.md`.

ADRs are **immutable** once `Status: Accepted`. To change a decision, write a new ADR that supersedes the old one and update the old one's Status to `Superseded by ADR-NNNN`.

### Keeping `decisions.md` healthy

`decisions.md` is an append-only historical log; it will grow over time. Periodically (or when an agent notices the file approaching ~500 lines), prune:

- **Stabilized patterns** (the same decision applied repeatedly) → promote to a new ADR. Delete the original entries with a pointer to the ADR.
- **Reversed or irrelevant decisions** → delete, or move to a "superseded" section.
- **Small decisions that never mattered again** → delete outright.

Pruning is a Tier 3 task itself; log the pruning pass in `decisions.md` as a single entry.

## Working alongside other agents

If another agent is working on the same area (check git log, recent PRs, branch names like `claude/*` or `codex/*`):

- **Coordinate before stomping.** Use a different worktree or branch.
- **Cross-review.** If your work touches code another agent recently changed, re-read their changes before editing.
- **Disagreements escalate to human.** If you and another agent's work conflict on a non-trivial design choice, surface to the human — don't silently overwrite.

## Pre-PR checklist

Before opening or merging any PR:

- [ ] All tests pass (`yarn hardhat:test` for contracts, `yarn next:check-types` for frontend).
- [ ] No `console.log`, `// TODO`, `// FIXME`, or commented-out code from your session.
- [ ] If you changed contract behavior: relevant ADR updated or new ADR added.
- [ ] If you changed system behavior: relevant spec in `specs/` updated.
- [ ] PR description explains the **why**, not just the what.

## When the rules are wrong

If a rule in this file is blocking sensible work, that's a Tier 2 trigger. Surface it. Don't quietly bypass.
