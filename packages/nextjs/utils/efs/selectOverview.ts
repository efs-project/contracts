export interface OverviewCandidate {
  uid: string;
  name: string;
}

const PRECEDENCE = ["readme.md", "index.md", "overview.md", "about.md"];
const MARKDOWNISH = /\.(md|markdown|txt)$/i;

/**
 * Pick the Overview file among ONE lens's system-tagged children. Order:
 * filename precedence (case-insensitive) → first markdown-ish name → null.
 * The hook calls this per lens in order (first-lens-wins): the first lens that
 * yields a non-null result provides the page.
 */
export function selectOverview(candidates: OverviewCandidate[]): OverviewCandidate | null {
  for (const want of PRECEDENCE) {
    const hit = candidates.find(c => c.name.toLowerCase() === want);
    if (hit) return hit;
  }
  return candidates.find(c => MARKDOWNISH.test(c.name)) ?? null;
}
