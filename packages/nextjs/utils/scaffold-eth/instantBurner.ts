import type { Connector } from "wagmi";

export const BURNER_WALLET_CONNECTOR_ID = "burnerWallet";
export const BURNER_WALLET_PK_STORAGE_KEY = "burnerWallet.pk";
export const INSTANT_BURNER_PAUSE_MS = 30_000;
let instantBurnerDripRequested = false;

type WalletStatus = "connected" | "connecting" | "disconnected" | "reconnecting";
type SelectableChain = { id: number };

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
  now: number;
}): boolean {
  if (!enabled) return false;
  if (!editingSessionRequested) return false;
  if (realWalletFlowActive) return false;
  if (status !== "disconnected") return false;
  if (targetChainId !== faucetChainId) return false;
  if (activeConnectorId && activeConnectorId !== BURNER_WALLET_CONNECTOR_ID) return false;
  if (pausedUntil !== undefined && pausedUntil > now) return false;
  return true;
}

export function shouldReconnectWagmiOnMount({
  instantBurnerEnabled,
}: {
  instantBurnerEnabled: boolean;
}): boolean {
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
