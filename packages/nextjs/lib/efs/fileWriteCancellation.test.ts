import { shouldCancelLayeredFileWrite } from "./fileWriteCancellation.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("shouldCancelLayeredFileWrite ignores inactive Stop", () => {
  assert.equal(
    shouldCancelLayeredFileWrite({
      cancelled: false,
      completedLayer: 3,
      mintsFileAnchor: true,
      fileAnchorLayer: 3,
    }),
    false,
  );
});

test("shouldCancelLayeredFileWrite allows Stop before a new file anchor lands", () => {
  assert.equal(
    shouldCancelLayeredFileWrite({
      cancelled: true,
      completedLayer: 2,
      mintsFileAnchor: true,
      fileAnchorLayer: 3,
    }),
    true,
  );
});

test("shouldCancelLayeredFileWrite suppresses Stop after a new file anchor lands", () => {
  assert.equal(
    shouldCancelLayeredFileWrite({
      cancelled: true,
      completedLayer: 3,
      mintsFileAnchor: true,
      fileAnchorLayer: 3,
    }),
    false,
  );
});

test("shouldCancelLayeredFileWrite allows Stop after layer 2 for existing-anchor updates", () => {
  assert.equal(
    shouldCancelLayeredFileWrite({
      cancelled: true,
      completedLayer: 3,
      mintsFileAnchor: false,
      fileAnchorLayer: 3,
    }),
    true,
  );
});
