import { MARK_HASH_ROUTE_SCRIPT, formatHashRoute, isHashRoute, parseHashRoute } from "./hashRoute.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

const parsed = (hash: string) => {
  const r = parseHashRoute(hash);
  return r && { chain: r.chain, segments: r.segments, params: r.params.toString() };
};

test("isHashRoute: a route has a `/` after the optional chain", () => {
  for (const h of ["#/", "#/whitepapers", "#sep/", "#sep/whitepapers/bitcoin.pdf", "#11155111/x", "#/?lenses=a"]) {
    assert.equal(isHashRoute(h), true, h);
  }
  for (const h of ["", "#", "#top", "#sep", "#section-2"]) assert.equal(isHashRoute(h), false, h);
});

test("parseHashRoute: no chain, path and options", () => {
  assert.deepEqual(parsed("#/"), { chain: "", segments: [], params: "" });
  assert.deepEqual(parsed("#/whitepapers/bitcoin.pdf"), {
    chain: "",
    segments: ["whitepapers", "bitcoin.pdf"],
    params: "",
  });
  assert.deepEqual(parsed("#/whitepapers/?lenses=alice.eth&sort=0xab"), {
    chain: "",
    segments: ["whitepapers"],
    params: "lenses=alice.eth&sort=0xab",
  });
});

test("parseHashRoute: the chain is the fragment's text between `#` and the first `/`", () => {
  assert.deepEqual(parsed("#sep/whitepapers/bitcoin.pdf"), {
    chain: "sep",
    segments: ["whitepapers", "bitcoin.pdf"],
    params: "",
  });
  assert.deepEqual(parsed("#11155111/"), { chain: "11155111", segments: [], params: "" });
  // A top-level folder named like a chain is still a folder.
  assert.deepEqual(parsed("#/sep/x"), { chain: "", segments: ["sep", "x"], params: "" });
});

test("parseHashRoute: not a route", () => {
  for (const h of ["", "#", "#top", "#sep"]) assert.equal(parseHashRoute(h), null, h);
});

test("parseHashRoute: segments decode once; malformed escapes are kept as written", () => {
  assert.deepEqual(parsed("#/d/my%2520notes.txt")!.segments, ["d", "my%20notes.txt"]);
  assert.deepEqual(parsed("#/d/a%3Fb.md?x=1")!.segments, ["d", "a?b.md"]);
  assert.deepEqual(parsed("#/d/10%.txt")!.segments, ["d", "10%.txt"]);
  assert.deepEqual(parsed("#/d//e/")!.segments, ["d", "e"]);
});

test("formatHashRoute: builds from URL-encoded segments and keeps the chain and options", () => {
  assert.equal(formatHashRoute({ segments: [] }), "#/");
  assert.equal(formatHashRoute({ segments: ["whitepapers", "bitcoin.pdf"] }), "#/whitepapers/bitcoin.pdf");
  assert.equal(formatHashRoute({ chain: "sep", segments: ["whitepapers"] }), "#sep/whitepapers");
  assert.equal(formatHashRoute({ chain: "sep", segments: [] }), "#sep/");
  assert.equal(
    formatHashRoute({ segments: ["w"], params: new URLSearchParams("lenses=alice.eth") }),
    "#/w?lenses=alice.eth",
  );
  assert.equal(formatHashRoute({ segments: ["w"], params: "" }), "#/w");
});

test("format → parse round-trips every kind of name", () => {
  const names = ["bitcoin.pdf", "my%20notes.txt", "Q%26A%3A%20Ep%205", "日本.pdf", "a#b?c&d=e", "10%.txt", "sep", "."];
  for (const name of names) {
    const hash = formatHashRoute({ chain: "sep", segments: ["d", encodeURIComponent(name)], params: "lenses=a" });
    assert.deepEqual(parsed(hash), { chain: "sep", segments: ["d", name], params: "lenses=a" }, name);
  }
});

test("parse tolerates the browser escaping the fragment", () => {
  // Browsers may percent-encode spaces and non-ASCII typed into the address bar.
  assert.deepEqual(parsed("#/d/%E6%97%A5%E6%9C%AC.pdf")!.segments, ["d", "日本.pdf"]);
  assert.deepEqual(parsed("#/d/a%20b.md")!.segments, ["d", "a b.md"]);
});

test("MARK_HASH_ROUTE_SCRIPT: marks <html> only for explorer routes", () => {
  const run = (hash: string) => {
    const attrs: string[] = [];
    const document = { documentElement: { setAttribute: (name: string) => attrs.push(name) } };
    new Function("location", "document", MARK_HASH_ROUTE_SCRIPT)({ hash }, document);
    return attrs;
  };
  assert.deepEqual(run("#/whitepapers/bitcoin.pdf"), ["data-efs-route"]);
  assert.deepEqual(run("#sep/"), ["data-efs-route"]);
  assert.deepEqual(run(""), []);
  assert.deepEqual(run("#top"), []);
});

test("parseHashRoute: rawSegments keep the link as written (malformed escapes included)", () => {
  const r = parseHashRoute("#sep/d/my%2520notes.txt/%E0%A4%A/?x=1")!;
  assert.deepEqual(r.rawSegments, ["d", "my%2520notes.txt", "%E0%A4%A"]);
  assert.deepEqual(r.segments, ["d", "my%20notes.txt", "%E0%A4%A"]);
  assert.equal(formatHashRoute({ segments: r.rawSegments, params: r.params }), "#/d/my%2520notes.txt/%E0%A4%A?x=1");
});
