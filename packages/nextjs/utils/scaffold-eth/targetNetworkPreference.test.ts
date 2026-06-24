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

const { resolveDefaultTargetChain } = await import("../../scaffold.config.ts");
const {
  LEGACY_TARGET_NETWORK_STORAGE_KEY,
  readStoredTargetNetworkId,
  selectInitialTargetNetwork,
  writeStoredTargetNetworkId,
  TARGET_NETWORK_STORAGE_KEY,
} = await import("./targetNetworkPreference.ts");

const sepolia = { id: 11155111, name: "Sepolia" };
const devnet = { id: 26001993, name: "EFS Devnet" };
const hardhat = { id: 31337, name: "Local" };

function memoryStorage(initial?: Record<string, string>): Storage {
  const data = new Map<string, string>();
  Object.entries(initial ?? {}).forEach(([key, value]) => data.set(key, value));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: key => data.get(key) ?? null,
    key: index => [...data.keys()][index] ?? null,
    removeItem: key => data.delete(key),
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

test("production build default is Sepolia when NEXT_PUBLIC_TARGET_CHAIN is unset", () => {
  assert.deepEqual(
    resolveDefaultTargetChain({
      targetChain: "",
      localAvailable: false,
      sepoliaChain: sepolia,
      devnetChain: devnet,
      hardhatChain: hardhat,
      available: [sepolia, devnet],
    }),
    sepolia,
  );
});

test("explicit target-chain env overrides still win", () => {
  assert.deepEqual(
    resolveDefaultTargetChain({
      targetChain: "devnet",
      allowDevnetDefault: true,
      localAvailable: false,
      sepoliaChain: sepolia,
      devnetChain: devnet,
      hardhatChain: hardhat,
      available: [sepolia, devnet],
    }),
    devnet,
  );
  assert.deepEqual(
    resolveDefaultTargetChain({
      targetChain: "11155111",
      allowDevnetDefault: false,
      localAvailable: false,
      sepoliaChain: sepolia,
      devnetChain: devnet,
      hardhatChain: hardhat,
      available: [sepolia, devnet],
    }),
    sepolia,
  );
});

test("production builds ignore accidental Devnet defaults unless explicitly allowed", () => {
  assert.deepEqual(
    resolveDefaultTargetChain({
      targetChain: "devnet",
      allowDevnetDefault: false,
      localAvailable: false,
      sepoliaChain: sepolia,
      devnetChain: devnet,
      hardhatChain: hardhat,
      available: [sepolia, devnet],
    }),
    sepolia,
  );
  assert.deepEqual(
    resolveDefaultTargetChain({
      targetChain: "26001993",
      allowDevnetDefault: true,
      localAvailable: false,
      sepoliaChain: sepolia,
      devnetChain: devnet,
      hardhatChain: hardhat,
      available: [sepolia, devnet],
    }),
    devnet,
  );
});

test("stored user network preference becomes the startup network", () => {
  assert.equal(readStoredTargetNetworkId(memoryStorage({ [TARGET_NETWORK_STORAGE_KEY]: String(devnet.id) })), devnet.id);
  assert.equal(
    readStoredTargetNetworkId(
      memoryStorage({
        [TARGET_NETWORK_STORAGE_KEY]: String(sepolia.id),
        [LEGACY_TARGET_NETWORK_STORAGE_KEY]: String(devnet.id),
      }),
      { ignoredLegacyChainIds: [devnet.id] },
    ),
    sepolia.id,
  );
  assert.deepEqual(selectInitialTargetNetwork([sepolia, devnet], devnet.id), devnet);
  assert.deepEqual(selectInitialTargetNetwork([sepolia, devnet], sepolia.id), sepolia);
});

test("legacy Devnet preference from the bad public build does not pin startup to Devnet", () => {
  assert.equal(
    readStoredTargetNetworkId(memoryStorage({ [LEGACY_TARGET_NETWORK_STORAGE_KEY]: String(devnet.id) }), {
      ignoredLegacyChainIds: [devnet.id],
    }),
    undefined,
  );
  assert.equal(
    readStoredTargetNetworkId(memoryStorage({ [LEGACY_TARGET_NETWORK_STORAGE_KEY]: String(sepolia.id) }), {
      ignoredLegacyChainIds: [devnet.id],
    }),
    sepolia.id,
  );
});

test("invalid stored network preference falls back to configured default", () => {
  assert.equal(readStoredTargetNetworkId(memoryStorage({ [TARGET_NETWORK_STORAGE_KEY]: "not-a-chain" })), undefined);
  assert.deepEqual(selectInitialTargetNetwork([sepolia, devnet], 1), sepolia);
  assert.deepEqual(selectInitialTargetNetwork([sepolia, devnet], undefined), sepolia);
});

test("network selections are persisted by chain id", () => {
  const storage = memoryStorage({ [LEGACY_TARGET_NETWORK_STORAGE_KEY]: String(devnet.id) });
  writeStoredTargetNetworkId(storage, sepolia.id);
  assert.equal(storage.getItem(TARGET_NETWORK_STORAGE_KEY), String(sepolia.id));
  assert.equal(storage.getItem(LEGACY_TARGET_NETWORK_STORAGE_KEY), null);
});
