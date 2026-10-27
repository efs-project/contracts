import { looksLikePdf, sniffContent } from "./sniff.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

const enc = (s: string) => new TextEncoder().encode(s);

test("plain markdown is text", () => {
  assert.equal(sniffContent(enc("# Hello\n\nA paragraph with **bold**.")), "text");
});
test("utf-8 with emoji is text", () => {
  assert.equal(sniffContent(enc("# Title 🎉 café")), "text");
});
test("PDF magic is binary", () => {
  assert.equal(sniffContent(enc("%PDF-1.7\n...")), "binary");
});
test("PNG magic is binary", () => {
  assert.equal(sniffContent(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), "binary");
});
test("a NUL byte forces binary", () => {
  assert.equal(sniffContent(new Uint8Array([0x23, 0x20, 0x00, 0x68])), "binary");
});
test("invalid utf-8 is binary", () => {
  assert.equal(sniffContent(new Uint8Array([0xff, 0xfe, 0xff, 0xfe])), "binary");
});
test("empty input is text", () => {
  assert.equal(sniffContent(new Uint8Array([])), "text");
});
test("JPEG magic is binary", () => {
  assert.equal(sniffContent(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "binary");
});
test("GIF magic is binary", () => {
  assert.equal(sniffContent(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), "binary");
});
test("ZIP magic is binary", () => {
  assert.equal(sniffContent(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14])), "binary");
});
test("gzip magic is binary", () => {
  assert.equal(sniffContent(new Uint8Array([0x1f, 0x8b, 0x08])), "binary");
});

test("looksLikePdf accepts a %PDF- header at offset 0", () => {
  assert.equal(looksLikePdf(enc("%PDF-1.4\n%âãÏÓ\n1 0 obj")), true);
});
test("looksLikePdf accepts a header after leading junk within 1024 bytes", () => {
  assert.equal(looksLikePdf(enc(" ".repeat(500) + "%PDF-1.7")), true);
});
test("looksLikePdf rejects a header past the first 1024 bytes", () => {
  assert.equal(looksLikePdf(enc(" ".repeat(1024) + "%PDF-1.7")), false);
});
test("looksLikePdf rejects HTML mislabeled as application/pdf", () => {
  assert.equal(looksLikePdf(enc("<html><script>alert(1)</script></html>")), false);
});
test("looksLikePdf rejects empty and truncated input", () => {
  assert.equal(looksLikePdf(new Uint8Array([])), false);
  assert.equal(looksLikePdf(enc("%PDF")), false);
});
