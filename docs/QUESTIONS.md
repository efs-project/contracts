# Open Questions

Tier 1 and Tier 2 questions blocking work in this repository.

> **Current state (2026-07-23): no active repo-local blockers.** The questions
> previously listed here were settled for v1. EFS v2 architecture questions
> belong in the planning vault's owner-decision inboxes, not in this file.

See `docs/agent-workflow.md` for escalation rules.

## Open

None.

## Recently resolved

### Devnet and Sepolia proxy pattern

Resolved by ADR-0048 and the Sepolia deployment: the v1 schema resolvers use
`TransparentUpgradeableProxy` plus `ProxyAdmin`. The deployed contracts are
Safe-owned and remain upgradeable; no burn timeline is active. See
`docs/CHAINS.md`.

### Multi-lens merge semantics

Resolved for v1 by ADR-0031: ordered, first-attester-wins fallback. A
newest-across-lenses merge mode was not added.

### Production EFS client repository

The separate `efs-project/client` repository exists but is a legacy v1 client,
not the implementation target for Client v2.

## How to add a question

Add only a Tier 1 or Tier 2 blocker after surfacing it in chat:

```markdown
### [tier-N, YYYY-MM-DD, agent-name] Short title

State the concrete fork, options, default, and exactly what it blocks.
```

Task-local questions belong in code comments. Nice-to-have work belongs in
`docs/FUTURE_WORK.md`. Cross-repo and v2 architecture choices belong in the
planning vault.
