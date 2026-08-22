import { type ClassifiedContainer, EFS_CONTENT_LENS, defaultLensesForContainer } from "./containers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

// The ADR-0048 system/nsfw hide guarantee is load-bearing on the DEFAULT lens
// list being non-empty: an empty `lensAddresses` disables the directory hooks
// and renders an empty grid (fail-safe), while a non-empty list routes every
// read through the lens-scoped `getDirectoryPageFiltered`. These tests pin that
// `defaultLensesForContainer` never returns empty on the non-explicit path when
// `systemLenses` is populated (the production reality), and that the explicit
// override semantics (ADR-0031) are preserved.

const SYSTEM_ACCOUNT = "0x4444444444444444444444444444444444444444";
const SYSTEM_LENSES = [EFS_CONTENT_LENS, SYSTEM_ACCOUNT];
const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const VIEWED_ADDRESS = "0x1111111111111111111111111111111111111111";
const TRUSTED_ADDRESS = "0x2222222222222222222222222222222222222222";

const hex = (s: string) => s as `0x${string}`;
const CONTAINERS: Record<string, ClassifiedContainer> = {
  anchor: { kind: "anchor", uid: hex("0x" + "00".repeat(32)), displayName: "docs", rawSegment: "docs" },
  address: {
    kind: "address",
    uid: hex("0x" + "00".repeat(12) + "1111111111111111111111111111111111111111"),
    address: hex(VIEWED_ADDRESS),
    displayName: "alice",
    rawSegment: VIEWED_ADDRESS,
  },
  schema: { kind: "schema", uid: hex("0x" + "11".repeat(32)), displayName: "schema", rawSegment: "0x11" },
  attestation: { kind: "attestation", uid: hex("0x" + "22".repeat(32)), displayName: "att", rawSegment: "0x22" },
};

for (const [kind, container] of Object.entries(CONTAINERS)) {
  test(`defaultLensesForContainer: ${kind} container with systemLenses is non-empty (fail-safe precondition)`, () => {
    const out = defaultLensesForContainer({
      container,
      connectedAddress: undefined, // no wallet
      explicitLenses: null, // no ?lenses=
      webOfTrust: [],
      systemLenses: SYSTEM_LENSES,
    });
    assert.ok(out.length > 0, `${kind} container must yield a non-empty default lens list`);
  });
}

test("defaultLensesForContainer: non-empty even with no wallet and no web-of-trust", () => {
  const out = defaultLensesForContainer({
    container: CONTAINERS.anchor,
    connectedAddress: undefined,
    explicitLenses: null,
    webOfTrust: [],
    systemLenses: SYSTEM_LENSES,
  });
  assert.deepEqual(out, SYSTEM_LENSES);
});

test("defaultLensesForContainer: orders connected, viewed, web-of-trust, EFS content, system", () => {
  const out = defaultLensesForContainer({
    container: CONTAINERS.address,
    connectedAddress: ALICE,
    explicitLenses: null,
    webOfTrust: [TRUSTED_ADDRESS],
    systemLenses: SYSTEM_LENSES,
  });
  assert.deepEqual(out, [ALICE, VIEWED_ADDRESS, TRUSTED_ADDRESS, EFS_CONTENT_LENS, SYSTEM_ACCOUNT]);
});

test("defaultLensesForContainer: explicit ?lenses= overrides verbatim (ADR-0031)", () => {
  const out = defaultLensesForContainer({
    container: CONTAINERS.anchor,
    connectedAddress: ALICE,
    explicitLenses: [SYSTEM_LENSES[0]],
    webOfTrust: [],
    systemLenses: SYSTEM_LENSES,
  });
  assert.deepEqual(out, [SYSTEM_LENSES[0]]);
});

test("defaultLensesForContainer: explicit-but-empty stays empty (must NOT widen to defaults)", () => {
  const out = defaultLensesForContainer({
    container: CONTAINERS.anchor,
    connectedAddress: ALICE,
    explicitLenses: [], // ?lenses= whose tokens all failed to resolve
    webOfTrust: [],
    systemLenses: SYSTEM_LENSES,
  });
  // Empty explicit list is the user saying "scope to nothing" — the directory
  // hooks then disable and render an empty grid; it must NOT silently fall back
  // to default content.
  assert.deepEqual(out, []);
});

test("defaultLensesForContainer: dedupes and drops the zero address", () => {
  const out = defaultLensesForContainer({
    container: CONTAINERS.anchor,
    connectedAddress: SYSTEM_LENSES[0], // same as a systemLens
    explicitLenses: null,
    webOfTrust: ["0x0000000000000000000000000000000000000000"],
    systemLenses: SYSTEM_LENSES,
  });
  assert.equal(new Set(out.map(a => a.toLowerCase())).size, out.length, "no duplicates");
  assert.ok(!out.includes("0x0000000000000000000000000000000000000000"), "zero address dropped");
});
