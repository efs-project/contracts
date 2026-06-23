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

const {
  BURNER_WALLET_CONNECTOR_ID,
  BURNER_WALLET_PK_STORAGE_KEY,
  INSTANT_BURNER_PAUSE_MS,
  getInstantBurnerMessage,
  isBurnerConnector,
  isInstantBurnerSessionEnabled,
  normalizeStoredBurnerPrivateKey,
  shouldAutoConnectInstantBurner,
  shouldAutoDripInstantBurner,
  shouldDisconnectInstantBurner,
  shouldResumeInstantBurnerAfterRealWalletModal,
  shouldSeedHardhatBurner,
} = await import("./instantBurner.ts");

test("instant burner only enables when a faucet URL is configured and the kill switch is not false", () => {
  assert.equal(isInstantBurnerSessionEnabled({ faucetUrl: "", flag: undefined }), false);
  assert.equal(isInstantBurnerSessionEnabled({ faucetUrl: "   ", flag: "true" }), false);
  assert.equal(isInstantBurnerSessionEnabled({ faucetUrl: "https://faucet.example", flag: undefined }), true);
  assert.equal(isInstantBurnerSessionEnabled({ faucetUrl: "https://faucet.example", flag: "false" }), false);
  assert.equal(isInstantBurnerSessionEnabled({ faucetUrl: "https://faucet.example", flag: "0" }), false);
});

test("auto-connect is limited to settled no-wallet state on the faucet target chain", () => {
  const base = {
    enabled: true,
    editingSessionRequested: true,
    status: "disconnected" as const,
    targetChainId: 11155111,
    faucetChainId: 11155111,
    activeConnectorId: undefined,
    pausedUntil: undefined,
    realWalletFlowActive: false,
    now: 1_000,
  };

  assert.equal(shouldAutoConnectInstantBurner(base), true);
  assert.equal(shouldAutoConnectInstantBurner({ ...base, status: "connecting" }), false);
  assert.equal(shouldAutoConnectInstantBurner({ ...base, targetChainId: 26001993 }), false);
  assert.equal(shouldAutoConnectInstantBurner({ ...base, activeConnectorId: "metaMask" }), false);
  assert.equal(shouldAutoConnectInstantBurner({ ...base, enabled: false }), false);
  assert.equal(shouldAutoConnectInstantBurner({ ...base, editingSessionRequested: false }), false);
  assert.equal(shouldAutoConnectInstantBurner({ ...base, pausedUntil: base.now + INSTANT_BURNER_PAUSE_MS }), false);
  assert.equal(shouldAutoConnectInstantBurner({ ...base, realWalletFlowActive: true }), false);
});

test("burner connector detection is explicit", () => {
  assert.equal(BURNER_WALLET_CONNECTOR_ID, "burnerWallet");
  assert.equal(BURNER_WALLET_PK_STORAGE_KEY, "burnerWallet.pk");
  assert.equal(isBurnerConnector({ id: "burnerWallet" }), true);
  assert.equal(isBurnerConnector({ id: "metaMask" }), false);
  assert.equal(isBurnerConnector(undefined), false);
});

test("burner disconnects when it drifts off the faucet chain", () => {
  assert.equal(
    shouldDisconnectInstantBurner({
      activeConnectorId: "burnerWallet",
      editingSessionRequested: true,
      chainId: 26001993,
      targetChainId: 26001993,
      faucetChainId: 11155111,
    }),
    true,
  );
  assert.equal(
    shouldDisconnectInstantBurner({
      activeConnectorId: "burnerWallet",
      editingSessionRequested: true,
      chainId: 11155111,
      targetChainId: 26001993,
      faucetChainId: 11155111,
    }),
    true,
  );
  assert.equal(
    shouldDisconnectInstantBurner({
      activeConnectorId: "metaMask",
      editingSessionRequested: false,
      chainId: 26001993,
      targetChainId: 26001993,
      faucetChainId: 11155111,
    }),
    false,
  );
  assert.equal(
    shouldDisconnectInstantBurner({
      activeConnectorId: "burnerWallet",
      editingSessionRequested: false,
      chainId: 11155111,
      targetChainId: 11155111,
      faucetChainId: 11155111,
    }),
    true,
  );
  assert.equal(
    shouldDisconnectInstantBurner({
      activeConnectorId: "burnerWallet",
      editingSessionRequested: true,
      chainId: 11155111,
      targetChainId: 11155111,
      faucetChainId: 11155111,
    }),
    false,
  );
});

test("auto-drip requires an explicit editing-wallet request", () => {
  assert.equal(
    shouldAutoDripInstantBurner({
      faucetEnabled: true,
      activeConnectorId: "burnerWallet",
      dripRequested: true,
    }),
    true,
  );
  assert.equal(
    shouldAutoDripInstantBurner({
      faucetEnabled: true,
      activeConnectorId: "burnerWallet",
      dripRequested: false,
    }),
    false,
  );
  assert.equal(
    shouldAutoDripInstantBurner({
      faucetEnabled: true,
      activeConnectorId: "metaMask",
      dripRequested: true,
    }),
    false,
  );
});

test("real-wallet modal resume waits until the modal was actually open", () => {
  assert.equal(
    shouldResumeInstantBurnerAfterRealWalletModal({
      requestedRealWallet: true,
      modalWasOpen: false,
      connectModalOpen: false,
      status: "disconnected",
    }),
    false,
  );
  assert.equal(
    shouldResumeInstantBurnerAfterRealWalletModal({
      requestedRealWallet: true,
      modalWasOpen: true,
      connectModalOpen: false,
      status: "disconnected",
    }),
    true,
  );
  assert.equal(
    shouldResumeInstantBurnerAfterRealWalletModal({
      requestedRealWallet: true,
      modalWasOpen: true,
      connectModalOpen: true,
      status: "disconnected",
    }),
    false,
  );
});

test("hardhat seed keys only apply when local hardhat is the default target", () => {
  assert.equal(shouldSeedHardhatBurner({ hasHardhatTarget: true, defaultChainId: 31337, hardhatChainId: 31337 }), true);
  assert.equal(
    shouldSeedHardhatBurner({ hasHardhatTarget: true, defaultChainId: 11155111, hardhatChainId: 31337 }),
    false,
  );
  assert.equal(
    shouldSeedHardhatBurner({ hasHardhatTarget: false, defaultChainId: 11155111, hardhatChainId: 31337 }),
    false,
  );
});

test("private key normalization keeps valid stored keys and rejects placeholders", () => {
  assert.equal(normalizeStoredBurnerPrivateKey(null), undefined);
  assert.equal(normalizeStoredBurnerPrivateKey('"0x"'), undefined);
  assert.equal(normalizeStoredBurnerPrivateKey(`"0x${"a".repeat(64)}"`), `0x${"a".repeat(64)}`);
});

test("session chip message surfaces funding, ready, and faucet errors", () => {
  assert.deepEqual(getInstantBurnerMessage({ pendingHash: "0xabc", balanceValue: 0n, errorMessage: undefined }), {
    tone: "funding",
    label: "funding...",
  });
  assert.deepEqual(getInstantBurnerMessage({ pendingHash: undefined, balanceValue: 1n, errorMessage: undefined }), {
    tone: "ready",
    label: "ready",
  });
  assert.deepEqual(
    getInstantBurnerMessage({ pendingHash: undefined, balanceValue: 0n, errorMessage: "Faucet offline" }),
    {
      tone: "error",
      label: "Faucet offline",
    },
  );
});
