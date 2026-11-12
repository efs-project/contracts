import type { Config, Connector } from "wagmi";

export const BURNER_WALLET_CONNECTOR_ID = "burnerWallet";
export const BURNER_WALLET_PK_STORAGE_KEY = "burnerWallet.pk";
export const EASY_EDITS_STORAGE_KEY = "instantBurner.easyEdits";
export const INSTANT_BURNER_PAUSE_MS = 30_000;
let instantBurnerDripRequested = false;

type WalletStatus = "connected" | "connecting" | "disconnected" | "reconnecting";
type SelectableChain = { id: number };
type EasyEditsStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function isInstantBurnerSessionEnabled({
  faucetUrl,
  flag,
}: {
  faucetUrl: string | undefined;
  flag: string | undefined;
}): boolean {
  const normalizedFlag = (flag ?? "").trim().toLowerCase();
  return (faucetUrl ?? "").trim().length > 0 && normalizedFlag !== "false" && normalizedFlag !== "0";
}

export function isBurnerConnector(connector: Pick<Connector, "id"> | undefined): boolean {
  return connector?.id === BURNER_WALLET_CONNECTOR_ID;
}

export function selectBurnerChain<TChain extends SelectableChain>({
  chains,
  requestedChainId,
  connectedChainId,
}: {
  chains: readonly TChain[];
  requestedChainId?: number;
  connectedChainId?: number;
}): TChain {
  if (chains.length === 0) throw new Error("No burner chains configured.");
  if (requestedChainId !== undefined) {
    const requestedChain = chains.find(chain => chain.id === requestedChainId);
    if (!requestedChain) throw new Error(`Burner chain ${requestedChainId} is not configured.`);
    return requestedChain;
  }
  if (connectedChainId !== undefined) {
    const connectedChain = chains.find(chain => chain.id === connectedChainId);
    if (!connectedChain) throw new Error(`Burner chain ${connectedChainId} is not configured.`);
    return connectedChain;
  }
  return chains[0];
}

export function shouldAutoConnectInstantBurner({
  enabled,
  editingSessionRequested,
  status,
  targetChainId,
  faucetChainId,
  activeConnectorId,
  pausedUntil,
  realWalletFlowActive,
  initialReconnectSettled,
  now,
}: {
  enabled: boolean;
  editingSessionRequested: boolean;
  status: WalletStatus;
  targetChainId: number;
  faucetChainId: number;
  activeConnectorId: string | undefined;
  pausedUntil: number | undefined;
  realWalletFlowActive: boolean;
  initialReconnectSettled: boolean;
  now: number;
}): boolean {
  if (!enabled) return false;
  if (!editingSessionRequested) return false;
  if (realWalletFlowActive) return false;
  if (!initialReconnectSettled) return false;
  if (status !== "disconnected") return false;
  if (targetChainId !== faucetChainId) return false;
  if (activeConnectorId && activeConnectorId !== BURNER_WALLET_CONNECTOR_ID) return false;
  if (pausedUntil !== undefined && pausedUntil > now) return false;
  return true;
}

// wagmi starts every page "disconnected" and only then reconnects remembered wallets, so the
// first connecting/reconnecting -> settled transition marks the end of that page-load restore.
export function isInitialReconnectSettled({
  previousStatus,
  status,
}: {
  previousStatus: WalletStatus;
  status: WalletStatus;
}): boolean {
  const wasReconnecting = previousStatus === "connecting" || previousStatus === "reconnecting";
  return wasReconnecting && (status === "connected" || status === "disconnected");
}

/**
 * Watches one page load: records which wallet wagmi last had active (read before this load's
 * reconnect can change it) and announces, once, when that reconnect has settled. Subscribed
 * from the store itself rather than React state, so the settle transition can't be batched away.
 */
