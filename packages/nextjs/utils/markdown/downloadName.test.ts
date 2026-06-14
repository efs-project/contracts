import { safeDownloadName } from "./downloadName.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("keeps a normal filename", () => {
  assert.equal(safeDownloadName("report.pdf"), "report.pdf");
});
test("strips RTL-override disguise", () => {
  assert.doesNotMatch(safeDownloadName("invoice‮gpj.exe"), /[‪-‮]/);
});
test("strips path separators", () => {
  const out = safeDownloadName("../../etc/passwd");
  assert.doesNotMatch(out, /[\\\/]/);
});
test("strips control chars but keeps hyphens", () => {
  const out = safeDownloadName("a-b·c.txt");
  assert.doesNotMatch(out, /[\u0080-\uffff]/);
  assert.equal(out, "a-b_c.txt");
});
test("preserves hyphens in a normal versioned filename", () => {
  assert.equal(safeDownloadName("v1.0.0-beta.tar.gz"), "v1.0.0-beta.tar.gz");
});
test("clamps length", () => {
  assert.ok(safeDownloadName("x".repeat(500) + ".bin").length <= 80);
});
test("falls back when nothing usable remains", () => {
  assert.equal(safeDownloadName("‮​"), "download.bin");
});
test("strips leading dots and underscores (hidden-file / traversal guard)", () => {
  assert.equal(safeDownloadName(".foo"), "foo");
  assert.equal(safeDownloadName("_bar"), "bar");
  assert.equal(safeDownloadName("...hidden.txt"), "hidden.txt");
});
test("all-dot/underscore and empty inputs fall back to the neutral name", () => {
  assert.equal(safeDownloadName("..._."), "download.bin");
  assert.equal(safeDownloadName("..."), "download.bin");
  assert.equal(safeDownloadName(""), "download.bin");
});
