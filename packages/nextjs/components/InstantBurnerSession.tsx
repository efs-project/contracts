"use client";

import { useEffect, useRef, useState } from "react";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { hardhat } from "viem/chains";
import { useAccount, useConnect, useConnectors, useDisconnect } from "wagmi";
import { WalletIcon } from "@heroicons/react/24/outline";
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

const InstantBurnerToggle = ({ active, onClick, title }: { active: boolean; onClick: () => void; title: string }) => (
  <button
    className={`hidden h-9 w-[7.25rem] shrink-0 items-center gap-2 rounded-full border px-2.5 text-left shadow-sm transition-colors lg:inline-flex ${
      active
        ? "border-primary/50 bg-primary/15 text-base-content hover:bg-primary/20"
        : "border-base-content/15 bg-base-200/70 text-base-content hover:border-primary/50 hover:bg-primary/10"
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
      className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${active ? "bg-primary" : "bg-base-300"}`}
      aria-hidden="true"
    >
      <span
        className={`absolute top-0.5 h-3 w-3 rounded-full bg-base-100 shadow transition-all ${
          active ? "left-[0.875rem]" : "left-0.5"
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

  const connectRealWallet = () => {
    setPauseUntil(Date.now() + INSTANT_BURNER_PAUSE_MS);
    setWaitingForRealWallet(true);
    disconnect();
  };

  return (
    <div className="hidden lg:flex items-center gap-1.5">
      <InstantBurnerToggle
        active
        onClick={disableEditing}
        title="Turn off promptless edits from the free Sepolia wallet"
      />
      <button
        className="hidden h-8 shrink-0 items-center gap-1 rounded-full border border-base-content/15 px-2 text-[10px] font-medium leading-none text-base-content/75 transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-base-content whitespace-nowrap min-[1536px]:inline-flex"
        type="button"
        onClick={connectRealWallet}
        title="Connect your own wallet instead"
      >
        <WalletIcon className="h-3.5 w-3.5" />
        <span>Own wallet</span>
      </button>
    </div>
  );
};
