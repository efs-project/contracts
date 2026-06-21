import * as chains from "viem/chains";

export type ScaffoldConfig = {
  targetNetworks: readonly chains.Chain[];
  pollingInterval: number;
  alchemyApiKey: string;
  walletConnectProjectId: string;
  onlyLocalBurnerWallet: boolean;
};

export const DEFAULT_ALCHEMY_API_KEY = "IZYEU2cWBgnFmgiTAgpWD";

// Agents running a parallel hardhat node (e.g. on 8546) set NEXT_PUBLIC_HARDHAT_RPC_URL
// so wagmi clients AND the burner-connector both target the same node. The burner
// reads the chain object's rpcUrls directly, so overriding wagmiConfig's transport
// alone isn't enough — patch the hardhat chain here.
const HARDHAT_RPC_URL = process.env.NEXT_PUBLIC_HARDHAT_RPC_URL;
const hardhatChain: chains.Chain = HARDHAT_RPC_URL
  ? {
      ...chains.hardhat,
      rpcUrls: {
        default: { http: [HARDHAT_RPC_URL] },
      },
    }
  : chains.hardhat;

// EFS is live on Sepolia (chainId 11155111); the local `yarn fork` runs a hardhat
// Sepolia fork (chainId 31337). The debug UI ships BOTH so a user can read/write
// against either and flip at runtime via the header NetworkSwitcher.
//
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

// Which network the UI defaults to (the chain reads run on before any wallet
// connects, and the network the store starts on). Accepts "hardhat"/"local"/"31337"
// or "sepolia"/"11155111".
//
// The default keys off the BUILD TYPE so each audience just works with zero config:
//   • `next dev` (NODE_ENV=development) → hardhat — paired with the local `yarn preview`
//     fork that dev already runs. No env var, no script change.
//   • `next build` static SPA (NODE_ENV=production) → Sepolia — a deployed SPA has no
//     local node, so it talks to the live chain (no dedicated RPC needed; falls back to
//     the shared scaffold Alchemy key / public RPC, overridable via NEXT_PUBLIC_*).
//
// `NEXT_PUBLIC_TARGET_CHAIN` is an explicit override that always wins — e.g. a production
// build pointed at a VPS hardhat-fork sets it to "hardhat". The runtime switcher works
// either way. (Supersedes the earlier hardhat-always default — see docs/decisions.md.)
//
// A blank/whitespace override counts as UNSET (a copied `.env`/hosting config often ships an empty
// `NEXT_PUBLIC_TARGET_CHAIN=`). `??` only catches null/undefined, not "", so coalesce explicitly —
// otherwise a prod SPA with a blank value would wrongly start on hardhat. (Codex P2.)
const TARGET_CHAIN_OVERRIDE = (process.env.NEXT_PUBLIC_TARGET_CHAIN ?? "").trim().toLowerCase();
const TARGET_CHAIN = TARGET_CHAIN_OVERRIDE || (process.env.NODE_ENV === "production" ? "sepolia" : "hardhat");
const defaultIsSepolia = TARGET_CHAIN === "sepolia" || TARGET_CHAIN === "11155111";

const RECOGNIZED = ["", "hardhat", "local", "31337", "sepolia", "11155111"];
if (!RECOGNIZED.includes(TARGET_CHAIN)) {
  console.warn(
    `[scaffold.config] Unrecognized NEXT_PUBLIC_TARGET_CHAIN="${TARGET_CHAIN}" — defaulting to hardhat. Use one of: hardhat, sepolia.`,
  );
}

// First entry is the default (store inits to targetNetworks[0]). Both chains are
// always present, so the runtime switcher and wallet-driven sync work either way.
// `as const` keeps this a non-empty tuple — wagmi's createConfig requires that.
const targetNetworks = defaultIsSepolia
  ? ([sepoliaChain, hardhatChain] as const)
  : ([hardhatChain, sepoliaChain] as const);

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
