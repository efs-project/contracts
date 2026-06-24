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
  shouldClearInstantBurnerTrackingBeforeDisconnect,
  shouldClearStoredHardhatBurner,
  shouldDisconnectInstantBurner,
  shouldResetInstantBurnerDismissalOnAddressChange,
  shouldShowInstantBurnerEnable,
  shouldStopInstantBurnerAfterExternalDisconnect,
  shouldSuppressInstantBurnerTracking,
  trackInstantBurnerWasConnected,
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
    className={`inline-flex h-9 w-auto shrink-0 items-center gap-1 rounded-full border px-2 text-left shadow-[0_0_16px_rgba(0,255,76,0.16)] transition-colors sm:gap-1.5 lg:h-10 lg:px-2.5 ${
      active
        ? "border-primary bg-primary/20 text-primary hover:bg-primary/25"
        : "border-primary/65 bg-primary/10 text-primary hover:border-primary hover:bg-primary/15"
    }`}
    type="button"
    onClick={onClick}
    title={title}
    aria-label="Easy Edits. No prompts."
    aria-pressed={active}
  >
    <span className="flex flex-col justify-center leading-none">
      <span className="whitespace-nowrap text-[11px] font-semibold leading-[1.05]">
        <span className="sm:hidden">Edits</span>
        <span className="hidden sm:inline">Easy Edits</span>
      </span>
      <span className="mt-1 hidden whitespace-nowrap text-[9px] leading-[1.05] text-base-content/60 sm:block">
        No prompts
      </span>
    </span>
    <span
      className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${
        active ? "border-primary bg-primary" : "border-primary/60 bg-primary/10"
      }`}
      aria-hidden="true"
    >
      <span
        className={`absolute left-0.5 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full shadow transition-transform ${
          active ? "translate-x-4 bg-[#07120b]" : "translate-x-0 bg-primary"
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
    const shouldDisconnect = shouldDisconnectInstantBurner({
      activeConnectorId: connector?.id,
      editingSessionRequested,
      chainId,
      targetChainId: targetNetwork.id,
      faucetChainId: FAUCET_CHAIN_ID,
    });
    if (!shouldDisconnect) {
      return;
    }
    if (disconnectingBurnerRef.current) return;
    if (
      shouldClearInstantBurnerTrackingBeforeDisconnect({
        activeConnectorId: connector?.id,
        shouldDisconnect,
      })
    ) {
      burnerWasConnectedRef.current = trackInstantBurnerWasConnected({
        current: burnerWasConnectedRef.current,
        status,
        chainId,
        faucetChainId: FAUCET_CHAIN_ID,
        activeConnectorId: connector?.id,
        disablingInstantBurner: true,
      });
    }
    disconnectingBurnerRef.current = true;
    disconnect(undefined, {
      onSettled: () => {
        disconnectingBurnerRef.current = false;
      },
    });
  }, [chainId, connector?.id, editingSessionRequested, disconnect, status, targetNetwork.id]);

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
    burnerWasConnectedRef.current = trackInstantBurnerWasConnected({
      current: burnerWasConnectedRef.current,
      status,
      chainId,
      faucetChainId: FAUCET_CHAIN_ID,
      activeConnectorId: connector?.id,
      disablingInstantBurner: shouldSuppressInstantBurnerTracking({
        activeConnectorId: connector?.id,
        editingSessionRequested,
        intentionalDisconnectInProgress: disconnectingBurnerRef.current,
      }),
    });
  }, [chainId, connector?.id, editingSessionRequested, status]);

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
    burnerWasConnectedRef.current = trackInstantBurnerWasConnected({
      current: burnerWasConnectedRef.current,
      status,
      chainId,
      faucetChainId: FAUCET_CHAIN_ID,
      activeConnectorId: connector?.id,
      disablingInstantBurner: true,
    });
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
