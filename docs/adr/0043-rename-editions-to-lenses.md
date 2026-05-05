# ADR-0043: Rename "editions" to "lenses"

**Status:** Accepted
**Date:** 2026-05-05
**Related:** ADR-0013, ADR-0014, ADR-0026, ADR-0031, ADR-0039

## Context

EFS's multi-attester resolution feature was originally named "editions"
by analogy to book editions and director's-cut movie editions. Pre-launch
user feedback surfaced that the metaphor under-sells the feature: book
editions imply a single underlying work with cosmetic variation, while
EFS attesters can place wholly different content at the same path. The
feature also cascades for properties / configs (multiple attesters
compose a final config), which "edition" (a frozen artifact) does not
naturally express.

## Decision

The feature name becomes **lenses** (plural for the list / feature noun)
and **lens** (singular for one trusted attester). The URL query parameter
becomes `?lenses=alice.eth,bob.eth`. Code identifiers, spec prose,
documentation, tests, and the debug UI all use the new name. No
backwards-compatibility aliases are kept.

The metaphor: telescopes, microscopes, and cameras combine multiple
physical lenses into one image. EFS combines multiple trusted attesters
into one view of the namespace.

This ADR does NOT supersede ADR-0013, ADR-0014, ADR-0026, ADR-0031, or
ADR-0039. Their substantive decisions (URL-param-with-first-wins
fallback, lens-scoped mirror/property selection, `MAX_LENSES = 20` cap,
default lenses priority chain) all stand. Only the term changes.

### Policy exception: in-place rename of accepted ADRs

`docs/adr/README.md` declares that accepted ADRs are immutable except
through supersession. That rule exists to protect *decision integrity*
— the substance of past choices. A pure terminology refresh is not a
decision revision: every Decision, Consequences, and Alternatives
section keeps its argument, only the noun used to describe the same
concept changes.

Per project lead's direction (2026-05-05), this rename is therefore
applied in place across all 19 accepted ADRs that contain the old term,
and the 5 ADR filenames containing "edition" are renamed to use "lens."
The 5 cross-links in `docs/adr/README.md` are updated accordingly. No
other inter-ADR references break (all use the `ADR-NNNN` text style).

This is a one-time exception, not a general loosening of the rule.
Future agents should still treat accepted ADRs as immutable except for
similar one-time terminology refreshes explicitly directed by the
project lead.

## Consequences

- Mechanical rename across code, specs, top-level docs, tests, scripts,
  the debug UI, and the ADR index. 73 files (excluding the 19 immutable
  accepted ADRs).
- One file rename: `useEditionDirectoryPage.ts` → `useLensesDirectoryPage.ts`.
- One new constant name: `MAX_EDITIONS` → `MAX_LENSES`.
- No schema UID changes — schema field strings do not contain the term.
- No backwards-compatible URL aliases. Pre-launch break is acceptable.
- Glossary entry added to `specs/overview.md` for future readers
  encountering the old term in accepted ADRs.

## Alternatives considered

- **Sources** — most honest plain-English word; user reaches for it
  unconsciously when explaining the model. Rejected for being too
  generic to brand for a foundational protocol with a 50-100 year
  horizon.
- **Layers** — explicit composition imagery. Rejected for slight
  Photoshop-coding and weaker cultural texture than Lenses.
- **Views** — passive register; doesn't carry the trust-list concept.
- **Editions** (status quo) — dignified but implies a frozen artifact;
  cascade behavior fights the metaphor.
- **Voices, Takes, Channels** — weaker cascade fit (see brainstorming
  history).

The two-noun system (View + Sources, per Codex's framing) was
considered and rejected in favor of single-noun simplicity. "Sources"
remains in the canonical definition as a casual descriptive synonym:
*Your lenses are the ordered list of trusted sources EFS uses to
resolve the namespace.*
