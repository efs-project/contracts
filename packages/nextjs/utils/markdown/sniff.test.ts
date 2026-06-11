import { test } from "node:test";
import assert from "node:assert/strict";
import { sniffContent } from "./sniff.ts";

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
