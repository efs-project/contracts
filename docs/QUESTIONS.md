# Open Questions

Questions agents have flagged for human decision. Review and resolve before agents continue work in those areas.

> **For agents:** see `docs/agent-workflow.md` for the full escalation tier system. This file holds **Tier 1 and Tier 2 blocking questions only** — it is auto-loaded at session start and must stay sharp.
>
> Routing:
> - **Tier 1** — belong in chat first (blocking). Add here only after the human acknowledges, for tracking.
> - **Tier 2** — belong in chat AND here.
> - **Tier 3** (task-specific questions) — do NOT go here. Use inline `// AGENT-Q:` code comments, or `decisions.md` if you made a call, or `FUTURE_WORK.md` if it's a nice-to-have.
>
> When resolved, move the entry to `docs/decisions.md` as a one-liner. Don't let this file grow past ~10 items; resolve or reroute.

> **Format:** newest at top. When resolved, move to `docs/decisions.md` (one-liner) and either delete from this file OR mark resolved in-place. Promote to an ADR if the decision is durable and architectural.

---

## Open

### [tier-2, 2026-06-10, claude] Overview `resolveSystemAnchorSet` queries the wrong schema bucket

The Task-15 demo seed now creates `/tags/system` and three `system`-tagged
READMEs (folder `/docs/README.md`, a file-anchor README under `/docs/readme.txt`,
and an address-container README). The TAG shape matches the Overview design and
the existing folder-visibility convention: `definition=/tags/system anchor`,
`refUID=README ANCHOR uid`, `weight=1`.

**Empirically verified on a Sepolia fork** that an anchor-targeted TAG files
under the **target anchor's EAS schema = `anchorSchemaUID`**, NOT `dataSchemaUID`
(EdgeResolver reads `getAttestation(refUID).schema`; an ANCHOR's EAS schema is
always `anchorSchemaUID`, regardless of its decoded `anchorSchema` field). Live
reads: `getActiveTargetsByAttesterAndSchema(systemDef, deployer, anchorSchemaUID)`
returns all three README anchor uids; the same query with `dataSchemaUID` returns
`[]`. The directory-item uid the client intersects against IS the ANCHOR uid.

But `packages/nextjs/utils/efs/resolveSystemAnchorSet.ts` queries the
**`dataSchemaUID`** bucket (introduced by commit `2a17b76`, "correct system-tag
schema bucket to dataSchema"). With the correct seed in place this returns an
empty set, so the Overview pane renders nothing and the hidden-files filter
hides nothing.

- **A**: revert the client to query `anchorSchemaUID` (one-line: pass
  `anchorSchemaUID` instead of `dataSchemaUID` to
  `getActiveTargetsByAttesterAndSchema`; thread `anchorSchemaUID` into
  `resolveSystemAnchorSet`/`useItemOverview`/`FileBrowser`). The pre-`2a17b76`
  design-doc line (`…system, anchorSchemaUID`) was correct.
- **B**: change the seed/convention so the system TAG targets the README **DATA**
  uid (lands in dataSchema bucket) — rejected: the client intersects the set
  against directory-item ANCHOR uids, so a DATA-uid set would never match.

**Default if not answered:** A — the seed is correct as-is; the client query
bucket is the bug. Flagged as a spawned follow-up task.

**Blocks:** the Overview pane actually rendering the seeded READMEs. Does NOT
block this seed PR (the on-chain shape is correct and independently verified).

### [tier-2, 2026-04-16, claude] Devnet upgradeability proxy pattern

You said you plan to add upgradeability for devnet/Sepolia. Which proxy pattern?

- **TransparentUpgradeableProxy (OpenZeppelin)**: well-documented, proven, but adds ~2,600 gas per call (delegatecall + impl SLOAD).
- **UUPS (OpenZeppelin)**: cheaper per-call, upgrade logic lives in the implementation (more flexible, slightly more risk).
- **Beacon proxy**: shared upgrade target across many proxies; overkill for EFS.

For EFS the gas-sensitive path is the EFSIndexer hot path (every attestation). Worth the per-call overhead for devnet flexibility?

**Default if not answered:** TransparentUpgradeableProxy with `hardhat-upgrades` plugin (storage layout enforced). Devnet only — mainnet stays direct deploy per ADR-0030.

**Blocks:** any work on the devnet upgradeability branch.

### [tier-2, 2026-04-16, claude] Multi-lens merge semantics

ADR-0031 establishes first-attester-wins fallback semantics. Holistic review noted that for `?lenses=alice,bob,carol` users may expect "merge by newest timestamp across all lenses" rather than strict precedence.

Should we:
- **A**: keep first-wins as the only model, document it loudly in the production UI ("attesters are tried in order").
- **B**: add a second router function `_findDataAtPathMerge()` that returns newest-by-timestamp across all lenses; UI offers a toggle.
- **C**: add a query param `?merge=newest` that switches the existing function's behavior.

C is cleanest for URLs. B is cleanest for code. A is cheapest.

**Default if not answered:** A for v1; revisit based on production UI feedback.

**Blocks:** anything that depends on multi-lens resolution semantics being final. Doesn't block this PR.

---

## Resolved (recent — keep for context)

### [resolved 2026-04-16] Production EFS Client repo path
URL: https://github.com/efs-project/client — recorded inline in `AGENTS.md`. Production client review is still deferred to a dedicated session (tracked in `docs/LAUNCH_CHECKLIST.md` under Pre-Mainnet → Production UI).

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
