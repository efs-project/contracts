# Open Questions

Questions agents have flagged for human decision. Review and resolve before agents continue work in those areas.

> **For agents:** see `docs/agent-workflow.md` for the full escalation tier system. This file holds **questions awaiting the human's decision** specifically. Routing by tier:
> - **Tier 1** — belong in chat first (blocking). Add here only after the human acknowledges, for tracking.
> - **Tier 2** — belong in chat AND here.
> - **Tier 3** — questions about specific in-progress tasks belong here. Other Tier 3 items route elsewhere: nice-to-haves to `FUTURE_WORK.md`, decisions you made to `decisions.md`, line-specific observations as `// AGENT-NOTE:` comments.

> **Format:** newest at top. When resolved, move to `docs/decisions.md` (one-liner) and either delete from this file OR mark resolved in-place. Promote to an ADR if the decision is durable and architectural.

---

## Open

### [tier-2, 2026-04-16, claude] Devnet upgradeability proxy pattern

You said you plan to add upgradeability for devnet/Sepolia. Which proxy pattern?

- **TransparentUpgradeableProxy (OpenZeppelin)**: well-documented, proven, but adds ~2,600 gas per call (delegatecall + impl SLOAD).
- **UUPS (OpenZeppelin)**: cheaper per-call, upgrade logic lives in the implementation (more flexible, slightly more risk).
- **Beacon proxy**: shared upgrade target across many proxies; overkill for EFS.

For EFS the gas-sensitive path is the EFSIndexer hot path (every attestation). Worth the per-call overhead for devnet flexibility?

**Default if not answered:** TransparentUpgradeableProxy with `hardhat-upgrades` plugin (storage layout enforced). Devnet only — mainnet stays direct deploy per ADR-0030.

**Blocks:** any work on the devnet upgradeability branch.

### [tier-2, 2026-04-16, claude] Multi-edition merge semantics

ADR-0031 establishes first-attester-wins fallback semantics. Holistic review noted that for `?editions=alice,bob,carol` users may expect "merge by newest timestamp across all editions" rather than strict precedence.

Should we:
- **A**: keep first-wins as the only model, document it loudly in the production UI ("attesters are tried in order").
- **B**: add a second router function `_findDataAtPathMerge()` that returns newest-by-timestamp across all editions; UI offers a toggle.
- **C**: add a query param `?merge=newest` that switches the existing function's behavior.

C is cleanest for URLs. B is cleanest for code. A is cheapest.

**Default if not answered:** A for v1; revisit based on production UI feedback.

**Blocks:** anything that depends on multi-edition resolution semantics being final. Doesn't block this PR.

### [tier-2, 2026-04-16, claude] Production EFS Client UI review scope

The internal devtools UI in `packages/nextjs/` has been reviewed. The production EFS Client (Vite/Lit, separate repo) has not been included in any review pass. It is the actual user touchpoint pre-launch.

Should the dev-process branch reference the external repo path so agents can discover it? Or do you want the production client review held until a dedicated session?

**Default if not answered:** add a stub `docs/external-repos.md` with the path and reviewer notes; defer the actual review to a dedicated session.

**Blocks:** complete pre-launch readiness assessment.

---

## Resolved (recent — keep for context)

*(none yet — populate as questions get answered)*

---

## How to add a question

```markdown
### [tier-N, YYYY-MM-DD, agent-name] Short title

What's the question? Be specific.

Options if applicable:
- **A**: option with trade-offs.
- **B**: another option with trade-offs.

**Default if not answered:** what the agent will do otherwise (so blocked work isn't fully blocked — there's a default position).

**Blocks:** what other work this affects.
```
