import { classifyPathChange } from "./explorerPath.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("classifyPathChange: identical segments → same (preview closed)", () => {
  assert.equal(classifyPathChange(["whitepapers"], ["whitepapers"]), "same");
  assert.equal(classifyPathChange([], []), "same");
});

test("classifyPathChange: one trailing segment → child (file select / subfolder)", () => {
  assert.equal(classifyPathChange(["whitepapers"], ["whitepapers", "bitcoin.pdf"]), "child");
  // Root folder: a root-level file is a one-segment URL.
  assert.equal(classifyPathChange([], ["readme.txt"]), "child");
});

test("classifyPathChange: deeper, shallower or diverging paths → other", () => {
  assert.equal(classifyPathChange(["a"], ["a", "b", "c"]), "other");
  assert.equal(classifyPathChange(["a", "b"], ["a"]), "other");
  assert.equal(classifyPathChange(["a"], ["b"]), "other");
  assert.equal(classifyPathChange(["a"], ["b", "c"]), "other");
});

test("classifyPathChange: segments compare exactly (names are case-sensitive)", () => {
  assert.equal(classifyPathChange(["Docs"], ["docs", "x"]), "other");
});
