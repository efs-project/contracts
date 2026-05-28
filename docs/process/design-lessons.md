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

## AI-focused design process — lessons from the Lists arc (rounds 11–18d, closed 2026-05-28)

The Lists design ran 18 rounds + 3 external review cycles before freezing. It ended in a good place, but it oscillated badly in the middle. These lessons are specifically about running a *high-stakes design with AI agents as the primary labor* — they generalize to future AI-driven EFS work. Earned, not theoretical.

### Crystallize requirements with the human BEFORE exploring solutions

The single biggest unlock. Rounds 11–17 oscillated because each round discovered a new requirement and then reframed the prior round's design as "insufficient" against a goalpost that was still moving. The cure was a deliberate stop to lock **MUST / NICE / DEFERRED** with the human, explicitly, before running another design pass. Once the goalpost stopped moving, the design space collapsed to one shape within a single round.

AI agents are eager to design — they'll happily produce a beautiful solution to an under-specified problem, then produce a *different* beautiful solution next round when a new requirement surfaces. Tiered, human-ratified requirements are the anchor that makes convergence possible. Do this first.

### Diagnose oscillation vs. progress

A design is *oscillating* (not progressing) when a round produces **more** options than it received, or **reframes** the problem rather than **refining** the prior answer. Progress narrows; oscillation widens or pivots. If you can't tell, count the live options at the end of each round — if the count isn't trending down, stop and crystallize requirements. Recognizing the difference is itself a skill; AI rounds *feel* productive even when they're spinning.

### The parallel-divergent-frames convergence round

The technique that finally converged Lists: dispatch ~5 agents **in parallel, each with a different starting frame** ("defend the incumbent design", "greenfield from requirements", "design backwards from the consumer", "use existing primitives only", "find the hybrid"). Each must commit to ONE complete design. Then compare side-by-side and pick. This exploits AI parallelism while *deliberately countering single-frame bias* — no agent inherits another's frame. 4 of 5 independently landed on the same architecture, which was strong signal — but see the next lesson.

### Convergence is a stability signal, not a correctness signal

4-of-5 internal agents agreeing means the *frame is stable*, not that the design is *correct*. External review (different models, different training, different frame-blindness) still found real bugs after internal convergence — an exploitable allowlist example, missing lifecycle enforcement, a rationalization-shaped ADR section. **For Etched work, external cross-model review is non-negotiable, and convergence is never a substitute for it.** Treat internal agreement as "ready to *show* outsiders," never "done."

### The inverted-framing gate before committing to any new permanent primitive

Before adding a new schema / mechanism / abstraction, run one pass that *tries to prove you don't need it*: "implement every MUST using only existing primitives; you may add a resolver or a view, but no new permanent coordination slot." A RED verdict (here: four MUSTs genuinely couldn't be met without a new schema) is the strongest possible justification — it converts "we think we need this" into "here's specifically what fails without it." A GREEN verdict saves you from over-building. This pass, recommended in the round-17 retro, *actually ran* in round 18 and paid off. Make it standard before any Etched commitment.

### Reviewer disagreement on severity = under-specification

Two careful reviewers split on the typed-accessor issue (one "non-blocking nit," one "BLOCKING"). The disagreement itself was the signal: the accessor's contract was ambiguous (decode-helper vs. membership-proof). When sharp reviewers disagree on *how bad* something is, the underlying thing is usually under-specified — resolve the ambiguity rather than averaging the severity.

### Look for the reframe that dissolves a cluster of bugs

Several separate edge-case bugs (intrinsic-item collision, `address(0)` encoding, `targetType=ANY` equivocation) all dissolved at once under a single conceptual reframe ("the target field is a *member key*, not necessarily a target"). A cluster of related edge cases is often a symptom of a wrong frame, not N independent defects. Before patching each, ask whether one reframe kills the cluster.

### Honest deviation beats rationalization — and reviewers can smell the difference

