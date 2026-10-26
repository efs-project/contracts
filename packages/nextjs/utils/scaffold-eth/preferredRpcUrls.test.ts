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
const { default: scaffoldConfig } = await import("../../scaffold.config.ts");
const { sepolia } = await import("viem/chains");
const { ContractFunctionRevertedError, createPublicClient, fallback, http, parseAbi } = await import("viem");

// The Sepolia chain object the app actually ships (scaffold.config.ts), not viem's stock one.
const appSepolia = scaffoldConfig.targetNetworks.find(chain => chain.id === sepolia.id);
assert.ok(appSepolia, "scaffold.config.ts must list Sepolia");

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

test("app Sepolia tries Alchemy, then working public RPCs, and never sepolia.drpc.org", () => {
  withSepoliaRpcEnv(undefined, () => {
    const urls = getPreferredRpcUrls(appSepolia);
    assert.match(urls[0] ?? "", ALCHEMY_SEPOLIA);
    assert.deepEqual(urls.slice(1), [
      "https://sepolia.gateway.tenderly.co",
      "https://ethereum-sepolia-rpc.publicnode.com",
    ]);
    assert.ok(!urls.some(url => url.includes("drpc.org")), "sepolia.drpc.org rejects keyless traffic");
  });
});

test("a reverting Sepolia read surfaces the revert, not a dead fallback's HTTP error", async () => {
  // viem's fallback transport moves to the next endpoint on any error except a wallet rejection,
  // including a legitimate revert. So the error the app finally sees comes from the LAST endpoint
  // that was tried, and a dead endpoint at the end of the list masks every revert as
  // "HTTP request failed". Each stub below returns the response the real provider gave on 2026-10-26.
  const revertBody = (id: unknown) => ({ jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted" } });
  const hosts: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    hosts.push(url.host);
    const { id } = JSON.parse(String(init?.body ?? "{}"));
    if (url.host === "sepolia.drpc.org") {
      const body = { jsonrpc: "2.0", id, error: { code: 35, message: "chain is not available on free plan" } };
      return new Response(JSON.stringify(body), { status: 400, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(revertBody(id)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    // Same transport shape as services/web3/wagmiConfig.tsx.
    const client = createPublicClient({
      chain: appSepolia,
      transport: fallback(getPreferredRpcUrls(appSepolia).map(url => http(url))),
    });
    const error = await client
      .readContract({
        address: "0xC2679fBD37d54388Ce493F1DB75320D236e1815e",
        abi: parseAbi(["function noSuchFn() view returns (uint256)"]),
        functionName: "noSuchFn",
      })
      .then(
        () => undefined,
        (e: unknown) => e as { walk(fn: (e: unknown) => boolean): unknown; shortMessage?: string },
      );
    assert.ok(error, "the read should have reverted");
    assert.ok(
      error.walk(e => e instanceof ContractFunctionRevertedError),
      `expected a contract revert, got: ${error.shortMessage}`,
    );
    assert.ok(!hosts.includes("sepolia.drpc.org"), `a dead endpoint was tried: ${hosts.join(", ")}`);
  } finally {
    globalThis.fetch = realFetch;
  }
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
