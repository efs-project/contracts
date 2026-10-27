import { wagmiConnectors } from "./wagmiConnectors";
import { Chain, createClient, fallback, http } from "viem";
import { hardhat, mainnet } from "viem/chains";
import { createConfig } from "wagmi";
import scaffoldConfig from "~~/scaffold.config";
import { createPageLoadWalletTracker, getPreferredRpcUrls } from "~~/utils/scaffold-eth";

const { targetNetworks } = scaffoldConfig;

// We always want to have mainnet enabled (ENS resolution, ETH price, etc). But only once.
export const enabledChains = targetNetworks.find((network: Chain) => network.id === 1)
  ? targetNetworks
  : ([...targetNetworks, mainnet] as const);

export const wagmiConfig = createConfig({
  chains: enabledChains,
  connectors: wagmiConnectors,
  ssr: true,
  client({ chain }) {
    // Same endpoint order as the burner wallet's writes (explicit NEXT_PUBLIC_*_RPC_URL
    // override, else Alchemy, then the chain's public RPCs), so reads and writes hit the same
    // node. The hardhat chain is patched in `scaffold.config.ts` to honour
    // NEXT_PUBLIC_HARDHAT_RPC_URL. See AGENTS.md → "Running alongside another project".
    const rpcFallbacks = getPreferredRpcUrls(chain).map(url => http(url));

    return createClient({
      chain,
      transport: fallback(rpcFallbacks),
      ...(chain.id !== (hardhat as Chain).id
        ? {
            pollingInterval: scaffoldConfig.pollingInterval,
          }
        : {}),
    });
  },
});

/** Page-load reconnect state: when wagmi has finished restoring wallets, and which one was last active. */
export const pageLoadWallet = createPageLoadWalletTracker(wagmiConfig);
