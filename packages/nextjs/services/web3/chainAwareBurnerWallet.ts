import { createConnector, normalizeChainId } from "@wagmi/core";
import {
  BaseError,
  RpcRequestError,
  SwitchChainError,
  createWalletClient,
  custom,
  fallback,
  fromHex,
  getAddress,
  http,
} from "viem";
import type { Chain, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getHttpRpcClient, hexToBigInt, hexToNumber, numberToHex } from "viem/utils";
import scaffoldConfig from "~~/scaffold.config";
import {
  BURNER_WALLET_CONNECTOR_ID,
  BURNER_WALLET_PK_STORAGE_KEY,
  selectBurnerChain,
} from "~~/utils/scaffold-eth/instantBurner";
import { getAlchemyHttpUrl } from "~~/utils/scaffold-eth/networks";

export class BurnerConnectorNotConnectedError extends BaseError {
  override name = "BurnerConnectorNotConnectedError";

  constructor() {
    super("Burner connector not connected.");
  }
}

export class BurnerChainNotConfiguredError extends BaseError {
  override name = "BurnerChainNotConfiguredError";

  constructor(chainId?: number) {
    super(chainId === undefined ? "Burner chain not configured." : `Burner chain ${chainId} is not configured.`);
  }
}

const BURNER_WALLET_NAME = "Burner Wallet";
const burnerWalletIconUrl =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23ffd84d'/%3E%3Cpath fill='%23ff6a00' d='M32 54c-11 0-19-8-19-18 0-9 5-15 13-22 0 7 4 10 8 13 3-5 4-11 3-17 8 6 14 14 14 25 0 11-8 19-19 19z'/%3E%3Cpath fill='%2307120b' d='M32 49c-5 0-9-4-9-9 0-4 2-7 6-11 0 4 2 6 5 8 2-3 2-6 2-9 4 4 6 8 6 13 0 5-4 8-10 8z'/%3E%3C/svg%3E";

function burnerStorage(useSessionStorage: boolean): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  return useSessionStorage ? window.sessionStorage : window.localStorage;
}

function normalizeBurnerPrivateKey(pk: string | undefined): Hex | undefined {
  if (!pk) return undefined;
  if (pk.length === 66 && pk.startsWith("0x")) return pk as Hex;
  if (pk.length === 64) return `0x${pk}`;
  return undefined;
}

function loadBurnerPrivateKey({ useSessionStorage = false }: { useSessionStorage?: boolean } = {}): Hex {
  const storage = burnerStorage(useSessionStorage);
  const current = storage?.getItem(BURNER_WALLET_PK_STORAGE_KEY)?.replaceAll('"', "") ?? "0x";
  const normalized = normalizeBurnerPrivateKey(current);
  if (normalized) return normalized;

  const generated = generatePrivateKey();
  storage?.setItem(BURNER_WALLET_PK_STORAGE_KEY, generated);
  return generated;
}

type JsonRpcParams = readonly unknown[];

type ProviderRequest = {
  method: string;
  params?: JsonRpcParams;
};

type SwitchEthereumChainParams = {
  chainId: Hex;
};

type Eip1193Transaction = {
  data?: Hex;
  to?: Hex;
  value?: Hex;
  gas?: Hex;
  nonce?: Hex;
  maxPriorityFeePerGas?: Hex;
  maxFeePerGas?: Hex;
};

const burnerTargetChainIds = new Set(scaffoldConfig.targetNetworks.map(chain => chain.id));

function configuredChain(chains: readonly Chain[], chainId: number): Chain {
  const chain = chains.find(chain => chain.id === chainId);
  if (!chain) throw new SwitchChainError(new BurnerChainNotConfiguredError(chainId));
  return chain;
}

function addUniqueRpcUrl(urls: string[], url: string | undefined) {
  if (url && !urls.includes(url)) urls.push(url);
}

function hasExplicitRpcOverride(chainRpcUrls: readonly string[]): boolean {
  const explicitUrls = [
    process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL,
    process.env.NEXT_PUBLIC_DEVNET_RPC_URL,
    process.env.NEXT_PUBLIC_HARDHAT_RPC_URL,
  ]
    .map(url => url?.trim())
    .filter((url): url is string => !!url);

  return chainRpcUrls.some(url => explicitUrls.includes(url));
}

export function getBurnerRpcUrls(chain: Chain): readonly string[] {
  const urls: string[] = [];
  const chainRpcUrls = chain.rpcUrls.default.http;
  const alchemyUrl = getAlchemyHttpUrl(chain.id);

  if (hasExplicitRpcOverride(chainRpcUrls)) {
    for (const url of chainRpcUrls) addUniqueRpcUrl(urls, url);
    addUniqueRpcUrl(urls, alchemyUrl);
  } else {
    addUniqueRpcUrl(urls, alchemyUrl);
    for (const url of chainRpcUrls) addUniqueRpcUrl(urls, url);
  }

  return urls;
}

function burnerTransport(chain: Chain) {
  const urls = getBurnerRpcUrls(chain);
  if (urls.length === 0) throw new Error(`No RPC URL found for burner chain ${chain.id}.`);
  const transports = urls.map(url => http(url));
  return transports.length === 1 ? transports[0] : fallback(transports);
}

function chainRpcUrl(chain: Chain): string {
  const url = getBurnerRpcUrls(chain)[0];
  if (!url) throw new Error(`No RPC URL found for burner chain ${chain.id}.`);
  return url;
}

