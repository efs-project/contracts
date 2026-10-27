import { defaultSchema } from "rehype-sanitize";

/**
 * Sanitization schema for untrusted Overview markdown. Built on the GitHub
 * default (already safe-by-default): no script/iframe/svg/style/on*, and
 * clobberPrefix='user-content-' + clobber (id/name/aria*) defends against DOM clobbering.
 * We tighten it further:
 *  - <img> removed entirely (no network image loads in v1; the React <img>
 *    override also renders a placeholder — defense in depth).
 *  - link protocols limited to http/https/mailto (drops irc/ircs/xmpp).
 * NOTE: rehype-sanitize MUST be the LAST rehype plugin in the pipeline.
 */
export const overviewSchema = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter(t => t !== "img"),
  protocols: {
    ...defaultSchema.protocols,
    href: ["http", "https", "mailto"],
  },
  attributes: {
    ...defaultSchema.attributes,
    th: [...(defaultSchema.attributes?.th ?? []), "align"],
    td: [...(defaultSchema.attributes?.td ?? []), "align"],
  },
};

/** The id/name prefix rehype-sanitize applies as DOM-clobber defense. */
export const CLOBBER_PREFIX = defaultSchema.clobberPrefix ?? "user-content-";

/**
 * {@link overviewSchema} with its own id prefix, for a document rendered on the
 * same page as another one (the explorer preview beside the Overview). Without
 * it, "# Introduction" in both docs yields two `user-content-introduction` ids
 * and the preview's heading links scroll to the Overview's copy.
 */
export function markdownSchema(idPrefix: string = CLOBBER_PREFIX) {
  return idPrefix === CLOBBER_PREFIX ? overviewSchema : { ...overviewSchema, clobberPrefix: idPrefix };
}

/**
 * Re-point a same-page href fragment at its clobber-prefixed element id.
 *
 * rehype-sanitize prefixes heading ids with {@link CLOBBER_PREFIX} but leaves
 * `href` fragments untouched, so the autolink `rehypeAutolinkHeadings` wraps
 * around a heading ("#hello-world") points at the now-"user-content-hello-world"
 * id and scrolls nowhere. Applied in MarkdownView's `<a>` override, this fixes
 * both heading autolinks and author-written `[x](#section)` links. Idempotent;
 * leaves a bare "#" alone. Pass the document's `idPrefix` when it was rendered
 * with {@link markdownSchema}. (Codex P2)
 */
export function resolveHashHref(href: string, idPrefix: string = CLOBBER_PREFIX): string {
  const fragment = href.slice(1); // drop leading '#'
  if (!fragment || fragment.startsWith(idPrefix)) return href;
  return `#${idPrefix}${fragment}`;
}
