# Review Squad

`review-squad` is the lightweight process doc for choosing which review personas to run before calling a branch PR-ready.

## Goal

Use a consistent mix of reviewers without over-reviewing every small change. The default posture is:

- keep reviews practical
- catch runtime and design risk early
- scale review intensity with change scope
- add performance review whenever a change can hurt gas, RPC fanout, pagination, or transaction UX

PR review output must follow the repo's GitHub conventions:
- use GitHub's native Review feature, not plain PR comments, for review passes
- make inline findings resolvable review threads whenever the finding maps to a diff hunk
- start every review body, inline comment, and issue reply with `[<model-name> · <role>]` on its own line
- use the stable persona role name, not a generated worker nickname
- include model + version in the PR's `Agents involved` field and in agent-authored review summaries when relevant

Do not invoke reviewers with only `review PR #<N>`. That shorthand is too weak
for this repo and tends to produce low-signal shared-account chatter instead of
clean resolvable review threads.

## Core reviewers

- [default-deep-review.md](./personas/default-deep-review.md)
- [principal-merge-blocker.md](./personas/principal-merge-blocker.md)
- [defcon1-nuclear.md](./personas/defcon1-nuclear.md)

## Specialist reviewers

- [adr-governance-auditor.md](./personas/adr-governance-auditor.md)
- [devtools-truthfulness-auditor.md](./personas/devtools-truthfulness-auditor.md)
- [invariant-breaker.md](./personas/invariant-breaker.md)
- [perf-quick-pass.md](./personas/perf-quick-pass.md)
- [performance-scalability-auditor.md](./personas/performance-scalability-auditor.md)
- [review-response-manager.md](./personas/review-response-manager.md)

## Default selection

### Small or local changes

Run:

- `default-deep-review`

Add:

- `perf-quick-pass` if the change touches UI data fetching, contract reads, pagination, or user write flows

### Cross-file behavior changes

Run:

- `principal-merge-blocker`

Add:

- `perf-quick-pass` if the branch changes hot reads, listing logic, sort behavior, resolver calls, or transaction batching

### Architecture-sensitive changes

Run:

- `defcon1-nuclear`

Add specialists as needed:

- `adr-governance-auditor` for design-direction / spec / ADR drift
- `devtools-truthfulness-auditor` for debug UI, comments, scripts, tests, and copy
- `invariant-breaker` for resolver/indexer/router/kernel correctness
- `perf-quick-pass` by default

## Performance review rule

### Use `perf-quick-pass` for day-to-day work when:

- a screen adds or changes contract reads
- a flow adds or changes EAS writes
- pagination, sorting, filtering, or editions logic changes
- contract helpers are added or removed
- any branch could increase RPC calls, transaction count, or wallet confirmations

### Add the full `performance-scalability-auditor` when:

- the branch changes indexers, resolvers, router behavior, or append-only storage behavior
- a read path may eventually face 100k+ or 1M+ records/users
- a workflow might become unusable due to RPC fanout or transaction count
- there is uncertainty about whether critical functionality can remain meaningfully onchain
- the quick pass finds a real scale concern and deeper analysis is needed

The full performance audit is optional for most branches, but strongly recommended for large scale-sensitive changes.

## Suggested squads

### Standard hardening pass

- `principal-merge-blocker`
- `perf-quick-pass`

### Full merge-blocking pass

- `defcon1-nuclear`
- `adr-governance-auditor`
- `devtools-truthfulness-auditor`
- `invariant-breaker`
- `perf-quick-pass`

### Scale-heavy pass

- `defcon1-nuclear`
- `invariant-breaker`
- `perf-quick-pass`
- `performance-scalability-auditor`

## Output preference

Prefer one merged dev-facing comment after all reviewers finish. Keep raw specialist comments when:

- findings disagree
- a specialist found something unusually subtle
- the branch needs separate follow-up threads by concern type

## After review: response and resolution

When a PR has unresolved review threads, run `review-response-manager` after the fix pass.

Thread policy:
- fixed now: reply with `[<model-name> · dev]`, mention the commit SHA, then resolve the thread
- pushback / needs decision: reply with `[<model-name> · dev]` and leave the thread unresolved
- future work / accepted defer: reply with `[<model-name> · dev]`, link the durable follow-up, and resolve only when the thread is clearly non-blocking

Do not leave review threads hanging without a reply just because the answer is "not in this PR."

## Review preflight

Before an agent posts review feedback, it should first:

- read the PR description and the `Agents involved` field
- read the governing specs / ADRs for the area it is reviewing
- scan existing agent comments so it doesn't duplicate findings or miss active pushback
- decide whether it can create native GitHub review threads cleanly

If it cannot create native review threads, it should stop and return one
paste-ready structured review instead of posting ad hoc comments to the PR
timeline.

## Recommended PR prompts

### Review prompt

Use this when you want a clean PR review pass:

```text
Run review-squad on PR #<N>.
Read the PR description first, including Agents involved.
Read the governing specs / ADRs for the changed area before commenting.
Post findings using GitHub's native Review feature, not plain comments.
Use resolvable inline review threads whenever the finding maps to a diff hunk.
Put non-inline findings in the top-level review body.
Prefix every review body, inline comment, and issue reply with [model · role].
Follow docs/agent-workflow.md and the repo PR template conventions.
Do not leave placeholder, probe, or praise-only comments.
```

### Response prompt

Use this after fixes land and you want clean thread handling:

```text
Run review-response-manager on PR #<N>.
Fetch unresolved review threads and classify each as fixed now, pushback/needs decision, or future work.
For fixed threads: reply with [model · dev], mention the fixing commit SHA, then resolve the thread.
For pushback threads: reply with [model · dev] and leave the thread unresolved.
For future-work threads: reply with [model · dev], link the durable follow-up, and resolve only if the thread is explicitly non-blocking.
Use native review-thread replies/resolution, not top-level PR comments.
```
