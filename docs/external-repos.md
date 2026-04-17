# External Repos

EFS spans multiple repositories. This file indexes them so agents working across the boundary can find each other.

## Production EFS Client (Vite/Lit)

The user-facing web client — the actual touchpoint for most users — lives in a **separate repository**. The internal UI at `packages/nextjs/` in *this* repo is a Scaffold-ETH-based devtools/debug interface, not the production client.

**Repo path / URL: unresolved** — see `docs/QUESTIONS.md` for the open Tier 2 item.

Agents working on features that touch both the contracts and the production client should:
1. Flag the cross-repo boundary in chat before starting (Tier 2 — the production client review scope is not yet defined here).
2. Do NOT apply Scaffold-ETH patterns (`useScaffoldReadContract`, etc.) to the production client — it uses Vite/Lit, not Next.js.
3. Contract ABI changes require coordination; the production client has its own ABI sync process.

## Other repos

*None currently documented. Add entries here as needed.*
