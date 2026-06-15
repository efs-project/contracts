import { CLOBBER_PREFIX, overviewSchema, resolveHashHref } from "./schema.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeSanitize from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

async function render(md: string): Promise<string> {
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeSlug)
    .use(rehypeSanitize, overviewSchema)
    .use(rehypeStringify)
    .process(md);
  return String(file);
}

async function renderWithAnchors(md: string): Promise<string> {
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeSlug)
    .use(rehypeAutolinkHeadings, { behavior: "wrap" })
    .use(rehypeSanitize, overviewSchema)
    .use(rehypeStringify)
    .process(md);
  return String(file);
}

test("strips javascript: and data: links (href removed entirely)", async () => {
  const html = await render("[a](javascript:alert(1)) [b](data:text/html,x)");
  assert.doesNotMatch(html, /href=/);
  assert.match(html, /<a>a<\/a>/);
});
test("strips raw script / onerror / iframe / svg", async () => {
  const html = await render("<script>x</script><img src=x onerror=alert(1)><iframe></iframe><svg onload=alert(1)>");
  assert.doesNotMatch(html, /<script|onerror|<iframe|onload/i);
});
test("removes img entirely (no external image loads in v1)", async () => {
  assert.doesNotMatch(await render("![x](https://evil.example/p.png)"), /<img/);
});
test("renders GFM tables", async () => {
  assert.match(await render("| a | b |\n|---|---|\n| 1 | 2 |"), /<table/);
});
test("renders footnotes", async () => {
  assert.match(await render("Text.[^1]\n\n[^1]: note"), /footnote/i);
});
test("heading gets a clobber-prefixed id", async () => {
  assert.match(await render("## Hello World"), /id="user-content-hello-world"/);
});
test("DOM-clobber: heading 'constructor' is prefixed", async () => {
  assert.match(await render("## constructor"), /id="user-content-constructor"/);
});
test("keeps http/https/mailto links", async () => {
  const html = await render("[a](https://example.com) [m](mailto:x@y.z)");
  assert.match(html, /href="https:\/\/example\.com"/);
  assert.match(html, /href="mailto:x@y\.z"/);
});

test("strips mixed-case and obfuscated script protocols", async () => {
  const html = await render("[a](JavaScript:alert(1)) [b]( javascript:alert(1)) [c](vbscript:msgbox(1))");
  assert.doesNotMatch(html, /href=/i);
});
test("strips style, base, and form/formaction", async () => {
  const html = await render(
    '<style>body{display:none}</style><base href="//evil.example/"><form><input formaction="javascript:alert(1)"></form>',
  );
  assert.doesNotMatch(html, /<style|<base|formaction|<form|<input/i);
});
test("documents protocol-relative href behavior (passes sanitize; renderer makes it inert)", async () => {
  // The sanitize schema does NOT strip //host hrefs (no scheme to filter). The
  // React <a> override in MarkdownView renders non-http(s):// links inert, which
  // is where protocol-relative links are neutralized. This test pins the schema
  // behavior so a future change is noticed.
  const html = await render("[x](//evil.example/path)");
  assert.match(html, /href="\/\/evil\.example\/path"/);
});
test("renders task-list checkbox and disabled", async () => {
  const html = await render("- [x] done\n- [ ] todo");
  assert.match(html, /type="checkbox"/);
  assert.match(html, /disabled/);
});
test("renders table cell alignment", async () => {
  const html = await render("| a | b |\n|:--|--:|\n| 1 | 2 |");
  assert.match(html, /align|text-align|style=/i);
});

test("autolink heading wrap-anchor (href=#fragment) survives sanitize", async () => {
  const html = await renderWithAnchors("## Hello World");
  assert.match(html, /<h2[^>]*id="user-content-hello-world"[^>]*>/);
  // Raw pipeline href is the UNprefixed fragment — it does NOT match the
  // clobber-prefixed id above. MarkdownView's <a> override repairs this at
  // render time via resolveHashHref (see below), exactly as the protocol-
  // relative test documents the override neutralizing //host links.
  assert.match(html, /href="#hello-world"/);
});
test("resolveHashHref re-points a raw heading fragment at its prefixed id", async () => {
  const html = await renderWithAnchors("## Hello World");
  const id = html.match(/<h2[^>]*id="([^"]+)"/)?.[1];
  const rawHref = html.match(/href="(#[^"]+)"/)?.[1];
  assert.ok(id && rawHref, "expected both an id and an autolink href");
  // The gap the bug was about: raw href != "#" + id ...
  assert.notEqual(rawHref, `#${id}`);
  // ... and the override closes it.
  assert.equal(resolveHashHref(rawHref as string), `#${id}`);
});
test("resolveHashHref is idempotent and leaves a bare '#' alone", () => {
  assert.equal(resolveHashHref("#hello-world"), `#${CLOBBER_PREFIX}hello-world`);
  assert.equal(resolveHashHref(`#${CLOBBER_PREFIX}hello-world`), `#${CLOBBER_PREFIX}hello-world`);
  assert.equal(resolveHashHref("#"), "#");
});
