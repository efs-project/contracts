"use client";

import Markdown, { type Components } from "react-markdown";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeSanitize from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import { overviewSchema } from "~~/utils/markdown/schema";

const ABSOLUTE_HTTP = /^https?:\/\//i;

const components: Components = {
  a({ href, children }) {
    if (href && ABSOLUTE_HTTP.test(href)) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    }
    return <span className="opacity-70">{children}</span>;
  },
  img({ alt }) {
    return <span className="text-xs opacity-60">🖼 {alt || "image"}</span>;
  },
};

/** Untrusted-markdown renderer. Sanitize is the LAST rehype plugin. */
export function MarkdownView({ source }: { source: string }) {
  return (
    <article className="prose prose-efs max-w-none">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSlug, [rehypeAutolinkHeadings, { behavior: "wrap" }], [rehypeSanitize, overviewSchema]]}
        components={components}
      >
        {source}
      </Markdown>
    </article>
  );
}
