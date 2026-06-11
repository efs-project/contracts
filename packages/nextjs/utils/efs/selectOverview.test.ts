import { test } from "node:test";
import assert from "node:assert/strict";
import { selectOverview } from "./selectOverview.ts";

const c = (name: string, uid = name) => ({ uid, name });

test("prefers README.md (case-insensitive) over others", () => {
  const picked = selectOverview([c("about.md"), c("ReadMe.md"), c("index.md")]);
  assert.equal(picked?.name, "ReadMe.md");
});
test("falls through precedence: index before overview before about", () => {
  assert.equal(selectOverview([c("about.md"), c("overview.md"), c("index.md")])?.name, "index.md");
});
test("falls back to first markdown-ish name when no precedence match", () => {
  assert.equal(selectOverview([c("photo.png"), c("notes.md"), c("data.csv")])?.name, "notes.md");
});
test("returns null when no markdown-ish candidate", () => {
  assert.equal(selectOverview([c("photo.png"), c("data.csv")]), null);
});
test("returns null on empty input", () => {
  assert.equal(selectOverview([]), null);
});
