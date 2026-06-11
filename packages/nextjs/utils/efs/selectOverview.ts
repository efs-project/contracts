export interface OverviewCandidate {
  uid: string;
  name: string;
}

/**
 * The one canonical Overview filename. Anchor names are CASE-SENSITIVE on-chain
 * (`README.md`, `readme.md`, and `ReadMe.md` are distinct anchors), so we match
 * this exactly — case-folding would conflate distinct anchors and be ambiguous
 * when several casings coexist.
 */
export const OVERVIEW_NAME = "README.md";

/**
 * Pick the Overview file among ONE lens's system-tagged children: the child named
 * exactly `README.md`, else null. The hook calls this per lens in order
 * (first-lens-wins): the first lens with a `README.md` provides the page; none →
 * no pane. The `system` tag is a separate concern (it hides the file from the
 * list); selection here is purely by exact name.
 */
export function selectOverview(candidates: OverviewCandidate[]): OverviewCandidate | null {
  return candidates.find(c => c.name === OVERVIEW_NAME) ?? null;
}
