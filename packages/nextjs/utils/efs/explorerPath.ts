/**
 * explorerPath — pure URL-segment logic for the explorer's file deep links,
 * extracted from ExplorerClient so it's reachable by the `utils/**` test runner.
 *
 * A file URL (`/explorer/<folder…>/<file>`) opens the PARENT folder with the
 * file selected in the preview; the file segment is never part of the resolved
 * folder path. Selecting / closing a file (and back/forward between them) only
 * adds or drops that trailing segment, so the explorer skips the whole-path walk
 * when the folder part matches the last resolved folder.
 */

/**
 * How `next` relates to the last fully-resolved folder's URL segments:
 * - `"same"`  — same folder, no file segment (preview closed).
 * - `"child"` — same folder plus exactly one trailing segment (a file, or a subfolder).
 * - `"other"` — anything else; needs a full path resolution.
 */
export type PathChange = "same" | "child" | "other";

export function classifyPathChange(resolvedFolder: readonly string[], next: readonly string[]): PathChange {
  if (next.length < resolvedFolder.length || next.length > resolvedFolder.length + 1) return "other";
  for (let i = 0; i < resolvedFolder.length; i++) {
    if (next[i] !== resolvedFolder[i]) return "other";
  }
  return next.length === resolvedFolder.length ? "same" : "child";
}
