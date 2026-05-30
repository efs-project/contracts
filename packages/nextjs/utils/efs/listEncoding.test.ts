import { MAX_ITEM_BYTES, RANK_STEP, addrFromKey, byteLen, computeInsertWeight, packText, shortHex, unpackText } from "./listEncoding.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

// Run with:  yarn workspace @se-2/nextjs test
//   (root)   yarn node --test packages/nextjs/utils/efs/listEncoding.test.ts

// ── packText / unpackText round-trip ────────────────────────────────────────

test("packText → unpackText round-trips plain ASCII", () => {
  for (const s of ["Milk", "buy eggs", "pay rent", "a", "x".repeat(MAX_ITEM_BYTES)]) {
    assert.equal(unpackText(packText(s)), s, `round-trip failed for "${s}"`);
  }
});

test("packText → unpackText round-trips multibyte UTF-8 (emoji, accents, CJK)", () => {
  for (const s of ["café", "Bread ✓", "naïve", "日本語", "🎉", "a✓b"]) {
    // only assert for inputs that fit in 31 bytes
    if (byteLen(s) <= MAX_ITEM_BYTES) {
      assert.equal(unpackText(packText(s)), s, `round-trip failed for "${s}" (${byteLen(s)} bytes)`);
    }
  }
});

test("packText produces a nonzero bytes32 for any nonempty input (resolver requires target != 0)", () => {
  for (const s of ["a", "Milk", "🎉"]) {
    const packed = packText(s);
    assert.match(packed, /^0x[0-9a-f]{64}$/);
    assert.notEqual(packed, "0x" + "0".repeat(64));
  }
});

test("packText rejects empty string (would pack to bytes32(0), which the resolver rejects)", () => {
  assert.throws(() => packText(""), /empty/i);
});

test("packText rejects > 31 bytes; accepts exactly 31", () => {
  assert.doesNotThrow(() => packText("x".repeat(31))); // 31 ASCII bytes
  assert.throws(() => packText("x".repeat(32)), /too long/i);
  // multibyte: 8 CJK chars = 24 bytes ok; 11 = 33 bytes rejected
  assert.doesNotThrow(() => packText("語".repeat(8)));
  assert.throws(() => packText("語".repeat(11)), /too long/i);
});

test("byteLen counts UTF-8 bytes, not code points", () => {
  assert.equal(byteLen("abc"), 3);
  assert.equal(byteLen("café"), 5); // é is 2 bytes
  assert.equal(byteLen("✓"), 3);
  assert.equal(byteLen("🎉"), 4);
});

// ── unpackText rejection of non-text (legacy / opaque keys) ──────────────────

test("unpackText returns null for an opaque keccak-style key (high/control bytes)", () => {
  // a realistic keccak256 output — almost certainly contains control bytes / invalid UTF-8
  const keccakish = "0x" + "a3f1c09b7e4d2856ff01b9c3aa55de77019283746556afcb0011223344556677";
  // Not asserting a fixed result for every random hex, but this one decodes to non-text:
  assert.equal(unpackText(keccakish), null);
});

test("unpackText returns null for all-zero key", () => {
  assert.equal(unpackText("0x" + "0".repeat(64)), null);
});

test("unpackText rejects strings containing control characters", () => {
  // pack 'AB' then manually splice a 0x01 control byte in the middle
  const withCtrl = "0x4101420000000000000000000000000000000000000000000000000000000000"; // 'A' 0x01 'B'
  assert.equal(unpackText(withCtrl), null);
});

test("unpackText preserves tab/newline (allowed whitespace)", () => {
  assert.equal(unpackText(packText("a\tb")), "a\tb");
  assert.equal(unpackText(packText("a\nb")), "a\nb");
});

// ── addrFromKey ──────────────────────────────────────────────────────────────

test("addrFromKey extracts and EIP-55 checksums the low 20 bytes", () => {
  // resolver stores bytes32(uint256(uint160(addr))) — left-padded with zeros
  const addr = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
  const key = "0x000000000000000000000000" + addr.slice(2);
  const out = addrFromKey(key);
  assert.equal(out.toLowerCase(), addr);
  // checksummed form has mixed case
  assert.equal(out, "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
});

test("addrFromKey handles the zero address", () => {
  const key = "0x" + "0".repeat(64);
  assert.equal(addrFromKey(key), "0x0000000000000000000000000000000000000000");
});

// ── shortHex ─────────────────────────────────────────────────────────────────

test("shortHex abbreviates long hex", () => {
  assert.equal(shortHex("0xd8da6bf26964af9d7eed9e03e53415d37aa96045"), "0xd8da…6045");
});

// ── computeInsertWeight (reorder math — the bug-prone part) ──────────────────

test("insert at the very top assigns a weight below the first item", () => {
  const r = computeInsertWeight(undefined, 1000n);
  assert.deepEqual(r, { weight: 1000n - RANK_STEP });
  if ("weight" in r) assert.ok(r.weight < 1000n);
});

test("insert at the very bottom assigns a weight above the last item", () => {
  const r = computeInsertWeight(5000n, undefined);
  assert.deepEqual(r, { weight: 5000n + RANK_STEP });
  if ("weight" in r) assert.ok(r.weight > 5000n);
});

test("insert in the middle uses the strict midpoint", () => {
  const r = computeInsertWeight(0n, RANK_STEP * 2n);
  assert.ok("weight" in r);
  if ("weight" in r) {
    assert.equal(r.weight, RANK_STEP);
    assert.ok(r.weight > 0n && r.weight < RANK_STEP * 2n);
  }
});

test("single-item list: dropping with no neighbours never happens, but edges are safe", () => {
  // moving the only item to where it is = no-op handled by caller; here just verify
  // both-undefined degenerates predictably (treated as 'top': -step)
  const r = computeInsertWeight(undefined, undefined);
  assert.deepEqual(r, { weight: 0n - RANK_STEP });
});

test("collision: adjacent integer weights leave no room → { collision: true } (BEFORE any revoke)", () => {
  assert.deepEqual(computeInsertWeight(3n, 4n), { collision: true });
  assert.deepEqual(computeInsertWeight(0n, 1n), { collision: true });
  assert.deepEqual(computeInsertWeight(-1n, 0n), { collision: true });
});

test("collision: equal neighbour weights leave no room", () => {
  assert.deepEqual(computeInsertWeight(100n, 100n), { collision: true });
});

test("no collision when there is at least 2 of integer gap", () => {
  const r = computeInsertWeight(10n, 12n);
  assert.deepEqual(r, { weight: 11n });
});

test("negative weights (after repeated top-drops) still compute correctly", () => {
  const r = computeInsertWeight(undefined, -5n * RANK_STEP);
  assert.ok("weight" in r);
  if ("weight" in r) assert.ok(r.weight < -5n * RANK_STEP);
});

test("with the real 1e15 step, a fresh midpoint has enormous room (no collision for many reorders)", () => {
  // simulate inserting repeatedly into the same gap; should take ~50 inserts to exhaust
  let left = 0n;
  let right = RANK_STEP; // 1e15
  let inserts = 0;
  for (; inserts < 60; inserts++) {
    const r = computeInsertWeight(left, right);
    if ("collision" in r) break;
    right = r.weight; // keep inserting just below the previous midpoint
  }
  assert.ok(inserts >= 49, `expected >= 49 subdivisions before collision, got ${inserts}`);
});
