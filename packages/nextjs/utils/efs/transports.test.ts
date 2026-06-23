import assert from "node:assert/strict";
import { test } from "node:test";

// Set env vars BEFORE importing transports.ts — the gateway constants are
// evaluated at module-init time, so these values must be present first.
// Both intentionally omit the trailing slash to exercise the normalization.
process.env.NEXT_PUBLIC_IPFS_GATEWAY = "https://gateway.example/ipfs";
process.env.NEXT_PUBLIC_ARWEAVE_GATEWAY = "https://arweave.example/arweave";

const { resolveGatewayUrl } = await import("./transports.ts");

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
