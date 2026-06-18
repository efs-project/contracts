import {
  computeExcludesPending,
  reconcileMinWeights,
  shouldUseFilteredQuery,
  tagsRootGateDecision,
} from "./excludeFilter.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

const DEF_A = "0xaaaa000000000000000000000000000000000000000000000000000000000000";
const DEF_B = "0xbbbb000000000000000000000000000000000000000000000000000000000000";

// ── shouldUseFilteredQuery — the load-bearing "never read unfiltered when
//    excludes are active" invariant (ADR-0054). ───────────────────────────────
test("shouldUseFilteredQuery: empty excludes → unfiltered call is allowed", () => {
  assert.equal(shouldUseFilteredQuery([]), false);
});

test("shouldUseFilteredQuery: any active exclude → MUST use the filtered call", () => {
  assert.equal(shouldUseFilteredQuery([DEF_A]), true);
  assert.equal(shouldUseFilteredQuery([DEF_A, DEF_B]), true);
});

// ── reconcileMinWeights — must always return a parallel-length vector so the
//    on-chain `require(minWeights.length == excludeTagDefs.length)` can't fire. ─
test("reconcileMinWeights: matching length is passed through by value", () => {
  assert.deepEqual(reconcileMinWeights([DEF_A, DEF_B], [5n, 0n]), [5n, 0n]);
});

test("reconcileMinWeights: omitted minWeights → all-zero vector of correct length", () => {
  assert.deepEqual(reconcileMinWeights([DEF_A, DEF_B], []), [0n, 0n]);
});

test("reconcileMinWeights: length mismatch → all-zero vector (never a revert)", () => {
  assert.deepEqual(reconcileMinWeights([DEF_A, DEF_B], [5n]), [0n, 0n]);
  assert.deepEqual(reconcileMinWeights([DEF_A], [5n, 9n, 1n]), [0n]);
});

test("reconcileMinWeights: empty excludes → empty vector", () => {
  assert.deepEqual(reconcileMinWeights([], []), []);
  assert.deepEqual(reconcileMinWeights([], [5n]), []);
});

test("reconcileMinWeights: output length always equals excludeTagDefs length", () => {
  for (const defs of [[], [DEF_A], [DEF_A, DEF_B]]) {
    for (const mw of [[], [0n], [1n, 2n], [1n, 2n, 3n]]) {
      assert.equal(reconcileMinWeights(defs, mw).length, defs.length);
    }
  }
});

// ── computeExcludesPending — the fetch gate. Holds while excludes are requested
//    but unresolved; never deadlocks the empty-excludes case. ─────────────────
test("computeExcludesPending: active excludes, not yet resolved → HOLD", () => {
  assert.equal(computeExcludesPending("nsfw,system", false), true);
});

test("computeExcludesPending: active excludes, resolved → release", () => {
  assert.equal(computeExcludesPending("nsfw,system", true), false);
});

test("computeExcludesPending: no active excludes → never pending (no deadlock)", () => {
  assert.equal(computeExcludesPending("", false), false);
  assert.equal(computeExcludesPending("", true), false);
});

// ── tagsRootGateDecision — when /tags isn't available, release only once it has
//    definitively settled-absent; otherwise hold (leak-safe). ─────────────────
test("tagsRootGateDecision: settled-absent → release with empty defs", () => {
  assert.equal(tagsRootGateDecision(true), "release-empty");
});

test("tagsRootGateDecision: still loading / unsettled → hold (never unfiltered)", () => {
  assert.equal(tagsRootGateDecision(false), "hold");
});