When a design deviates from a hardened invariant (here: ADR-0041's "cardinality lives in the schema UID"), state it plainly — "this deviates, at this layer, for this bounded cost" — rather than constructing an argument that it doesn't *really* deviate. Two reviewers independently flagged the original "no supersession needed" framing as rationalization-shaped. Rewriting it as an honest, bounded deviation was both more correct and more defensible. AI prose drifts toward defending the frame it's in; rationalization is a tell reviewers catch.

### Etched layout decisions are fail-safe-directional

When uncertain about a permanent storage/encoding choice, pick the direction whose failure mode you can *recover from*. Wide-vs-lean storage: over-provisioning is wasted gas (trimmable before freeze); under-provisioning is a functional wall (block-gas-limit; un-fixable post-freeze without orphaning data). Choose "wasteful but recoverable" over "lean but possibly broken." And name the deadline: on Etched surfaces "optimize later" means "before mainnet freeze," never "after launch."

### The human's load-bearing contribution is frame-puncturing, not labor

Across this arc, the human's highest-value moves were not doing design work — they were the frame-puncturing questions: *"you make this sound good, but is logic actually enforced on-chain?"*, *"is this a problem for files and folders too?"*, *"explain it simply with examples."* Each broke the agents out of a confident-but-wrong frame. For AI-driven design, structure the process so the human is repeatedly invited to challenge the frame, and treat their "dumb-sounding" questions as the most valuable input — they're usually pointing at the unexamined assumption.

### Durable artifacts are the AI's memory; the conversation is not

This design survived at least one context compaction — the conversation was summarized and partially lost, but work resumed cleanly because the **design doc + notes file + ADR** held the state. For any long AI design process, the durable artifacts ARE the memory. Invest in them continuously (every round, not just at the end), keep a notes file that records *why* rejected paths were rejected, and never let the live conversation be the only place a decision exists.

## EFS-specific patterns worth remembering

### Schema UID is the only Etched coordination slot

ADR-0041's deepest argument. When tempted to encode an invariant in a schema field, ask: does this field earn a permanent globally-coordinated slot? If not, it belongs as a PROPERTY, an SDK convention, or a resolver-enforced constraint — not a schema field.

### Resolvers are the mechanism for cross-attestation invariants — but purpose-built, not generic

Don't invent new coordination mechanisms (bitfield encodings, resolver chains, generic constraint-callback registries). The pattern that ships: **a schema's own resolver maintains O(1) indices, reads kernel + EAS state at attest time, and reverts on violation.** ADR-0044's `ListEntryResolver` is the canonical example — it enforces typing / no-duplicates / append-only at write time for one purpose-built schema.

*Correction to the round-17 framing:* an earlier draft of this note described a **generic** structural-constraint-callback mechanism (ADR-0043) as the answer. That mechanism was **deferred/rejected** by three external reviewers as the wrong abstraction — it solved a non-problem inside a frame that presupposed it was needed. The lesson stuck the right way around: when you need to enforce a cross-attestation invariant, give that specific predicate its own schema + resolver (the ADR-0041 / ADR-0044 shape), rather than building a general-purpose callback substrate for hypothetical future invariants.

### Editions ARE the access control

The kernel doesn't gate writes by attester at any layer. Spam-resistance happens at the viewer layer through edition-scoped reads. Concepts that imply attester-based write-gating (`coContributionPolicy`, mandatory curator-write-gate resolvers) are category errors in EFS. Frame violations of this principle as "category errors" rather than "design choices."

### Anchors are neutral

ANCHOR attestations have an `attester` field (every EAS attestation does), but EFS never uses it. Anchors are pure namespace slots — shared infrastructure. First-creator gets nothing special. This is what makes shared schelling-point names work.

### The 50-year reader test

For Etched-tier work, ask: "will a fresh agent reading this in 2076 reconstruct the intent without external context?" If no, the ADR isn't ready. Round-16's "anchors-are-neutral" surfacing was specifically to pass this test — a 2076 reader seeing the attester field would otherwise wrongly assume it meant something.
