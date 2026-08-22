import assert from "node:assert/strict";
import { test } from "node:test";

const priorIpfsGateway = process.env.NEXT_PUBLIC_IPFS_GATEWAY;
const priorArweaveGateway = process.env.NEXT_PUBLIC_ARWEAVE_GATEWAY;

process.env.NEXT_PUBLIC_IPFS_GATEWAY = "https://example.test/ipfs";
process.env.NEXT_PUBLIC_ARWEAVE_GATEWAY = "https://example.test/arweave";

const { resolveGatewayUrl } = await import("./transports.ts");

if (priorIpfsGateway === undefined) {
  delete process.env.NEXT_PUBLIC_IPFS_GATEWAY;
} else {
  process.env.NEXT_PUBLIC_IPFS_GATEWAY = priorIpfsGateway;
}
if (priorArweaveGateway === undefined) {
  delete process.env.NEXT_PUBLIC_ARWEAVE_GATEWAY;
} else {
  process.env.NEXT_PUBLIC_ARWEAVE_GATEWAY = priorArweaveGateway;
}

test("resolveGatewayUrl tolerates IPFS gateway bases without a trailing slash", () => {
  assert.equal(resolveGatewayUrl("ipfs://bafyexample/path.html"), "https://example.test/ipfs/bafyexample/path.html");
});

test("resolveGatewayUrl tolerates Arweave gateway bases without a trailing slash", () => {
  assert.equal(resolveGatewayUrl("ar://arweave-id"), "https://example.test/arweave/arweave-id");
});
