# Contributing to EFS

Thank you for investing your time in contributing to EFS (Ethereum File System).

## Start here

- **Project overview and three-layer architecture** → [`specs/overview.md`](./specs/overview.md)
- **Setup, conventions, workflow rules, escalation tiers** → [AGENTS.md](./AGENTS.md)
- **Pre-PR checklist, asking-the-human protocol** → [`docs/agent-workflow.md`](./docs/agent-workflow.md)
- **Open decisions awaiting input** → [`docs/QUESTIONS.md`](./docs/QUESTIONS.md)

The rules in `AGENTS.md` and `docs/agent-workflow.md` apply to every contributor — human or AI. If you're using Claude Code, Codex CLI, Cursor, or Gemini Antigravity, your agent should pick them up automatically.

## Pull requests

We follow a standard fork-and-pull workflow:

1. Fork the repo and clone your fork.
2. Create a branch with a descriptive name (e.g. `fix/router-chunk-boundary` or `feat/new-sort-func`).
3. Make your changes. Run `yarn hardhat:test`, `yarn next:check-types`, and `yarn docs:check` before pushing.
4. Open a PR; the maintainer will review.

Before merging, satisfy the pre-PR checklist in `docs/agent-workflow.md` — in particular, update the relevant spec in `specs/` if you changed observable behavior, and add or supersede an ADR if you made a durable architectural decision.

## Bug reports and feature requests

Open a GitHub issue. Include reproduction steps, affected contract or file paths, and the behavior you expected.

## Questions

For design questions that need James's input before you start work, append to `docs/QUESTIONS.md` (format in the file) and also raise it in chat if it's blocking. Tier 1 issues stop work; Tier 2 issues finish the current task then pause.

---

*This project is built on the [Scaffold-ETH 2](https://github.com/scaffold-eth/scaffold-eth-2) starter kit. The Scaffold-ETH license (`LICENCE`) is preserved; EFS-specific code is MIT-licensed (`LICENSE`). See `docs/adr/0029-dual-licensing-mit-agpl.md`.*
