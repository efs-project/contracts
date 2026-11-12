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

const { chainAwareBurner, getBurnerRpcUrls } = await import("../../services/web3/chainAwareBurnerWallet.ts");
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

function createTestConnector(options?: Parameters<typeof chainAwareBurner>[0]) {
  const emitted: Array<{ event: string; payload?: unknown }> = [];
  const connector = chainAwareBurner(options)({
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
  return (
    error.message.includes(`Burner chain ${chainId} is not configured`) ||
    causeMessage.includes(`Burner chain ${chainId} is not configured`)
  );
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

test("burner restores itself on page load by default (local dev keeps its account)", async () => {
  const { connector } = createTestConnector();
  assert.equal(await connector.isAuthorized(), true);
});

test("burner opted out of page-load restore stays unauthorized until explicitly connected", async () => {
  // wagmi's reconnect() attaches every authorized connector, so this is what keeps a
  // page-load reconnect from silently giving every visitor a burner while still
  // letting real wallets reconnect.
  const { connector } = createTestConnector({ restoreOnLoad: false });
  assert.equal(await connector.isAuthorized(), false);

  await connector.connect({ chainId: sepolia.id });
  assert.equal(await connector.isAuthorized(), true);

  await connector.disconnect();
  assert.equal(await connector.isAuthorized(), false);
});

test("page-load reconnect restores a real wallet but skips an opted-out burner", async () => {
  const { createConfig, createConnector, http, reconnect } = await import("@wagmi/core");
  const realWalletAccount = "0x00000000000000000000000000000000000000a1";
  // Stands in for an injected wallet (MetaMask) that already authorized this site.
  const realWallet = createConnector(() => ({
    id: "realWallet",
    name: "Real wallet",
    type: "injected",
    connect: async () => ({ accounts: [realWalletAccount], chainId: sepolia.id }),
    disconnect: async () => undefined,
    getAccounts: async () => [realWalletAccount],
    getChainId: async () => sepolia.id,
    getProvider: async () => ({}),
    isAuthorized: async () => true,
    onAccountsChanged: () => undefined,
    onChainChanged: () => undefined,
    onDisconnect: () => undefined,
  })) as any;
  const reconnectOnLoad = async (restoreOnLoad: boolean) => {
    const connections = await reconnect(
      createConfig({
        chains: [sepolia],
        connectors: [chainAwareBurner({ restoreOnLoad }), realWallet],
        multiInjectedProviderDiscovery: false,
        transports: { [sepolia.id]: http() },
      }),
    );
    return connections.map(connection => connection.connector.id).sort();
  };

  assert.deepEqual(await reconnectOnLoad(false), ["realWallet"]);
  assert.deepEqual(await reconnectOnLoad(true), ["burnerWallet", "realWallet"]);
});

test("burner rejects mainnet even when wagmi appends it for ENS reads", async () => {
  const { connector } = createTestConnector();

  await assert.rejects(() => connector.connect({ chainId: mainnet.id }), rejectsUnsupportedChain(mainnet.id));
  await assert.rejects(() => connector.switchChain({ chainId: mainnet.id }), rejectsUnsupportedChain(mainnet.id));
});

test("burner Sepolia transport prefers the configured Alchemy fallback before public RPC", () => {
  const previousSepoliaRpcUrl = process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL;
  delete process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL;

  const sepoliaUrls = getBurnerRpcUrls(sepolia);
  try {
    assert.match(sepoliaUrls[0] ?? "", /^https:\/\/eth-sepolia\.g\.alchemy\.com\/v2\//);
    assert.equal(new Set(sepoliaUrls).size, sepoliaUrls.length);

    assert.deepEqual(getBurnerRpcUrls(devnet), devnet.rpcUrls.default.http);
  } finally {
    if (previousSepoliaRpcUrl === undefined) {
      delete process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL;
    } else {
      process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL = previousSepoliaRpcUrl;
    }
  }
});

test("burner honors an explicit Sepolia RPC override before the Alchemy fallback", () => {
  const previousSepoliaRpcUrl = process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL;
  const explicitRpcUrl = "https://custom-sepolia.example/rpc";
  const customSepolia = {
    ...sepolia,
    rpcUrls: { default: { http: [explicitRpcUrl] } },
  };

  process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL = explicitRpcUrl;
  try {
    const sepoliaUrls = getBurnerRpcUrls(customSepolia);
    assert.equal(sepoliaUrls[0], explicitRpcUrl);
    assert.match(sepoliaUrls[1] ?? "", /^https:\/\/eth-sepolia\.g\.alchemy\.com\/v2\//);
    assert.equal(new Set(sepoliaUrls).size, sepoliaUrls.length);
  } finally {
    if (previousSepoliaRpcUrl === undefined) {
      delete process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL;
    } else {
      process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL = previousSepoliaRpcUrl;
    }
  }
});
