import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildFeedbackMailtoUrl } from "./feedback.ts";

test("buildFeedbackMailtoUrl addresses James and sets the feedback subject", () => {
  const url = new URL(buildFeedbackMailtoUrl());

  assert.equal(url.protocol, "mailto:");
  assert.equal(url.pathname, "JamesCarnley@gmail.com");
  assert.equal(url.searchParams.get("subject"), "EFS debug client feedback");
});

test("buildFeedbackMailtoUrl includes a structured feedback template", () => {
  const url = new URL(buildFeedbackMailtoUrl());
  const body = url.searchParams.get("body") ?? "";

  assert.match(body, /Page URL:/);
  assert.match(body, /Network \/ chain:/);
  assert.match(body, /Wallet connected\?/);
  assert.match(body, /What happened:/);
  assert.match(body, /What did you expect\?/);
  assert.match(body, /Tx hash or attestation UID/);
  assert.match(body, /Browser \/ wallet:/);
  assert.doesNotMatch(body, /undefined/);
});

test("buildFeedbackMailtoUrl includes the current page URL when provided", () => {
  const pageUrl = "https://app.efs.eth.limo/explorer/docs/readme.txt?lenses=0xabc";
  const url = new URL(buildFeedbackMailtoUrl({ pageUrl }));
  const body = url.searchParams.get("body") ?? "";

  assert.match(body, new RegExp(`Page URL: ${pageUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("buildFeedbackMailtoUrl warns against sending sensitive secrets", () => {
  const url = new URL(buildFeedbackMailtoUrl());
  const body = url.searchParams.get("body") ?? "";

  assert.match(body, /Do not include seed phrases, private keys, signatures, or private RPC keys\./);
});

test("FeedbackButton opens mail handlers outside the current app tab", async () => {
  const source = await readFile(new URL("../components/FeedbackButton.tsx", import.meta.url), "utf8");

  assert.equal((source.match(/target="_blank"/g) ?? []).length, 2);
  assert.equal((source.match(/rel="noopener noreferrer"/g) ?? []).length, 2);
});
