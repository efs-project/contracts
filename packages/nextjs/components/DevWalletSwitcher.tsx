"use client";

import { useEffect, useState } from "react";
import { hardhat } from "viem/chains";
import { useConnect, useConnectors, useDisconnect } from "wagmi";
import { ClipboardDocumentCheckIcon, ClipboardDocumentIcon } from "@heroicons/react/24/outline";
import { useTargetNetwork } from "~~/hooks/scaffold-eth";
import { HARDHAT_ACCOUNTS } from "~~/utils/scaffold-eth/hardhatAccounts";

export const DevWalletSwitcher = () => {
  const { targetNetwork } = useTargetNetwork();
  const [mounted, setMounted] = useState(false);
  const [activeAddress, setActiveAddress] = useState<string | null>(null);
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const { disconnect } = useDisconnect();
  const { connect } = useConnect();
  const connectors = useConnectors();

  useEffect(() => {
    setMounted(true);
    // Find active address from local storage PK
    if (typeof window !== "undefined") {
      const storedPk = window.localStorage.getItem("burnerWallet.pk")?.replaceAll('"', "") ?? "0x";
      const account = HARDHAT_ACCOUNTS.find(acc => acc.pk === storedPk);
      if (account) {
        setActiveAddress(account.address);
      }
    }
  }, []);

  if (!mounted || targetNetwork.id !== hardhat.id) {
    return null;
  }

  const copyAddress = (address: string) => {
    navigator.clipboard.writeText(address).then(() => {
      setCopiedAddress(address);
      setTimeout(() => setCopiedAddress(null), 1500);
    });
  };

  const switchAccount = (pk: string) => {
    if (typeof window === "undefined") return;
    const account = HARDHAT_ACCOUNTS.find(acc => acc.pk === pk);
    window.localStorage.setItem("burnerWallet.pk", pk);
    setActiveAddress(account?.address ?? null);
    // Reconnect burner connector so wagmi picks up the new PK from localStorage
    const burnerConnector = connectors.find(c => c.id === "burnerWallet");
    if (burnerConnector) {
      disconnect(undefined, {
        onSettled: () => connect({ connector: burnerConnector }),
      });
    }
  };

  return (
    <div className="dropdown dropdown-end">
      <label tabIndex={0} className="btn btn-secondary btn-sm shadow-md rounded-full px-4 ml-2 max-w-xs">
        {activeAddress ? `Dev: ${HARDHAT_ACCOUNTS.find(a => a.address === activeAddress)?.name}` : "Dev Wallets"}
      </label>
      <ul
        tabIndex={0}
        className="dropdown-content menu p-2 mt-2 shadow-center shadow-accent bg-base-200 rounded-box w-56 z-[100] max-h-[70vh] flex-nowrap overflow-y-auto"
      >
        <li className="menu-title px-4 py-2 text-sm sticky top-0 bg-base-200 z-10">Switch Burner Wallet</li>
        {HARDHAT_ACCOUNTS.map(account => (
          <li key={account.address}>
            <div
              className={`flex items-center justify-between gap-1 px-2 py-1 rounded-lg cursor-pointer text-sm ${
                activeAddress === account.address ? "bg-secondary" : "hover:bg-base-300"
              }`}
            >
              <span className="flex-1 min-w-0" onClick={() => switchAccount(account.pk)}>
                <span className="block">{account.name}</span>
                <span className="text-xs opacity-50">
                  {account.address.slice(0, 6)}...{account.address.slice(-4)}
                </span>
              </span>
              <button
                className="btn btn-ghost btn-xs p-0.5 opacity-50 hover:opacity-100 flex-shrink-0"
                onClick={e => {
                  e.stopPropagation();
                  copyAddress(account.address);
                }}
                title="Copy address"
              >
                {copiedAddress === account.address ? (
                  <ClipboardDocumentCheckIcon className="w-4 h-4 text-success" />
                ) : (
                  <ClipboardDocumentIcon className="w-4 h-4" />
                )}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
};
