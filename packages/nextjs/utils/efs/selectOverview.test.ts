import { test } from "node:test";
import assert from "node:assert/strict";
import { selectOverview } from "./selectOverview.ts";

const c = (name: string, uid = name) => ({ uid, name });

test("matches README.md exactly", () => {
  assert.deepEqual(selectOverview([c("notes.md"), c("README.md", "0xabc")]), { uid: "0xabc", name: "README.md" });
});
test("does NOT match other casings (anchor names are case-sensitive on-chain)", () => {
  assert.equal(selectOverview([c("readme.md"), c("ReadMe.md"), c("Readme.MD")]), null);
});
test("returns null when there is no README.md", () => {
  assert.equal(selectOverview([c("index.md"), c("guide.md")]), null);
});
test("returns null on empty input", () => {
  assert.equal(selectOverview([]), null);
});
