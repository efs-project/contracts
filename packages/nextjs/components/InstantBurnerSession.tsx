"use client";

import { useEffect, useRef, useState } from "react";
import { hardhat } from "viem/chains";
import { useAccount, useConnect, useConnectors, useDisconnect } from "wagmi";
import { useTargetNetwork } from "~~/hooks/scaffold-eth";
import scaffoldConfig from "~~/scaffold.config";
import {
  BURNER_WALLET_PK_STORAGE_KEY,
  FAUCET_CHAIN_ID,
  FAUCET_URL,
  isBurnerConnector,
  isInstantBurnerSessionEnabled,
  normalizeStoredBurnerPrivateKey,
  requestInstantBurnerDrip,
  shouldAutoConnectInstantBurner,
  shouldClearStoredHardhatBurner,
  shouldDisconnectInstantBurner,
  shouldResetInstantBurnerDismissalOnAddressChange,
  shouldShowInstantBurnerEnable,
  shouldStopInstantBurnerAfterExternalDisconnect,
} from "~~/utils/scaffold-eth";
import { HARDHAT_ACCOUNTS } from "~~/utils/scaffold-eth/hardhatAccounts";

const INSTANT_BURNER_ENABLED = isInstantBurnerSessionEnabled({
  faucetUrl: FAUCET_URL,
  flag: process.env.NEXT_PUBLIC_INSTANT_BURNER_SESSION,
  defaultChainId: scaffoldConfig.targetNetworks[0].id,
  faucetChainId: FAUCET_CHAIN_ID,
});

const hardhatPrivateKeys = HARDHAT_ACCOUNTS.map(account => account.pk);

const InstantBurnerToggle = ({ active, onClick, title }: { active: boolean; onClick: () => void; title: string }) => (
  <button
    className={`hidden h-9 w-[7.25rem] shrink-0 items-center gap-2 rounded-full border px-2.5 text-left shadow-[0_0_16px_rgba(0,255,76,0.16)] transition-colors lg:inline-flex ${
      active
        ? "border-primary bg-primary/20 text-primary hover:bg-primary/25"
        : "border-primary/65 bg-primary/10 text-primary hover:border-primary hover:bg-primary/15"
    }`}
    type="button"
    onClick={onClick}
    title={title}
    aria-pressed={active}
  >
    <span className="flex min-w-0 flex-col leading-none">
      <span className="whitespace-nowrap text-[11px] font-semibold">Easy Edits</span>
      <span className="mt-0.5 whitespace-nowrap text-[9px] text-base-content/60">No prompts</span>
    </span>
    <span
      className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${
        active ? "border-primary bg-primary" : "border-primary/60 bg-primary/10"
      }`}
      aria-hidden="true"
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full shadow transition-all ${
          active ? "left-[1.125rem] bg-base-100" : "left-0.5 bg-primary"
        }`}
      />
    </span>
  </button>
);

const clearPublicHardhatBurnerKey = (targetChainId: number) => {
  if (typeof window === "undefined") return;
  const storedPrivateKey = normalizeStoredBurnerPrivateKey(window.localStorage.getItem(BURNER_WALLET_PK_STORAGE_KEY));
  if (
    shouldClearStoredHardhatBurner({
      targetChainId,
      hardhatChainId: hardhat.id,
      storedPrivateKey,
      hardhatPrivateKeys,
    })
  ) {
    window.localStorage.removeItem(BURNER_WALLET_PK_STORAGE_KEY);
  }
};

