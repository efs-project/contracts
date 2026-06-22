import * as chains from "viem/chains";
// Import the chain-id constant directly from the file (not the barrel) to avoid an import cycle.
import { DEVNET_CHAIN_ID } from "~~/utils/scaffold-eth/networkLabel";

export type ScaffoldConfig = {
  targetNetworks: readonly chains.Chain[];
  pollingInterval: number;
  alchemyApiKey: string;
  walletConnectProjectId: string;
  onlyLocalBurnerWallet: boolean;
};

export const DEFAULT_ALCHEMY_API_KEY = "IZYEU2cWBgnFmgiTAgpWD";

// The three EFS environments are now THREE DISTINCT wagmi chains (ADR-0062):
//   • Sepolia      11155111  — live testnet
//   • EFS Devnet    5318008  — shared community fork on the VPS (its own chain id, so a wallet
//                              can't confuse it with a contributor's local node)
//   • Local (hardhat) 31337  — a developer's `yarn fork`, only present when a node is around
// Each is a real, explicit, persisted choice in the NetworkSwitcher — never auto-selected.

// Devnet RPC: the VPS by default; override with NEXT_PUBLIC_DEVNET_RPC_URL.
export const DEFAULT_DEVNET_RPC_URL = "https://178.104.79.94.nip.io/rpc";

// Agents running a parallel hardhat node (e.g. on 8546) set NEXT_PUBLIC_HARDHAT_RPC_URL
// so wagmi clients AND the burner-connector both target the same node. The burner
// reads the chain object's rpcUrls directly, so overriding wagmiConfig's transport
// alone isn't enough — patch the hardhat chain here.
const HARDHAT_RPC_URL = (process.env.NEXT_PUBLIC_HARDHAT_RPC_URL ?? "").trim();
const hardhatChain: chains.Chain = HARDHAT_RPC_URL
  ? {
      ...chains.hardhat,
      rpcUrls: {
        default: { http: [HARDHAT_RPC_URL] },
      },
    }
  : chains.hardhat;

// `NEXT_PUBLIC_SEPOLIA_RPC_URL` overrides Sepolia's RPC the same way
// NEXT_PUBLIC_HARDHAT_RPC_URL overrides the fork's — leave unset to use viem's
// default + wagmiConfig's Alchemy fallback (see wagmiConfig.tsx → getAlchemyHttpUrl).
const SEPOLIA_RPC_URL = process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL;
const sepoliaChain: chains.Chain = SEPOLIA_RPC_URL
  ? {
      ...chains.sepolia,
      rpcUrls: {
        default: { http: [SEPOLIA_RPC_URL] },
      },
    }
  : chains.sepolia;

// The shared community devnet as a first-class chain. The metadata (name, nativeCurrency)
// is what an external wallet shows in its one-time `wallet_addEthereumChain` prompt.
const DEVNET_RPC_URL = (process.env.NEXT_PUBLIC_DEVNET_RPC_URL ?? "").trim() || DEFAULT_DEVNET_RPC_URL;
const efsDevnetChain: chains.Chain = {
  id: DEVNET_CHAIN_ID,
  name: "EFS Devnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [DEVNET_RPC_URL] } },
  testnet: true,
};

// Which network the UI defaults to (the chain reads run on before any wallet connects, and
// the network the store starts on — `targetNetworks[0]`). The SWITCHER's display order is
// independent of this (it sorts Sepolia → Devnet → Local; see NetworkSwitcher).
//
// `NEXT_PUBLIC_TARGET_CHAIN` is an explicit override that always wins. Accepts
// sepolia|11155111, devnet|5318008, local|hardhat|31337. Blank/whitespace counts as UNSET.
// Default by build type when unset: `next dev` → Local; `next build` (deployed) → Devnet
// (community testers land on the devnet; Sepolia is one click away). Set TARGET_CHAIN=sepolia
// for a public Sepolia-first SPA.
const TARGET_CHAIN = (process.env.NEXT_PUBLIC_TARGET_CHAIN ?? "").trim().toLowerCase();
const HARDHAT_RPC_CONFIGURED = HARDHAT_RPC_URL.length > 0;
// Local is only offered when a local node is plausibly present: a dev build, or an explicit
// hardhat RPC. A deployed public build never lists Local (nothing on the visitor's machine).
const LOCAL_AVAILABLE = process.env.NODE_ENV !== "production" || HARDHAT_RPC_CONFIGURED;

const RECOGNIZED = ["", "hardhat", "local", "31337", "sepolia", "11155111", "devnet", "5318008"];
if (!RECOGNIZED.includes(TARGET_CHAIN)) {
  console.warn(
    `[scaffold.config] Unrecognized NEXT_PUBLIC_TARGET_CHAIN="${TARGET_CHAIN}" — using the build default. Use one of: sepolia, devnet, local.`,
  );
}

const wantsSepolia = TARGET_CHAIN === "sepolia" || TARGET_CHAIN === "11155111";
const wantsDevnet = TARGET_CHAIN === "devnet" || TARGET_CHAIN === "5318008";
const wantsLocal = TARGET_CHAIN === "hardhat" || TARGET_CHAIN === "local" || TARGET_CHAIN === "31337";

// Available networks: Sepolia + Devnet always; Local only when a node is around.
const available: chains.Chain[] = [sepoliaChain, efsDevnetChain];
if (LOCAL_AVAILABLE) available.push(hardhatChain);

// Resolve the default (first) network. Explicit override wins (but falls back to Devnet if it
// asks for Local where Local isn't available); otherwise dev → Local, deployed → Devnet.
let defaultChain: chains.Chain = wantsSepolia
  ? sepoliaChain
  : wantsDevnet
    ? efsDevnetChain
    : wantsLocal
      ? hardhatChain
      : LOCAL_AVAILABLE
        ? hardhatChain
        : efsDevnetChain;
if (!available.includes(defaultChain)) defaultChain = efsDevnetChain;

// Default first (store init); the rest follow. Non-empty tuple — wagmi's createConfig requires it.
const targetNetworks = [defaultChain, ...available.filter(c => c !== defaultChain)] as [
  chains.Chain,
  ...chains.Chain[],
];

const scaffoldConfig = {
  // The networks on which your DApp is live
  targetNetworks,

  // The interval at which your front-end polls the RPC servers for new data
  // it has no effect if you only target the local network (default is 4000)
  pollingInterval: 30000,

  // This is ours Alchemy's default API key.
  // You can get your own at https://dashboard.alchemyapi.io
  // It's recommended to store it in an env variable:
  // .env.local for local testing, and in the Vercel/system env config for live apps.
  alchemyApiKey: process.env.NEXT_PUBLIC_ALCHEMY_API_KEY || DEFAULT_ALCHEMY_API_KEY,

  // This is ours WalletConnect's default project ID.
  // You can get your own at https://cloud.walletconnect.com
  // It's recommended to store it in an env variable:
  // .env.local for local testing, and in the Vercel/system env config for live apps.
  walletConnectProjectId: process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID || "3a8170812b534d0ff9d794f19a901d64",

  // Only show the Burner Wallet when running on hardhat network
  onlyLocalBurnerWallet: false,
} as const satisfies ScaffoldConfig;

export default scaffoldConfig;
