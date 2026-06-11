import { test } from "node:test";
import assert from "node:assert/strict";
import { selectOverview } from "./selectOverview.ts";

const c = (name: string, uid = name) => ({ uid, name });

test("finds readme.md case-insensitively", () => {
  assert.equal(selectOverview([c("notes.md"), c("ReadMe.md"), c("about.md")])?.name, "ReadMe.md");
});
test("returns the readme.md uid/name pair", () => {
  assert.deepEqual(selectOverview([c("README.md", "0xabc")]), { uid: "0xabc", name: "README.md" });
});
test("returns null when there is no readme.md (no precedence fallback)", () => {
  assert.equal(selectOverview([c("index.md"), c("overview.md"), c("notes.md")]), null);
});
test("ignores other markdown files (no markdown-ish fallback)", () => {
  assert.equal(selectOverview([c("photo.png"), c("guide.md")]), null);
});
test("returns null on empty input", () => {
  assert.equal(selectOverview([]), null);
});
