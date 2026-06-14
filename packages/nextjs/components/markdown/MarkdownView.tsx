"use client";

import { Component, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeSanitize from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import { overviewSchema } from "~~/utils/markdown/schema";

/**
 * Render boundary for UNTRUSTED markdown. The Overview pane auto-loads README
 * content straight from EFS, and the byte cap alone doesn't bound parser work —
 * e.g. deeply nested blockquotes can blow the stack (`RangeError`) on a tiny
 * input. Without this, such content would crash the whole explorer. Caught here,
 * it degrades to a fallback line. Keyed on `source` by the caller so a new/edited
 * document re-attempts the render (Codex P2).
 */
class MarkdownRenderBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.error("Overview markdown failed to render", err);
  }
  render() {
    if (this.state.failed) {
      return (
        <p className="text-sm opacity-70">This Overview couldn’t be rendered (content too complex or malformed).</p>
      );
    }
    return this.props.children;
  }
}

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
    // Same-page hash links (e.g. the heading autolinks rehypeAutolinkHeadings
    // wraps around each heading) are safe — they navigate within the rendered
    // doc, no external load, no JS. Render them as real anchors; otherwise every
    // autolinked heading degrades to a dim, inert span, breaking in-page
    // navigation and heading readability (Gemini).
    if (href && href.startsWith("#")) {
      return <a href={href}>{children}</a>;
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
      <MarkdownRenderBoundary key={source}>
        <Markdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeSlug, [rehypeAutolinkHeadings, { behavior: "wrap" }], [rehypeSanitize, overviewSchema]]}
          components={components}
        >
          {source}
        </Markdown>
      </MarkdownRenderBoundary>
    </article>
  );
}
