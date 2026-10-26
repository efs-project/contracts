import assert from "node:assert/strict";
import { test } from "node:test";

type ResolveHookContext = { parentURL?: string };
type ResolveHookResult = { url: string; shortCircuit?: boolean };
type NextResolve = (specifier: string, context: ResolveHookContext) => ResolveHookResult;
type ModuleWithRegisterHooks = {
  registerHooks(hooks: {
    resolve: (specifier: string, context: ResolveHookContext, nextResolve: NextResolve) => ResolveHookResult;
  }): void;
};

const { registerHooks } = (await import("node:module")) as unknown as ModuleWithRegisterHooks;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("~~/")) {
      return { url: new URL(`../../${specifier.slice(3)}.ts`, import.meta.url).href, shortCircuit: true };
    }
    try {
      return nextResolve(specifier, context);
    } catch (e) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
        return { url: new URL(`${specifier}.ts`, context.parentURL).href, shortCircuit: true };
      }
      throw e;
    }
  },
});

const { getPreferredRpcUrls } = await import("./networks.ts");
const { sepolia } = await import("viem/chains");

const ALCHEMY_SEPOLIA = /^https:\/\/eth-sepolia\.g\.alchemy\.com\/v2\//;

function withSepoliaRpcEnv(value: string | undefined, run: () => void) {
  const previous = process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL;
  if (value === undefined) delete process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL;
  else process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL;
    else process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL = previous;
  }
}

test("Sepolia reads try Alchemy before viem's public default RPC", () => {
  withSepoliaRpcEnv(undefined, () => {
    const urls = getPreferredRpcUrls(sepolia);
    // viem's built-in Sepolia default (sepolia.drpc.org) rejects keyless traffic with HTTP 400,
    // so it must never be the first transport the app tries.
    assert.match(urls[0] ?? "", ALCHEMY_SEPOLIA);
    assert.equal(urls[urls.length - 1], sepolia.rpcUrls.default.http[0]);
    assert.equal(new Set(urls).size, urls.length);
  });
});

test("an explicit NEXT_PUBLIC_SEPOLIA_RPC_URL is tried before Alchemy", () => {
  const explicitRpcUrl = "https://custom-sepolia.example/rpc";
  const customSepolia = { ...sepolia, rpcUrls: { default: { http: [explicitRpcUrl] } } };
  withSepoliaRpcEnv(explicitRpcUrl, () => {
    const urls = getPreferredRpcUrls(customSepolia);
    assert.equal(urls[0], explicitRpcUrl);
    assert.match(urls[1] ?? "", ALCHEMY_SEPOLIA);
    assert.equal(urls.length, 2);
  });
});

test("a chain without an Alchemy mapping keeps only its own RPC", () => {
  const devnet = {
    id: 26001993,
    name: "EFS Devnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://devnet.example/rpc"] } },
    testnet: true,
  } as const;
  assert.deepEqual(getPreferredRpcUrls(devnet), ["https://devnet.example/rpc"]);
});