export const chainAwareBurner = ({ useSessionStorage = false }: { useSessionStorage?: boolean } = {}) => {
  let connected = true;
  let connectedChainId: number | undefined;

  return createConnector(config => {
    const burnerChains = () => config.chains.filter(chain => burnerTargetChainIds.has(chain.id));
    const resolveChain = (requestedChainId?: number) =>
      selectBurnerChain({
        chains: burnerChains(),
        requestedChainId,
        connectedChainId,
      });

    return {
      id: BURNER_WALLET_CONNECTOR_ID,
      name: BURNER_WALLET_NAME,
      type: BURNER_WALLET_CONNECTOR_ID,

      async connect({ chainId } = {}) {
        const chain = resolveChain(chainId);
        connectedChainId = chain.id;
        connected = true;

        const provider = await this.getProvider({ chainId: chain.id });
        const accounts = await (provider as { request: (args: { method: "eth_accounts" }) => Promise<Hex[]> }).request({
          method: "eth_accounts",
        });
        return { accounts, chainId: chain.id };
      },

      async getProvider({ chainId } = {}) {
        const burnerAccount = privateKeyToAccount(loadBurnerPrivateKey({ useSessionStorage }));
        let providerChainId = chainId === undefined ? undefined : resolveChain(chainId).id;

        const activeChain = () => resolveChain(connectedChainId ?? providerChainId);

        const request = async ({ method, params = [] }: ProviderRequest) => {
          if (method === "eth_accounts") {
            return [burnerAccount.address];
          }

          if (method === "eth_chainId") {
            return numberToHex(activeChain().id);
          }

          if (method === "wallet_switchEthereumChain") {
            const switchParams = params[0] as SwitchEthereumChainParams | undefined;
            if (!switchParams?.chainId) throw new SwitchChainError(new BurnerChainNotConfiguredError());
            const nextChainId = fromHex(switchParams.chainId, "number");
            const nextChain = configuredChain(burnerChains(), nextChainId);
            providerChainId = nextChain.id;
            connectedChainId = nextChain.id;
            config.emitter.emit("change", { chainId: nextChain.id });
            return;
          }

          const chain = activeChain();
          const client = createWalletClient({
            chain,
            account: burnerAccount,
            transport: burnerTransport(chain),
          });

          if (method === "eth_sendTransaction") {
            const actualParams = params[0] as Eip1193Transaction | undefined;
            return client.sendTransaction({
              account: burnerAccount,
              data: actualParams?.data,
              to: actualParams?.to,
              value: actualParams?.value ? hexToBigInt(actualParams.value) : undefined,
              gas: actualParams?.gas ? hexToBigInt(actualParams.gas) : undefined,
              nonce: actualParams?.nonce ? hexToNumber(actualParams.nonce) : undefined,
              maxPriorityFeePerGas: actualParams?.maxPriorityFeePerGas
                ? hexToBigInt(actualParams.maxPriorityFeePerGas)
                : undefined,
              maxFeePerGas: actualParams?.maxFeePerGas ? hexToBigInt(actualParams.maxFeePerGas) : undefined,
            });
          }

          if (method === "personal_sign") {
            return client.signMessage({
              account: burnerAccount,
              message: { raw: params[0] as Hex },
            });
          }

          if (method === "eth_signTypedData_v4") {
            return client.signTypedData(JSON.parse(params[1] as string));
          }

          const body = { method, params };
          const url = chainRpcUrl(chain);
          const httpClient = getHttpRpcClient(url);
          const { error, result } = await httpClient.request({ body });
          if (error) throw new RpcRequestError({ body, error, url });
          return result;
        };

        return custom({ request })({ retryCount: 0 });
      },

      onChainChanged(chain) {
        const chainId = normalizeChainId(chain);
        const nextChain = configuredChain(burnerChains(), chainId);
        connectedChainId = nextChain.id;
        config.emitter.emit("change", { chainId: nextChain.id });
      },

      async getAccounts() {
        if (!connected) throw new BurnerConnectorNotConnectedError();
        const provider = await this.getProvider();
        const accounts = await (provider as { request: (args: { method: "eth_accounts" }) => Promise<Hex[]> }).request({
          method: "eth_accounts",
        });
        return accounts.map((account: Hex) => getAddress(account));
      },

      async onDisconnect() {
        connected = false;
        config.emitter.emit("disconnect");
      },

      async getChainId() {
        return resolveChain().id;
      },

      async isAuthorized() {
        if (!connected) return false;
        const accounts = await this.getAccounts();
        return accounts.length > 0;
      },

      onAccountsChanged(accounts) {
        if (accounts.length === 0) {
          this.onDisconnect();
          return;
        }
        config.emitter.emit("change", {
          accounts: accounts.map(account => getAddress(account)),
        });
      },

      async switchChain({ chainId }) {
        const chain = configuredChain(burnerChains(), chainId);
        connectedChainId = chain.id;
        config.emitter.emit("change", { chainId: chain.id });
        return chain;
      },

      async disconnect() {
        connected = false;
      },
    };
  });
};

const rainbowkitBurnerConnector = (walletDetails: Record<string, unknown>) =>
  createConnector(config => ({
    ...chainAwareBurner()(config),
    ...walletDetails,
  }));

export const rainbowkitBurnerWallet = () => ({
  id: BURNER_WALLET_CONNECTOR_ID,
  name: BURNER_WALLET_NAME,
  iconUrl: burnerWalletIconUrl,
  iconBackground: "#ffffff",
  createConnector: rainbowkitBurnerConnector,
});
