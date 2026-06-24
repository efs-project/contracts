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

const { chainAwareBurner } = await import("../../services/web3/chainAwareBurnerWallet.ts");
const { mainnet, sepolia } = await import("viem/chains");
const { numberToHex } = await import("viem/utils");

type TestProvider = {
  request(args: { method: string; params?: any[] }): Promise<unknown>;
};

const DEVNET_CHAIN_ID = 26001993;
const devnet = {
  id: DEVNET_CHAIN_ID,
  name: "EFS Devnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://devnet.example/rpc"] } },
  testnet: true,
} as const;

function createTestConnector() {
  const emitted: Array<{ event: string; payload?: unknown }> = [];
  const connector = chainAwareBurner()({
    chains: [devnet, sepolia, mainnet],
    emitter: {
      emit: (event: string, payload?: unknown) => {
        emitted.push({ event, payload });
      },
    },
  } as any);
  return { connector, emitted };
}

const rejectsUnsupportedChain = (chainId: number) => (error: unknown) => {
  if (!(error instanceof Error)) return false;
  const cause = "cause" in error ? (error.cause as unknown) : undefined;
  const causeMessage = cause instanceof Error ? cause.message : "";
  return error.message.includes(`Burner chain ${chainId} is not configured`) ||
    causeMessage.includes(`Burner chain ${chainId} is not configured`);
};

test("provider follows wallet_switchEthereumChain instead of a stale provider chain", async () => {
  const { connector, emitted } = createTestConnector();
  const provider = (await connector.getProvider({ chainId: devnet.id })) as TestProvider;

  assert.equal(await provider.request({ method: "eth_chainId" }), numberToHex(devnet.id));

  await provider.request({
    method: "wallet_switchEthereumChain",
    params: [{ chainId: numberToHex(sepolia.id) }],
  });

  assert.equal(await provider.request({ method: "eth_chainId" }), numberToHex(sepolia.id));
  assert.deepEqual(emitted.at(-1), { event: "change", payload: { chainId: sepolia.id } });
});

test("existing providers follow connector switchChain calls", async () => {
  const { connector } = createTestConnector();
  const provider = (await connector.getProvider({ chainId: devnet.id })) as TestProvider;

  assert.equal(await provider.request({ method: "eth_chainId" }), numberToHex(devnet.id));

  await connector.switchChain({ chainId: sepolia.id });

  assert.equal(await provider.request({ method: "eth_chainId" }), numberToHex(sepolia.id));
});

test("onChainChanged rejects unsupported chain ids before emitting", () => {
  const { connector, emitted } = createTestConnector();

  assert.throws(() => connector.onChainChanged(numberToHex(mainnet.id)), rejectsUnsupportedChain(mainnet.id));
  assert.deepEqual(emitted, []);
});

test("burner rejects mainnet even when wagmi appends it for ENS reads", async () => {
  const { connector } = createTestConnector();

  await assert.rejects(() => connector.connect({ chainId: mainnet.id }), rejectsUnsupportedChain(mainnet.id));
  await assert.rejects(() => connector.switchChain({ chainId: mainnet.id }), rejectsUnsupportedChain(mainnet.id));
});
