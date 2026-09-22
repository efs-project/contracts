import assert from "node:assert/strict";
import { test } from "node:test";

// Set env vars BEFORE importing transports.ts — the gateway constants are
// evaluated at module-init time, so these values must be present first.
// Both intentionally omit the trailing slash to exercise the normalization.
process.env.NEXT_PUBLIC_IPFS_GATEWAY = "https://gateway.example/ipfs";
process.env.NEXT_PUBLIC_ARWEAVE_GATEWAY = "https://arweave.example/arweave";

const { resolveGatewayUrl, computeContentHash, verifyContentHash, CANONICAL_CONTENT_HASH } = await import(
  "./transports.ts"
);

test("resolveGatewayUrl normalises IPFS gateway env var missing trailing slash", () => {
  const url = resolveGatewayUrl("ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi");
  assert.equal(url, "https://gateway.example/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi");
});

test("resolveGatewayUrl normalises Arweave gateway env var missing trailing slash", () => {
  const url = resolveGatewayUrl("ar://SomeArweaveTxId");
  assert.equal(url, "https://arweave.example/arweave/SomeArweaveTxId");
});

test("gateway trailing-slash normalisation is idempotent (no double slash)", () => {
  assert.equal("https://host/ipfs/".replace(/\/?$/, "/"), "https://host/ipfs/");
  assert.equal("https://host/arweave/".replace(/\/?$/, "/"), "https://host/arweave/");
});

test("computeContentHash emits the canonical specs/10 multihash (sha2-256), not a bare keccak digest", () => {
  // Vector: sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
  const bytes = new TextEncoder().encode("hello");
  assert.equal(computeContentHash(bytes), "f12202cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  assert.ok(CANONICAL_CONTENT_HASH.test(computeContentHash(bytes)));
});

test("verifyContentHash accepts both registered forms and rejects a bare digest", () => {
  const bytes = new TextEncoder().encode("hello");
  assert.equal(verifyContentHash(bytes, computeContentHash(bytes)), true);
  // keccak256("hello") as the f1b20 alternate
  assert.equal(verifyContentHash(bytes, "f1b201c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8"), true);
  // The same keccak digest WITHOUT the label is algorithm-ambiguous — never accepted.
  assert.equal(verifyContentHash(bytes, "0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8"), false);
  assert.equal(verifyContentHash(new TextEncoder().encode("other"), computeContentHash(bytes)), false);
});
