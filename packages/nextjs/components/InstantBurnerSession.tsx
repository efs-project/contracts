"use client";

import { useEffect, useRef, useState } from "react";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { hardhat } from "viem/chains";
import { useAccount, useConnect, useConnectors, useDisconnect } from "wagmi";
import { WalletIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useTargetNetwork } from "~~/hooks/scaffold-eth";
import scaffoldConfig from "~~/scaffold.config";
import {
  BURNER_WALLET_PK_STORAGE_KEY,
  FAUCET_CHAIN_ID,
  FAUCET_URL,
  INSTANT_BURNER_PAUSE_MS,
  isBurnerConnector,
  isInstantBurnerSessionEnabled,
  normalizeStoredBurnerPrivateKey,
  requestInstantBurnerDrip,
  shouldAutoConnectInstantBurner,
  shouldClearStoredHardhatBurner,
  shouldDisconnectInstantBurner,
  shouldResetInstantBurnerDismissalOnAddressChange,
  shouldResumeInstantBurnerAfterRealWalletModal,
  shouldShowInstantBurnerEnable,
} from "~~/utils/scaffold-eth";
import { HARDHAT_ACCOUNTS } from "~~/utils/scaffold-eth/hardhatAccounts";

const INSTANT_BURNER_ENABLED = isInstantBurnerSessionEnabled({
  faucetUrl: FAUCET_URL,
  flag: process.env.NEXT_PUBLIC_INSTANT_BURNER_SESSION,
  defaultChainId: scaffoldConfig.targetNetworks[0].id,
  faucetChainId: FAUCET_CHAIN_ID,
});

const hardhatPrivateKeys = HARDHAT_ACCOUNTS.map(account => account.pk);

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
  const { connectModalOpen, openConnectModal } = useConnectModal();

  const [dismissed, setDismissed] = useState(false);
  const [editingSessionRequested, setEditingSessionRequested] = useState(false);
  const [pauseUntil, setPauseUntil] = useState<number | undefined>(undefined);
  const [waitingForRealWallet, setWaitingForRealWallet] = useState(false);
  const connectingBurnerRef = useRef(false);
  const disconnectingBurnerRef = useRef(false);
  const openedRealWalletModalRef = useRef(false);
  const realWalletModalWasOpenRef = useRef(false);
  const previousAddressRef = useRef<string | undefined>(undefined);
  const realWalletFlowActive = waitingForRealWallet || connectModalOpen || openedRealWalletModalRef.current;

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
      openedRealWalletModalRef.current = false;
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
    if (!INSTANT_BURNER_ENABLED) return;
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
        realWalletFlowActive,
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
  }, [
    connect,
    connector?.id,
    connectors,
    dismissed,
    editingSessionRequested,
    pauseUntil,
    realWalletFlowActive,
    status,
    targetNetwork.id,
  ]);

  useEffect(() => {
    if (!waitingForRealWallet) return;
    if (status !== "disconnected" || !openConnectModal) return;
    openedRealWalletModalRef.current = true;
    realWalletModalWasOpenRef.current = false;
    openConnectModal();
    setWaitingForRealWallet(false);
  }, [openConnectModal, status, waitingForRealWallet]);

  useEffect(() => {
    if (connectModalOpen) {
      realWalletModalWasOpenRef.current = true;
      return;
    }
    if (
      !shouldResumeInstantBurnerAfterRealWalletModal({
        requestedRealWallet: openedRealWalletModalRef.current,
        modalWasOpen: realWalletModalWasOpenRef.current,
        connectModalOpen,
        status,
      })
    ) {
      return;
    }
    openedRealWalletModalRef.current = false;
    realWalletModalWasOpenRef.current = false;
    setPauseUntil(undefined);
  }, [connectModalOpen, status]);

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
      <button
        className="hidden lg:inline-flex btn btn-primary btn-sm rounded-full whitespace-nowrap shadow-md gap-2 px-4"
        type="button"
        onClick={enableEditing}
        title="Use a free Sepolia wallet for promptless edits"
      >
        <WalletIcon className="h-4 w-4" />
        Enable promptless edits
      </button>
    );
  }

  if (dismissed) {
    return null;
  }

  if (!address || chainId !== FAUCET_CHAIN_ID || !isBurnerConnector(connector)) {
    return null;
  }

  const connectRealWallet = () => {
    setPauseUntil(Date.now() + INSTANT_BURNER_PAUSE_MS);
    setWaitingForRealWallet(true);
    disconnect();
  };

  return (
    <div
      className="hidden lg:flex items-center gap-2 rounded-full border border-info/30 bg-info/10 px-2 py-1 text-xs text-base-content shadow-sm"
      title="Promptless edits are using a free Sepolia wallet"
    >
      <WalletIcon className="h-4 w-4 shrink-0 text-info" />
      <span className="whitespace-nowrap font-medium text-base-content/80">Promptless edits on</span>
      <button
        className="btn btn-primary btn-xs rounded-full whitespace-nowrap"
        type="button"
        onClick={connectRealWallet}
      >
        Use own wallet
      </button>
      <button
        className="btn btn-ghost btn-xs btn-circle"
        type="button"
        aria-label="Dismiss wallet status"
        onClick={() => setDismissed(true)}
      >
        <XMarkIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
};
