import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  coinbaseWallet,
  ledgerWallet,
  metaMaskWallet,
  rainbowWallet,
  safeWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { rainbowkitBurnerWallet } from "burner-connector";
import * as chains from "viem/chains";
import scaffoldConfig from "~~/scaffold.config";
import { HARDHAT_ACCOUNTS } from "~~/utils/scaffold-eth/hardhatAccounts";

// Polyfill indexedDB for server-side build/prerendering
if (typeof window === "undefined" && !global.indexedDB) {
  const mockDB = {
    createObjectStore: () => {},
    transaction: () => ({
      objectStore: () => ({
        get: () => ({
          set onsuccess(cb: any) {
            if (cb) cb({ target: { result: null } });
          },
        }),
        put: () => ({
          set onsuccess(cb: any) {
            if (cb) cb({ target: { result: null } });
          },
        }),
        add: () => ({
          set onsuccess(cb: any) {
            if (cb) cb({ target: { result: null } });
          },
        }),
        delete: () => ({
          set onsuccess(cb: any) {
            if (cb) cb({ target: { result: null } });
          },
        }),
        clear: () => ({
          set onsuccess(cb: any) {
            if (cb) cb({ target: { result: null } });
          },
        }),
        getAll: () => ({
          set onsuccess(cb: any) {
            if (cb) cb({ target: { result: [] } });
          },
        }),
      }),
    }),
  };
  global.indexedDB = {
    open: () => ({
      result: mockDB,
      set onupgradeneeded(cb: any) {
        if (cb) cb({ target: { result: mockDB } });
      },
      set onsuccess(cb: any) {
        if (cb) cb({ target: { result: mockDB } });
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  } as any;
}

const { onlyLocalBurnerWallet, targetNetworks } = scaffoldConfig;

// Seed the burner wallet with a pre-funded hardhat account on first visit, so the
// dev UI is usable immediately without clicking the faucet. Only runs when hardhat
// is a target network and no PK has been stored yet — subsequent visits keep the
// account the user last switched to via DevWalletSwitcher.
if (typeof window !== "undefined" && targetNetworks.some(n => n.id === (chains.hardhat as chains.Chain).id)) {
  const existing = window.localStorage.getItem("burnerWallet.pk")?.replaceAll('"', "");
  if (!existing || existing === "0x" || existing.length < 66) {
    const pick = HARDHAT_ACCOUNTS[Math.floor(Math.random() * HARDHAT_ACCOUNTS.length)];
    window.localStorage.setItem("burnerWallet.pk", pick.pk);
  }
}

const wallets = [
  metaMaskWallet,
  walletConnectWallet,
  ledgerWallet,
  coinbaseWallet,
  rainbowWallet,
  safeWallet,
  ...(!targetNetworks.some(network => network.id !== (chains.hardhat as chains.Chain).id) || !onlyLocalBurnerWallet
    ? typeof window !== "undefined"
      ? [rainbowkitBurnerWallet]
      : []
    : []),
];

/**
 * wagmi connectors for the wagmi context
 */
export const wagmiConnectors = connectorsForWallets(
  [
    {
      groupName: "Supported Wallets",
      wallets,
    },
  ],

  {
    appName: "scaffold-eth-2",
    projectId: scaffoldConfig.walletConnectProjectId,
  },
);
