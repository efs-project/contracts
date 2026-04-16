# AGENTS.md

This file is the cross-tool contract for any AI agent working on this repository — Claude Code, Codex CLI, Cursor, Gemini Antigravity, GitHub Actions agents, or any other.

If you are an agent reading this for the first time in a session, **read this entire file before doing anything else**, then read the discovery list below.

## Project: EFS (Ethereum File System)

On-chain file system built on EAS attestations. Pre-launch (devnet target April 19, 2026). One human (James), several AI agents. Contracts will be **permanent on mainnet** for credible neutrality — there is no upgrade path post-launch. This raises the bar for every change.

## Discovery order

Before acting on any task, read these in order:

1. **`CLAUDE.md`** — project conventions, key commands, architecture overview.
2. **`docs/specs/`** — current system behavior. Authoritative for "how does X work right now?"
3. **`docs/adr/`** — past decisions and their reasoning. Read the README to scan; read individual ADRs when about to do something an ADR might cover.
4. **`docs/QUESTIONS.md`** — open items awaiting James's decision. Don't act on anything blocked here.
5. **`docs/FUTURE_WORK.md`** — known backlog. If your task overlaps, surface that.
6. **`docs/LAUNCH_CHECKLIST.md`** — what's blocking launch.
7. **`reference/`** — external specs (EAS, EIPs, Scaffold-ETH).

Use Grep/Glob aggressively. Don't ask "where is X?" — find it.

## Escalation tiers — when to interrupt the human

The human is one person managing several agents in parallel. Wrong-direction work compounds expensively. **When in doubt, default to Tier 2.**

### Tier 1 — STOP AND ASK NOW (blocking)

Stop work immediately. Ask in chat. Do not commit, do not "prepare" speculative work, do not append to `QUESTIONS.md` and continue. Wait for an answer.

Triggers:
- About to do something that **contradicts an existing ADR** (the ADR is wrong, OR you're misreading it, OR a new decision is needed — all three need the human).
- About to **modify a schema UID, contract address, or anything that breaks deployed state**.
- About to do something that would **require user data migration** post-launch.
- Choosing between **two or more non-trivial architectural approaches** with no clear winner from existing docs.
- About to **delete or rewrite >200 lines** of working, tested code.
- Discovering that **completing the task as specified would break a different invariant** the user probably didn't consider.

### Tier 2 — ASK BEFORE NEXT COMMIT (semi-blocking, default for ambiguity)

Finish the immediate task. At end of turn: surface the question in chat AND append to `docs/QUESTIONS.md`. Do not start the next commit until resolved.

Triggers:
- New external dependency (npm package, Solidity library, mcp server, CI service).
- **Public API change** (new function signature, removed function, behavioral change visible to consumers).
- **Deviation from project convention** observable from existing code.
- **Significant performance or gas trade-off** (>10% in either direction on a hot path).
- A decision that **deserves an ADR** (durable, hard to reverse, affects future agents).
- The human's instruction has **two reasonable interpretations** and you picked one.

### Tier 3 — NOTE FOR LATER (non-blocking)

Append to the appropriate file and keep working.

- **`docs/QUESTIONS.md`**: question about a specific in-progress task that needs eventual human input.
- **`docs/FUTURE_WORK.md`**: nice-to-have improvements, scale concerns, refactor opportunities.
- **`docs/decisions.md`**: small decisions you made that future agents should know about (one-line entries with date and reasoning).
- **In-code `// AGENT-NOTE:` comments**: observations bound to specific lines.

## Asking well

When you escalate (Tier 1 or 2), the human's time is the constrained resource. Make the question:

- **Specific.** "Should we do A or B?" with file paths and trade-offs. Not "what should we do?"
- **Backed by reasoning.** Why is this hard? What did you consider? What's your default if no answer?
- **Bounded.** What does answering unblock? What does NOT answering let you keep doing?

A good Tier 1 question:

> Working on EFSRouter mirror selection. Found that `_getBestMirrorURI` returns the highest-priority mirror, but ADR-0013 says edition-scoped only. With `?editions=alice,bob` and Alice has only `https://`, Bob has `web3://`, current code serves Alice's https://. ADR-0013 implies first-attester-wins (so https:// is correct), but the user-facing behavior of "always serve the best transport" might be what's actually wanted. Two options:
> - A: Strict ADR-0013 — first attester with any mirror wins, even if low-priority.
> - B: Promote priority across attesters — best mirror across the edition list.
> No path forward without your call. Defaulting to A if you don't reply for 30 minutes.

## When you make a decision

If you make a Tier 2 or 3 decision and act on it, **document it**:

- Tier 2 decisions: add or update an ADR, OR add an entry to `docs/decisions.md` with date and reasoning. Mention in PR description.
- Tier 3 decisions: one-line entry in `docs/decisions.md`.

ADRs are immutable once `Status: Accepted`. To change a decision, write a new ADR that supersedes the old one and update the old one's Status to `Superseded by ADR-NNNN`.

## Working alongside other agents

If another agent is working on the same area (check git log, recent PRs, branch names like `claude/*` or `codex/*`):

- **Coordinate before stomping.** Use a different worktree or branch.
- **Cross-review.** If your work touches code another agent recently changed, re-read their changes before editing.
- **Disagreements escalate to human.** If you and another agent's work conflict on a non-trivial design choice, surface to James — don't silently overwrite.

## Pre-PR checklist

Before opening or merging any PR:

- [ ] All tests pass (`yarn hardhat:test` for contracts, `yarn next:check-types` for frontend).
- [ ] No `console.log`, `// TODO`, `// FIXME`, or commented-out code from your session.
- [ ] If you changed contract behavior: relevant ADR updated or new ADR added.
- [ ] If you changed a public API: relevant spec in `docs/specs/` updated.
- [ ] PR description explains the **why**, not just the what.

## Coding conventions

- **Solidity:** match existing style. Public-state-as-discovery is the pattern (queryable getters, not opaque internals). Append-only kernel; filtering is the consumer's job.
- **TypeScript:** match existing Scaffold-ETH 2 patterns. Use `useScaffoldReadContract` / `useScaffoldWriteContract` for contract interaction.
- **Tests:** every new contract function gets at least a happy-path and a revert-path test.
- **Comments:** explain why, not what. The code shows what.
- **Commits:** present-tense imperative. Co-author the human and any other agent involved.

## When the rules are wrong

If a rule in this file is blocking sensible work, that's a Tier 2 trigger. Surface it. Don't quietly bypass.

---

*Last updated: 2026-04-16. Maintained by agents in collaboration with the human owner. To propose changes, follow Tier 2.*
