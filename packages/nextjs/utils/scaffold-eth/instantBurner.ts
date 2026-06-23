import type { Connector } from "wagmi";

export const BURNER_WALLET_CONNECTOR_ID = "burnerWallet";
export const BURNER_WALLET_PK_STORAGE_KEY = "burnerWallet.pk";
export const INSTANT_BURNER_PAUSE_MS = 30_000;

type WalletStatus = "connected" | "connecting" | "disconnected" | "reconnecting";

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

export function shouldAutoConnectInstantBurner({
  enabled,
  status,
  targetChainId,
  faucetChainId,
  activeConnectorId,
  pausedUntil,
  now,
}: {
  enabled: boolean;
  status: WalletStatus;
  targetChainId: number;
  faucetChainId: number;
  activeConnectorId: string | undefined;
  pausedUntil: number | undefined;
  now: number;
}): boolean {
  if (!enabled) return false;
  if (status !== "disconnected") return false;
  if (targetChainId !== faucetChainId) return false;
  if (activeConnectorId && activeConnectorId !== BURNER_WALLET_CONNECTOR_ID) return false;
  if (pausedUntil !== undefined && pausedUntil > now) return false;
  return true;
}

export function shouldDisconnectInstantBurner({
  activeConnectorId,
  chainId,
  targetChainId,
  faucetChainId,
}: {
  activeConnectorId: string | undefined;
  chainId: number | undefined;
  targetChainId: number;
  faucetChainId: number;
}): boolean {
  if (activeConnectorId !== BURNER_WALLET_CONNECTOR_ID) return false;
  return chainId !== faucetChainId || targetChainId !== faucetChainId;
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

export function normalizeStoredBurnerPrivateKey(raw: string | null): `0x${string}` | undefined {
  const normalized = raw?.replaceAll('"', "") as `0x${string}` | undefined;
  if (!normalized || normalized === "0x" || normalized.length < 66) return undefined;
  return normalized;
}

export type InstantBurnerMessage = {
  tone: "funding" | "ready" | "waiting" | "error";
  label: string;
};

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
