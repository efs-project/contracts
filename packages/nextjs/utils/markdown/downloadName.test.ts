import { test } from "node:test";
import assert from "node:assert/strict";
import { safeDownloadName } from "./downloadName.ts";

test("keeps a normal filename", () => {
  assert.equal(safeDownloadName("report.pdf"), "report.pdf");
});
test("strips RTL-override disguise", () => {
  assert.doesNotMatch(safeDownloadName("invoice‮gpj.exe"), /[‪-‮]/);
});
test("strips path separators", () => {
  const out = safeDownloadName("../../etc/passwd");
  assert.doesNotMatch(out, /[\\/]/);
});
test("strips control chars", () => {
  assert.doesNotMatch(safeDownloadName("abc.txt"), /[ -]/);
});
test("clamps length", () => {
  assert.ok(safeDownloadName("x".repeat(500) + ".bin").length <= 80);
});
test("falls back when nothing usable remains", () => {
  assert.equal(safeDownloadName("‮​"), "download.bin");
});
