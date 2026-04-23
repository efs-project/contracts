# Human PR Workflow

Use this file if you are a human coordinating agent help on a PR and you want a clean, low-drama process.

The main lesson from PR #10 was simple:

- good results came from explicit prompts
- messy results came from vague prompts like `review PR #10`

This page gives you the shortest practical workflow.

## Quick Start

### Before asking for review

Make sure the PR description is current:

- summary is up to date
- test plan is up to date
- `Agents involved` is up to date

Also do one quick scan of:

- existing agent-authored PR comments
- unresolved review threads

That helps avoid duplicate or contradictory review comments.

If the PR description is stale, reviewers will review the wrong thing.

### Ask for review

Copy/paste this:

```text
Run review-squad on PR #<N>.
Read the PR description first, including Agents involved.
Read the governing specs / ADRs for the changed area before commenting.
If unsure which reviewers to run, default to principal-merge-blocker + perf-quick-pass.
Post findings using GitHub's native Review feature, not plain comments.
Use resolvable inline review threads whenever the finding maps to a diff hunk.
Put non-inline findings in the top-level review body.
Prefix every review body, inline comment, and issue reply with [model · role].
Follow docs/agent-workflow.md and the repo PR template conventions.
Do not leave placeholder, probe, or praise-only comments.
```

Notes:

- the prefix should be on its own line
- use the stable review role name, not a random worker nickname
- keep `Agents involved` updated with model + version
- if the branch is architecture-sensitive, ask for `defcon1-nuclear` explicitly

### After fixes land

Copy/paste this:

```text
Run review-response-manager on PR #<N>.
Fetch unresolved review threads and classify each as fixed now, pushback/needs decision, or future work.
For fixed threads: reply with [model · dev], mention the fixing commit SHA, then resolve the thread.
For pushback threads: reply with [model · dev] and leave the thread unresolved.
For future-work threads: reply with [model · dev], link the durable follow-up, and resolve only if the thread is explicitly non-blocking.
Use native review-thread replies/resolution, not top-level PR comments.
```

If an agent posts `--approve`, treat that as advisory only. The human still decides whether the PR is actually ready to merge.

## Which Review Mode Should I Use?

If you are unsure, use:

- `principal-merge-blocker`
- `perf-quick-pass`

Ask for `defcon1-nuclear` plus `perf-quick-pass` when the PR touches:

- schemas
- resolvers
- indexers
- router behavior
- append-only storage assumptions
- ADR-sensitive architecture

If you are not sure whether a branch is risky enough, ask for `review-squad` and say it should escalate when the branch is architecture-sensitive.

## What Good Output Looks Like

Good review output looks like this:

- real GitHub Review threads, not random top-level comments
- inline comments where the finding maps to the diff
- every agent comment starts with `[model · role]`
- findings are concrete and actionable
- if there are no findings, the review says that explicitly
- after fixes, the dev replies in-thread with `[model · dev] fixed in <sha>`
- resolved threads are actually resolved, not just ignored

## Common Mistakes

Avoid these:

- `review PR #<N>`
- praise-only or “LGTM” comments from the shared account
- test/probe comments like “checking anchor”
- leaving review threads unanswered
- resolving threads without replying
- asking reviewers to work from a stale PR description

## If Native Review Threads Are Not Available

Ask for one paste-ready structured review instead of ad hoc comments.

The fallback format should look like:

```text
[model-name · role]

Review mode: <reviewer or squad name>
Base/head: <base_ref>.. <head_sha>

Findings
1. [P1] <short title>
- Why it is wrong
- Exact file and line references
- Concrete regression or risk
- Minimally correct fix direction

Verification
- <command> — <result>
```

## Where To Go Deeper

If you want the deeper system docs:

- repo-level rules: [AGENTS.md](../AGENTS.md)
- review routing and personas: [docs/review/review-squad.md](./review/review-squad.md)
- agent PR/review conventions: [docs/agent-workflow.md](./agent-workflow.md)
