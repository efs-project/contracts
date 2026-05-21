# Design Process — Lessons Learned

Captured from the EFS Lists design work (rounds 11–17 + side threads, 2026-04-15 through 2026-05-21). Intended to outlive any single design and inform future EFS architectural work.

This file is process retrospective, not normative spec. Treat as advice that's been earned, not rules.

## What went well

### Multi-round external review caught what internal review missed

Across 16+ rounds, **outside agents (Gemini, Codex, fresh Claude) consistently surfaced issues that internal subagents had signed off on.** This was the single biggest design-quality lever. The pattern was: cross-agent collaboration produces frame-blind work; humans + outside-perspective reviewers question the frame.

If a design is Etched-tier, treat outside review as required, not optional. Each round cost ~1-3 days of wall time; each round caught at least one BLOCKING issue that would have shipped to mainnet otherwise.

### "What's settled" preambles in review prompts

Prompts explicitly listing decisions reviewers should NOT re-litigate kept rounds focused. Without this, reviewers default to rebuilding from first principles each pass; with it, they focus on what's actually changed and on finding next-frame questions.

### Recording rejected reframe candidates with reasoning

`designs/custom-lists_notes.md` preserved every rejected alternative with the reason it lost. Future agents (and future rounds of this design) didn't re-litigate. Worth doing on every substantial design.

### Side-thread stress-testing of accepted frames

Round-15's side thread (testing round-14's structure against ablations) produced round-15's improvements. Setting aside structured time to ATTACK an accepted design — not just polish it — surfaced real issues. Should be a standard step before any Etched-tier freeze.

## What didn't go well

### Implicit invariants are dangerous

"Anchors are neutral" was load-bearing existing EFS behavior that wasn't documented. Multiple agents (architects, adversarial reviewers) built wrong models around it — assuming anchor `attester` field was meaningful, then constructing elaborate attack scenarios that didn't actually work. **Cost: multiple rounds of analyzing non-attacks.**

**Lesson:** before any Etched-tier review, surface every implicit invariant the system depends on. Write them down even if they feel obvious. If you find yourself thinking "well of course X" while reading reviewer feedback, X probably needs to be documented.

### Internal synthesis can frame the problem to presuppose the answer

ADR-0043 (EFS Edge Constraint Callbacks) was drafted via three parallel internal subagents synthesizing into a "permanent Etched commitment." The framing prompts all assumed "the mechanism is needed; design it well." External reviewers (round-17, 2026-05-21) returned RED on all three passes with the same convergent finding: **the mechanism doesn't solve a v1 problem.** `allowsDuplicates=false` was already conditionally kernel-enforced by ADR-0025 name uniqueness + target-derived naming. The "forward use cases" (bounded-N TAG, append-only, PROPERTY value-type) were speculative.

The ADR shipped to external review, was deferred (not accepted), and ~$week of design work could have been avoided by a single inverted-framing internal pass: *"for each LIST use case ADR-0043 claims to enable, identify which existing EFS mechanism already handles it."*

**Lesson:** when drafting a permanent Etched commitment, the FIRST internal pass should be the inverted-framing pass — explicitly asking "is this mechanism needed?" not "design this mechanism." Only after that returns "yes, here are the gaps" should follow-on passes design the mechanism. Otherwise the framing bias compounds across subagents and the resulting design is "well-engineered, wrong problem."

This is the same shape as design-lessons L36-41 ("sub-agent verification can ask the wrong question") but at the level of *whether to do something* rather than *whether something works*.

### Sub-agent verification can ask the wrong question

The SortOverlay validation pass (round-15) asked "can SortOverlay sort entries by TAG.weight?" — answer: yes. The right question was "does SortOverlay's source set match the list's actual membership set?" — answer: no (`_children` is append-only; active membership is the TAG bucket; they diverge after revokes).

Codex and Gemini caught this in round-15 external review. The internal subagent missed it because of the narrowly-framed prompt.

**Lesson:** when sending subagents to verify "X works," also send a parallel agent to find "the case where X breaks." Subagent prompts have framing bias; counter it with adversarial framing as standard practice.

### Document drift accumulated across rounds

Each round's edits left stale references (e.g., `bool sorted` references after the field was dropped). Codex flagged specific line numbers in round-16 external review. The doc was internally inconsistent for several rounds.

**Lesson:** after any field/concept removal, grep the doc for the removed term and fix every reference in the same commit. Internal doc-consistency checks before each external review pass would catch this.

