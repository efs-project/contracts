export interface OverviewCandidate {
  uid: string;
  name: string;
}

/**
 * Pick the Overview file among ONE lens's system-tagged children: the file named
 * `readme.md` (case-insensitive), else null. The hook calls this per lens in
 * order (first-lens-wins): the first lens with a `readme.md` provides the page;
 * if no lens has one, no Overview pane renders. The `system` tag is a separate
 * concern (it hides the file from the list); selection here is purely by name.
 */
export function selectOverview(candidates: OverviewCandidate[]): OverviewCandidate | null {
  return candidates.find(c => c.name.toLowerCase() === "readme.md") ?? null;
}
