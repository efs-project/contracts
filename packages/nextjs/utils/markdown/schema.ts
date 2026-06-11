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
