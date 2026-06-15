/**
 * excludeFilter — pure decision logic for the ADR-0054 on-chain tag-exclusion
 * filter, extracted from the explorer wiring so the SAFETY-CRITICAL invariants
 * are unit-testable. The React hooks/effects that consume these (FileBrowser,
 * useLensesDirectoryPage) aren't reachable by the `utils/**` test runner, and
 * three real leaks slipped past review in exactly this logic — so the decisions
 * live here, behind tests, and the call sites just invoke them.
 *
 * Behavior MUST mirror the call sites exactly; these are straight extractions.
 */

/**
 * Whether the lens directory read must use the FILTERED on-chain call
 * (`getDirectoryPageFiltered`) rather than the unfiltered
 * `getDirectoryPageBySchemaAndAddressList`.
 *
 * SAFETY INVARIANT: whenever exclude tags are active, the read must be filtered —
 * the unfiltered call is only ever legal when there is nothing to exclude.
 * Consumed by BOTH the file/folder query and the LIST query (a missing call here
 * is how the LIST-query leak happened — Codex P2-a).
 */
export function shouldUseFilteredQuery(excludeTagDefs: readonly string[]): boolean {
  return excludeTagDefs.length > 0;
}

/**
 * Parallel-array `minWeights` for `getDirectoryPageFiltered`. The contract
 * requires `minWeights.length === excludeTagDefs.length`; a caller that omits
 * `minWeights` or passes a length-mismatched array would otherwise trigger an
 * on-chain `require` revert. Derive an all-zero vector (ADR-0042 `weight >= 0`)
 * whenever the lengths don't already match; otherwise pass the caller's array
 * through unchanged.
 */
export function reconcileMinWeights(excludeTagDefs: readonly string[], minWeights: readonly bigint[]): bigint[] {
  return minWeights.length === excludeTagDefs.length ? [...minWeights] : excludeTagDefs.map(() => 0n);
}

/**
 * Whether the lens directory fetch must be HELD because exclude tags are
 * requested but their definition UIDs haven't resolved yet. While true, the
 * directory hooks are disabled so the first fetch can't run the unfiltered branch
 * and briefly leak system/nsfw before the def UIDs land.
 *
 * The empty-excludes case (`drawerExcludeNamesKey === ""`) is NEVER pending — so
 * a directory with no active excludes never deadlocks waiting on a resolution
 * that won't run.
 */
export function computeExcludesPending(drawerExcludeNamesKey: string, excludeResolved: boolean): boolean {
  return drawerExcludeNamesKey !== "" && !excludeResolved;
}

/**
 * Decision for the exclude-resolution effect when the `/tags` root isn't
 * available (`tagsRoot` is null):
 * - `"release-empty"` — `/tags` resolution has SETTLED with no anchor, so no def
 *   UIDs exist and nothing is taggable; release the gate with empty defs (the
 *   listing is correct and shows content). Safe because an item can only be
 *   system/nsfw-tagged if its def anchor exists under `/tags/`.
 * - `"hold"` — `/tags` is still loading (or a hard RPC error left it unsettled);
 *   keep holding so we never drop to an unfiltered read (leak-safe).
 */
export function tagsRootGateDecision(tagsRootSettled: boolean): "release-empty" | "hold" {
  return tagsRootSettled ? "release-empty" : "hold";
}
