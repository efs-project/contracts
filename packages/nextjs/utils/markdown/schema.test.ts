import { test } from "node:test";
import assert from "node:assert/strict";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSlug from "rehype-slug";
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

test("strips javascript: and data: links", async () => {
  assert.doesNotMatch(await render("[a](javascript:alert(1)) [b](data:text/html,x)"), /javascript:|data:text/i);
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
