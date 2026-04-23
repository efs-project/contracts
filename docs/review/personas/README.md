# Review Personas

These prompt files make the review roles reusable and stable.

Important:
- Some subagent systems assign arbitrary worker names.
- The stable identity should be the role name in the prompt and in summaries.

Recommended convention:
- When delegating, say "Running `ADR Governance Auditor`" rather than relying on a generated nickname.
- When reporting results, group findings under the role name, not the worker handle.

Pre-launch review posture:
- This repo is still pre-launch on a weekly-reset devnet.
- Accepted ADR contradictions are not automatic merge blockers.
- The review goal is to catch **accidental drift**, **runtime/spec/doc inconsistency**, and **undocumented deliberate change**.
- If the branch is clearly improving the design, reviewers should ask whether the change is deliberate and documented, not assume the older ADR must win.
- Explicit higher-layer conventions are allowed when they are named honestly. Example: a client may define `effective TAG = active TAG with weight >= 0` for one feature, as long as it does not relabel that projection as kernel-level `active`/`inactive`.

PR review format is mandatory:
- Follow `docs/agent-workflow.md` for PR/review conventions.
- Use GitHub's native Review feature for PR feedback so inline findings become resolvable review threads.
- Start every review body, inline comment, and issue reply with `[<model-name> · <role>]` on its own line.
- Use the persona's stable role name in that prefix rather than a random worker nickname.
- Mention the reviewing model + version explicitly in PR descriptions and review summaries when relevant.

Shared placeholders:
- `<repo_path>`: absolute repo path
- `<branch_name>`: branch under review
- `<base_ref>`: comparison base, usually `origin/main`
- `<head_sha>`: current head commit
- `<verification_context>`: fresh verification results from the review coordinator

General reviewers:
- [default-deep-review.md](./default-deep-review.md)
- [principal-merge-blocker.md](./principal-merge-blocker.md)
- [defcon1-nuclear.md](./defcon1-nuclear.md)

Specialist reviewers:
- [adr-governance-auditor.md](./adr-governance-auditor.md)
- [devtools-truthfulness-auditor.md](./devtools-truthfulness-auditor.md)
- [invariant-breaker.md](./invariant-breaker.md)
- [perf-quick-pass.md](./perf-quick-pass.md)
- [performance-scalability-auditor.md](./performance-scalability-auditor.md)
- [review-response-manager.md](./review-response-manager.md)

Suggested usage:
- Small or local changes: `default-deep-review`
- Cross-file behavior or risky logic: `principal-merge-blocker`
- Schema/indexing/router/ADR-sensitive work: `defcon1-nuclear`
- PR hardening pass: run the three specialists in parallel
- Day-to-day hot-path check: add `perf-quick-pass`
- Scale-sensitive work (indexers, resolvers, pagination, explorer reads, write batching): add `performance-scalability-auditor`
- After fixes land on a PR: use `review-response-manager` to drive replies/resolution on unresolved review threads

Process doc:
- [review-squad.md](../review-squad.md)
