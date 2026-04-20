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

### [tier-2, 2026-04-20, claude] ADR-0035 PROPERTY singleton claim does not hold — write-side rebind accumulates

ADR-0035 §3 states: "re-TAGging replaces the previous value" via `_activeByAAS` "per-attester singleton semantics", and calls this out as **load-bearing** (§Consequences). **The claim is incorrect.** `TagResolver._activeByAAS[definition][attester][targetSchema]` is an append-only array, not a singleton; entries are keyed by `compositeHash = keccak256(attester, targetID, definition)`. A value *change* necessarily uses a new PROPERTY attestation (new UID → new `targetID`), so the new TAG fires a fresh compositeHash and PUSHES a new entry rather than superseding the old one. Observed today: `PropertiesModal` rendered whichever entry happened to sit at index 0, which in steady state is the oldest push.

I shipped a defensive read-side fix in this PR's follow-up (fetch all active targets, pick newest by EAS `time`). That stops users from seeing stale values in the modal immediately, but the underlying accumulation is still present and it leaks: `_activeTotalByDefAndAttester` grows with each rebind, and any other consumer that walks `_activeByAAS` for PROPERTY keys sees ghosts.

Which of these do you want:

- **A**: Harden the write path in `PropertiesModal` (and any other PROPERTY writer) to look up and `applies=false`-supersede the prior TAG for the same `(attester, keyAnchor)` before attesting the new one. Restores actual singleton semantics at the index level. ~1 extra tx per rebind. ADR-0035 stays as-written.
- **B**: Change the TAG resolver's compositeHash to key on `(attester, definition, targetSchema)` instead of `(attester, targetID, definition)` so the new TAG genuinely supersedes prior active entries without needing a revoke. Matches ADR-0035's claim at the contract level but changes hot-path semantics for *all* TAG consumers (DATA placements, etc.) and is effectively a schema-adjacent change — likely Tier 1.
- **C**: Supersede ADR-0035 with a new ADR that acknowledges PROPERTY rebinds are append-only at the index level and consumers must filter by newest `time`. Cheapest; formalizes current behavior.

**Default if not answered:** ship the defensive read-side fix (already done), note the mismatch in `decisions.md`, revisit before mainnet.

**Blocks:** doesn't block this PR. Does block any future consumer that relies on ADR-0035's singleton claim (e.g. a gas-optimized on-chain read of "the one current PROPERTY value for attester X under key K").

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