export function createPageLoadWalletTracker(config: Pick<Config, "subscribe" | "storage">) {
  let settled = false;
  let recentConnectorIdAtLoad: string | null = null;
  const listeners = new Set<() => void>();

  void Promise.resolve(config.storage?.getItem("recentConnectorId")).then(
    id => {
      recentConnectorIdAtLoad = id ?? null;
    },
    () => undefined,
  );
  const stopWatching = config.subscribe(
    state => state.status,
    (status, previousStatus) => {
      if (!isInitialReconnectSettled({ previousStatus, status })) return;
      settled = true;
      stopWatching();
      listeners.forEach(listener => listener());
    },
  );

  return {
    hasSettled: () => settled,
    recentConnectorIdAtLoad: () => recentConnectorIdAtLoad,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// A reload restores the burner only if it was the active wallet before the reload. If a real
// wallet was active but couldn't be restored (e.g. it is locked), end Easy Edits rather than
// silently switching the visitor to the burner's address.
export function shouldEndEasyEditsAfterPageLoad({
  editingSessionRequested,
  status,
  recentConnectorIdAtLoad,
}: {
  editingSessionRequested: boolean;
  status: WalletStatus;
  recentConnectorIdAtLoad: string | null;
}): boolean {
  return editingSessionRequested && status === "disconnected" && recentConnectorIdAtLoad !== BURNER_WALLET_CONNECTOR_ID;
}

// Easy Edits is a remembered choice, like a connected wallet: it stays on across reloads until
// the visitor turns it off or disconnects the burner.
export function readStoredEasyEdits(storage: EasyEditsStorage | undefined): boolean {
  return storage?.getItem(EASY_EDITS_STORAGE_KEY) === "1";
}

export function writeStoredEasyEdits(storage: EasyEditsStorage | undefined, enabled: boolean): void {
  if (enabled) storage?.setItem(EASY_EDITS_STORAGE_KEY, "1");
  else storage?.removeItem(EASY_EDITS_STORAGE_KEY);
}

// wagmi never restores the instant burner by itself: Easy Edits reconnects it after wagmi's
// page-load reconnect settles, so it can't race a real wallet being restored.
export function shouldRestoreBurnerOnLoad({ instantBurnerEnabled }: { instantBurnerEnabled: boolean }): boolean {
  return !instantBurnerEnabled;
}

export function shouldStopInstantBurnerAfterExternalDisconnect({
  wasBurnerConnected,
  editingSessionRequested,
  status,
}: {
  wasBurnerConnected: boolean;
  editingSessionRequested: boolean;
  status: WalletStatus;
}): boolean {
  return wasBurnerConnected && editingSessionRequested && status === "disconnected";
}

export function trackInstantBurnerWasConnected({
  current,
  status,
  chainId,
  faucetChainId,
  activeConnectorId,
  disablingInstantBurner = false,
}: {
  current: boolean;
  status: WalletStatus;
  chainId: number | undefined;
  faucetChainId: number;
  activeConnectorId: string | undefined;
  disablingInstantBurner?: boolean;
}): boolean {
  if (disablingInstantBurner) return false;
  if (status !== "connected") return current;
  return chainId === faucetChainId && activeConnectorId === BURNER_WALLET_CONNECTOR_ID;
}

export function shouldShowInstantBurnerEnable({
  enabled,
  status,
  targetChainId,
  faucetChainId,
  address,
}: {
  enabled: boolean;
  status: WalletStatus;
  targetChainId: number;
  faucetChainId: number;
  address: string | undefined;
}): boolean {
  if (!enabled) return false;
  if (targetChainId !== faucetChainId) return false;
  return !address && status === "disconnected";
}

export function shouldDisconnectInstantBurner({
  activeConnectorId,
  editingSessionRequested,
  chainId,
  targetChainId,
  faucetChainId,
}: {
  activeConnectorId: string | undefined;
  editingSessionRequested: boolean;
  chainId: number | undefined;
  targetChainId: number;
  faucetChainId: number;
}): boolean {
  if (activeConnectorId !== BURNER_WALLET_CONNECTOR_ID) return false;
  if (!editingSessionRequested) return true;
  return chainId !== faucetChainId || targetChainId !== faucetChainId;
}

export function shouldClearInstantBurnerTrackingBeforeDisconnect({
  activeConnectorId,
  shouldDisconnect,
}: {
  activeConnectorId: string | undefined;
  shouldDisconnect: boolean;
}): boolean {
  return shouldDisconnect && activeConnectorId === BURNER_WALLET_CONNECTOR_ID;
}

export function shouldSuppressInstantBurnerTracking({
  activeConnectorId,
  editingSessionRequested,
  intentionalDisconnectInProgress,
}: {
  activeConnectorId: string | undefined;
  editingSessionRequested: boolean;
  intentionalDisconnectInProgress: boolean;
}): boolean {
  if (activeConnectorId !== BURNER_WALLET_CONNECTOR_ID) return false;
  return intentionalDisconnectInProgress || !editingSessionRequested;
}

export function shouldAutoDripInstantBurner({
  faucetEnabled,
  activeConnectorId,
  dripRequested,
}: {
  faucetEnabled: boolean;
  activeConnectorId: string | undefined;
  dripRequested: boolean;
}): boolean {
  return faucetEnabled && activeConnectorId === BURNER_WALLET_CONNECTOR_ID && dripRequested;
}

export function shouldResetInstantBurnerDismissalOnAddressChange({
  dismissed,
  previousAddress,
  nextAddress,
  activeConnectorId,
}: {
  dismissed: boolean;
  previousAddress: string | undefined;
  nextAddress: string | undefined;
  activeConnectorId: string | undefined;
}): boolean {
  if (!dismissed) return false;
  if (!nextAddress || nextAddress === previousAddress) return false;
  return activeConnectorId === BURNER_WALLET_CONNECTOR_ID;
}

export function shouldResumeInstantBurnerAfterRealWalletModal({
  requestedRealWallet,
  modalWasOpen,
  connectModalOpen,
  status,
}: {
  requestedRealWallet: boolean;
  modalWasOpen: boolean;
  connectModalOpen: boolean;
  status: WalletStatus;
}): boolean {
  return requestedRealWallet && modalWasOpen && !connectModalOpen && status === "disconnected";
}

export function shouldSeedHardhatBurner({
  hasHardhatTarget,
  defaultChainId,
  hardhatChainId,
}: {
  hasHardhatTarget: boolean;
  defaultChainId: number;
  hardhatChainId: number;
}): boolean {
  return hasHardhatTarget && defaultChainId === hardhatChainId;
}

export function shouldClearStoredHardhatBurner({
  targetChainId,
  hardhatChainId,
  storedPrivateKey,
  hardhatPrivateKeys,
}: {
  targetChainId: number;
  hardhatChainId: number;
  storedPrivateKey: `0x${string}` | undefined;
  hardhatPrivateKeys: readonly string[];
}): boolean {
  if (targetChainId === hardhatChainId || !storedPrivateKey) return false;
  return hardhatPrivateKeys.some(pk => pk.toLowerCase() === storedPrivateKey.toLowerCase());
}

export function shouldBlockFaucetDripForBurner({
  activeConnectorId,
  targetChainId,
  hardhatChainId,
  storedPrivateKey,
  hardhatPrivateKeys,
}: {
  activeConnectorId: string | undefined;
  targetChainId: number;
  hardhatChainId: number;
  storedPrivateKey: `0x${string}` | undefined;
  hardhatPrivateKeys: readonly string[];
}): boolean {
  if (activeConnectorId !== BURNER_WALLET_CONNECTOR_ID) return false;
  return shouldClearStoredHardhatBurner({ targetChainId, hardhatChainId, storedPrivateKey, hardhatPrivateKeys });
}

export function shouldBlockFaucetDripRecipient({
  recipientAddress,
  hardhatAddresses,
}: {
  recipientAddress: string | undefined;
  hardhatAddresses: readonly string[];
}): boolean {
  if (!recipientAddress) return false;
  return hardhatAddresses.some(address => address.toLowerCase() === recipientAddress.toLowerCase());
}

export function normalizeStoredBurnerPrivateKey(raw: string | null): `0x${string}` | undefined {
  const normalized = raw?.replaceAll('"', "") as `0x${string}` | undefined;
  if (!normalized || normalized === "0x" || normalized.length < 66) return undefined;
  return normalized;
}

export function requestInstantBurnerDrip(): void {
  instantBurnerDripRequested = true;
}

export function consumeInstantBurnerDripRequest(): boolean {
  const requested = instantBurnerDripRequested;
  instantBurnerDripRequested = false;
  return requested;
}

export type InstantBurnerMessage = {
  tone: "funding" | "ready" | "waiting" | "error";
  label: string;
};

export function shouldMarkInstantBurnerReady({
  pendingHash,
  baselineValue,
  balanceValue,
}: {
  pendingHash: string | undefined;
  baselineValue: bigint | undefined;
  balanceValue: bigint | undefined;
}): boolean {
  if (!pendingHash || balanceValue === undefined) return false;
  if (baselineValue === undefined) return balanceValue > 0n;
  return balanceValue > baselineValue;
}

export function getInstantBurnerMessage({
  pendingHash,
  balanceValue,
  errorMessage,
}: {
  pendingHash: string | undefined;
  balanceValue: bigint | undefined;
  errorMessage: string | undefined;
}): InstantBurnerMessage {
  if (pendingHash) return { tone: "funding", label: "funding..." };
  if (balanceValue !== undefined && balanceValue > 0n) return { tone: "ready", label: "ready" };
  if (errorMessage) return { tone: "error", label: errorMessage };
  return { tone: "waiting", label: "waiting for gas" };
}
