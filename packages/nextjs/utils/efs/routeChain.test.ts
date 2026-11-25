import { CHAIN_SHORT_NAMES, registryChainName, resolveRouteChain } from "./routeChain.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("resolveRouteChain: no chain means the viewer's chain", () => {
  assert.deepEqual(resolveRouteChain(""), { kind: "default" });
});

test("resolveRouteChain: ERC-3770 short names from ethereum-lists", () => {
  assert.deepEqual(resolveRouteChain("sep"), { kind: "id", chainId: 11155111 });
  assert.deepEqual(resolveRouteChain("eth"), { kind: "id", chainId: 1 });
  assert.deepEqual(resolveRouteChain("SEP"), { kind: "id", chainId: 11155111 });
});

test("resolveRouteChain: chain ids by number, including unregistered ones", () => {
  assert.deepEqual(resolveRouteChain("11155111"), { kind: "id", chainId: 11155111 });
  assert.deepEqual(resolveRouteChain("26001993"), { kind: "id", chainId: 26001993 });
  assert.deepEqual(resolveRouteChain("31337"), { kind: "id", chainId: 31337 });
});

test("resolveRouteChain: anything else is an unknown chain, never guessed", () => {
  for (const token of [
    "arb1",
    "sepolia",
    "got",
    "0",
    "011155111",
    "1e3",
    "-1",
    "99999999999999999999",
    "toString",
    "__proto__",
  ]) {
    assert.deepEqual(resolveRouteChain(token), { kind: "unknown", token }, token);
  }
});

test("31337 is GoChain's `got` in the registry, so local Hardhat is reachable by number only", () => {
  assert.equal(CHAIN_SHORT_NAMES.got, undefined);
  assert.equal(Object.values(CHAIN_SHORT_NAMES).includes(31337), false);
});

test("registryChainName: names for chains a link might name", () => {
  assert.equal(registryChainName(11155111), "Ethereum Sepolia");
  assert.equal(registryChainName(1), "Ethereum Mainnet");
  assert.equal(registryChainName(42), undefined);
});