### "Advisory" wording masks real ADR-0035 mistakes

Round-15's `sorted` and round-16's `allowsDuplicates` both shipped with "(kernel enforces via ...)" claims that weren't actually true. All three external reviewers caught it.

This is the ADR-0035 shape of mistake: a confidently-stated invariant the kernel doesn't actually express. EFS has been bitten by this before; the LIST work hit it twice.

**Lesson:** at field-freeze time, write a checklist for each schema field: "Is this kernel-enforced? If yes, by what mechanism? If no, what is it — declared intent, hint, advisory? Use that vocabulary."

### Implicit frame assumptions in early rounds

Round-11 anchored on "lists are folders" — a frame that took rounds 11-12 to unwind. Round-13 then anchored on "free-floating LIST is enough" — round-14 surfaced the typed-anchor refinement. Etc.

**Lesson:** before committing to a frame, ask the human "what's the simplest mental model of this primitive?" The human's answer often reveals an implicit assumption agents missed. James's "anchors are neutral; the attester is just an artifact" was a frame question agents never asked.

### Cost asymmetry between internal and external review

Internal subagent rounds: ~30 minutes wall time, several dollars. External rounds: hours of human time + paste-and-respond overhead. We sometimes deferred to external too quickly when internal would have caught it; other times deferred to internal when external review was the actual need.

**Lesson:** internal subagents are good for "verify X" focused questions and "explore Y" research. External agents are good for "find what we're missing" open-ended scrutiny. Match the tool to the question.

## Process improvements for future Etched-tier work

1. **Schema-freeze checklist.** Before any schema UID gets registered on mainnet:
   - Every field labeled "expressed" (kernel-enforced) or "declared" (advisory/intent) per the ADR-0035 lesson
   - Every implicit invariant the schema depends on is documented somewhere
   - At least one external review pass post-freeze-candidate
   - Notes file with rejected alternatives + reasoning preserved
   - Document grep'd for removed terms; internal consistency verified

2. **"Find what breaks" subagent paired with every "verify" subagent.** When sending a subagent to confirm an approach works, send a parallel one to find when it breaks. Same prompt, inverted framing.

3. **Implicit-invariant audit before external review.** Read your own doc with fresh eyes; flag every "of course" assumption; document explicitly.

4. **Frame-history recap in the design doc.** Keep a short section listing the rounds and what each was for. The "5 frame-level refinements" pattern is itself signal; the next refinement isn't ruled out just because you can't see it.

5. **Side-thread stress-testing as a discrete step.** Between "design feels good" and "external review," set aside time to actively attack the accepted design against ablations. The round-15 side thread was the most-productive single session in the LIST work.

6. **Document the meta-process.** This file. Future EFS architectural work benefits from this list as much as the LIST design did.

## EFS-specific patterns worth remembering

### Schema UID is the only Etched coordination slot

ADR-0041's deepest argument. When tempted to encode an invariant in a schema field, ask: does this field earn a permanent globally-coordinated slot? If not, it belongs as a PROPERTY, an SDK convention, or a resolver-enforced constraint — not a schema field.

### Resolvers are the mechanism for cross-attestation invariants

Don't invent new ones (bitfield encodings, resolver chains, etc.). EFS extends EAS's resolver model with structural-constraint callbacks (the round-17 EFS-resolver mechanism). The pattern: schema's resolver maintains O(1) indices; reads kernel + EAS state at attest time; reverts on violation. Generic enough to handle any computable cross-attestation invariant.

### Editions ARE the access control

The kernel doesn't gate writes by attester at any layer. Spam-resistance happens at the viewer layer through edition-scoped reads. Concepts that imply attester-based write-gating (`coContributionPolicy`, mandatory curator-write-gate resolvers) are category errors in EFS. Frame violations of this principle as "category errors" rather than "design choices."

### Anchors are neutral

ANCHOR attestations have an `attester` field (every EAS attestation does), but EFS never uses it. Anchors are pure namespace slots — shared infrastructure. First-creator gets nothing special. This is what makes shared schelling-point names work.

### The 50-year reader test

For Etched-tier work, ask: "will a fresh agent reading this in 2076 reconstruct the intent without external context?" If no, the ADR isn't ready. Round-16's "anchors-are-neutral" surfacing was specifically to pass this test — a 2076 reader seeing the attester field would otherwise wrongly assume it meant something.