export const InstantBurnerSession = () => {
  const { address, chainId, connector, status } = useAccount();
  const connectors = useConnectors();
  const { connect } = useConnect();
  const { disconnect } = useDisconnect();
  const { targetNetwork } = useTargetNetwork();

  const [dismissed, setDismissed] = useState(false);
  const [editingSessionRequested, setEditingSessionRequested] = useState(false);
  const [pauseUntil, setPauseUntil] = useState<number | undefined>(undefined);
  const connectingBurnerRef = useRef(false);
  const disconnectingBurnerRef = useRef(false);
  const burnerWasConnectedRef = useRef(false);
  const previousAddressRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (
      shouldResetInstantBurnerDismissalOnAddressChange({
        dismissed,
        previousAddress: previousAddressRef.current,
        nextAddress: address,
        activeConnectorId: connector?.id,
      })
    ) {
      setDismissed(false);
    }
    previousAddressRef.current = address;
  }, [address, connector?.id, dismissed]);

  useEffect(() => {
    if (!INSTANT_BURNER_ENABLED || targetNetwork.id !== FAUCET_CHAIN_ID) return;
    clearPublicHardhatBurnerKey(targetNetwork.id);
  }, [targetNetwork.id]);

  useEffect(() => {
    if (!INSTANT_BURNER_ENABLED) return;
    if (
      !shouldDisconnectInstantBurner({
        activeConnectorId: connector?.id,
        editingSessionRequested,
        chainId,
        targetChainId: targetNetwork.id,
        faucetChainId: FAUCET_CHAIN_ID,
      })
    ) {
      return;
    }
    if (disconnectingBurnerRef.current) return;
    disconnectingBurnerRef.current = true;
    disconnect(undefined, {
      onSettled: () => {
        disconnectingBurnerRef.current = false;
      },
    });
  }, [chainId, connector?.id, editingSessionRequested, disconnect, targetNetwork.id]);

  useEffect(() => {
    if (!INSTANT_BURNER_ENABLED) return;
    if (connector && !isBurnerConnector(connector)) {
      setPauseUntil(undefined);
    }
  }, [connector]);

  useEffect(() => {
    if (pauseUntil === undefined) return;
    const delay = Math.max(0, pauseUntil - Date.now());
    const timer = window.setTimeout(() => setPauseUntil(undefined), delay);
    return () => window.clearTimeout(timer);
  }, [pauseUntil]);

  useEffect(() => {
    if (status === "connected" || status === "disconnected") {
      connectingBurnerRef.current = false;
    }
  }, [status]);

  useEffect(() => {
    if (status !== "connected") return;
    burnerWasConnectedRef.current = chainId === FAUCET_CHAIN_ID && isBurnerConnector(connector);
  }, [chainId, connector, status]);

  useEffect(() => {
    if (!INSTANT_BURNER_ENABLED) return;
    if (
      shouldStopInstantBurnerAfterExternalDisconnect({
        wasBurnerConnected: burnerWasConnectedRef.current,
        editingSessionRequested,
        status,
      })
    ) {
      burnerWasConnectedRef.current = false;
      setEditingSessionRequested(false);
      setDismissed(true);
      setPauseUntil(undefined);
      return;
    }

    const burnerConnector = connectors.find(isBurnerConnector);
    if (!burnerConnector || connectingBurnerRef.current) return;
    if (
      !shouldAutoConnectInstantBurner({
        enabled: INSTANT_BURNER_ENABLED,
        editingSessionRequested: editingSessionRequested && !dismissed,
        status,
        targetChainId: targetNetwork.id,
        faucetChainId: FAUCET_CHAIN_ID,
        activeConnectorId: connector?.id,
        pausedUntil: pauseUntil,
        realWalletFlowActive: false,
        now: Date.now(),
      })
    ) {
      return;
    }

    connectingBurnerRef.current = true;
    connect(
      { connector: burnerConnector, chainId: FAUCET_CHAIN_ID },
      {
        onSettled: () => {
          connectingBurnerRef.current = false;
        },
      },
    );
  }, [connect, connector?.id, connectors, dismissed, editingSessionRequested, pauseUntil, status, targetNetwork.id]);

  if (!INSTANT_BURNER_ENABLED || targetNetwork.id !== FAUCET_CHAIN_ID) {
    return null;
  }

  const enableEditing = () => {
    clearPublicHardhatBurnerKey(targetNetwork.id);
    setDismissed(false);
    setPauseUntil(undefined);
    setEditingSessionRequested(true);
    requestInstantBurnerDrip();
  };

  const disableEditing = () => {
    setEditingSessionRequested(false);
    setDismissed(true);
    setPauseUntil(undefined);
    disconnect();
  };

  if (
    shouldShowInstantBurnerEnable({
      enabled: INSTANT_BURNER_ENABLED,
      status,
      targetChainId: targetNetwork.id,
      faucetChainId: FAUCET_CHAIN_ID,
      address,
    })
  ) {
    return (
      <InstantBurnerToggle
        active={false}
        onClick={enableEditing}
        title="Use a free Sepolia wallet for promptless edits"
      />
    );
  }

  if (dismissed) {
    return null;
  }

  if (!address || chainId !== FAUCET_CHAIN_ID || !isBurnerConnector(connector)) {
    return null;
  }

  return (
    <InstantBurnerToggle
      active
      onClick={disableEditing}
      title="Turn off promptless edits from the free Sepolia wallet"
    />
  );
};
