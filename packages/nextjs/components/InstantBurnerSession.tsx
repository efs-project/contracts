"use client";

import { useEffect, useRef, useState } from "react";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { Address, formatEther } from "viem";
import { useAccount, useBalance, useConnect, useConnectors, useDisconnect } from "wagmi";
import { WalletIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useTargetNetwork } from "~~/hooks/scaffold-eth";
import {
  FAUCET_CHAIN_ID,
  FAUCET_URL,
  INSTANT_BURNER_PAUSE_MS,
  getInstantBurnerMessage,
  isBurnerConnector,
  isInstantBurnerSessionEnabled,
  shouldAutoConnectInstantBurner,
  shouldDisconnectInstantBurner,
  shouldResumeInstantBurnerAfterRealWalletModal,
  useFaucetStatus,
} from "~~/utils/scaffold-eth";

const INSTANT_BURNER_ENABLED = isInstantBurnerSessionEnabled({
  faucetUrl: FAUCET_URL,
  flag: process.env.NEXT_PUBLIC_INSTANT_BURNER_SESSION,
});

const shortAddress = (address: string) => `${address.slice(0, 6)}...${address.slice(-4)}`;

const messageClass = {
  funding: "text-info",
  ready: "text-success",
  waiting: "text-base-content/60",
  error: "text-warning",
} as const;

export const InstantBurnerSession = () => {
  const { address, chainId, connector, status } = useAccount();
  const connectors = useConnectors();
  const { connect } = useConnect();
  const { disconnect } = useDisconnect();
  const { targetNetwork } = useTargetNetwork();
  const { connectModalOpen, openConnectModal } = useConnectModal();
  const faucetStatus = useFaucetStatus();
  const { data: balance } = useBalance({
    address: address as Address | undefined,
    chainId: FAUCET_CHAIN_ID,
    query: { enabled: !!address && chainId === FAUCET_CHAIN_ID },
  });

  const [dismissed, setDismissed] = useState(false);
  const [pauseUntil, setPauseUntil] = useState<number | undefined>(undefined);
  const [waitingForRealWallet, setWaitingForRealWallet] = useState(false);
  const connectingBurnerRef = useRef(false);
  const disconnectingBurnerRef = useRef(false);
  const openedRealWalletModalRef = useRef(false);
  const realWalletModalWasOpenRef = useRef(false);

  useEffect(() => {
    setDismissed(false);
  }, [address]);

  useEffect(() => {
    if (!INSTANT_BURNER_ENABLED) return;
    if (
      !shouldDisconnectInstantBurner({
        activeConnectorId: connector?.id,
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
  }, [chainId, connector?.id, disconnect, targetNetwork.id]);

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
        status,
        targetChainId: targetNetwork.id,
        faucetChainId: FAUCET_CHAIN_ID,
        activeConnectorId: connector?.id,
        pausedUntil: pauseUntil,
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
  }, [connect, connector?.id, connectors, pauseUntil, status, targetNetwork.id]);

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

  if (
    !INSTANT_BURNER_ENABLED ||
    dismissed ||
    !address ||
    chainId !== FAUCET_CHAIN_ID ||
    targetNetwork.id !== FAUCET_CHAIN_ID ||
    !isBurnerConnector(connector)
  ) {
    return null;
  }

  const message = getInstantBurnerMessage({
    pendingHash: faucetStatus.pendingHash,
    balanceValue: balance?.value,
    errorMessage: faucetStatus.errorMessage,
  });
  const balanceLabel = balance ? `${Number(formatEther(balance.value)).toFixed(4)} ETH` : "balance...";

  const connectRealWallet = () => {
    setPauseUntil(Date.now() + INSTANT_BURNER_PAUSE_MS);
    setWaitingForRealWallet(true);
    disconnect();
  };

  return (
    <div
      className="hidden lg:flex items-center gap-2 max-w-[34rem] rounded-full border border-info/30 bg-info/10 px-2 py-1 text-xs text-base-content shadow-sm"
      title="Disposable Sepolia demo wallet funded by the faucet"
    >
      <WalletIcon className="h-4 w-4 shrink-0 text-info" />
      <div className="min-w-0">
        <div className="uppercase tracking-normal text-[0.62rem] leading-3 text-base-content/60">
          temporary demo wallet
        </div>
        <div className="flex min-w-0 items-center gap-2 leading-4">
          <span className="font-mono truncate">{shortAddress(address)}</span>
          <span className={`shrink-0 ${messageClass[message.tone]}`}>{message.label}</span>
          <span className="shrink-0 text-base-content/70">{balanceLabel}</span>
        </div>
      </div>
      <button
        className="btn btn-primary btn-xs rounded-full whitespace-nowrap"
        type="button"
        onClick={connectRealWallet}
      >
        Connect your own wallet
      </button>
      <button
        className="btn btn-ghost btn-xs btn-circle"
        type="button"
        aria-label="Dismiss demo wallet status"
        onClick={() => setDismissed(true)}
      >
        <XMarkIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
};
