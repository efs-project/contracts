import { test } from "node:test";
import assert from "node:assert/strict";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import { overviewSchema } from "./schema.ts";

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
  const html = await render('<script>x</script><img src=x onerror=alert(1)><iframe></iframe><svg onload=alert(1)>');
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
  const html = await render('<style>body{display:none}</style><base href="//evil.example/"><form><input formaction="javascript:alert(1)"></form>');
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
  assert.match(html, /href="#hello-world"/);
});
