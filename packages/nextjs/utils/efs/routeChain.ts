/**
 * routeChain — the chain named at the front of an explorer link
 * (`#sep/whitepapers/bitcoin.pdf`, utils/efs/hashRoute.ts).
 *
 * A link names its chain the ERC-3770 way: a short name from the
 * ethereum-lists chain registry (github.com/ethereum-lists/chains, the
 * `shortName` field) or the plain chain id (`#11155111/…`). Chains with no
 * registered short name — the EFS devnet (26001993) and a local Hardhat node
 * (31337, registered to GoChain Testnet as `got`) — are named by number. No
 * chain (`#/…`) means the viewer's own chain. Anything unrecognised is shown
 * as unsupported, never guessed at.
 */

/** Registry short names → chain ids, for the chains a link may name. */
export const CHAIN_SHORT_NAMES: Readonly<Record<string, number>> = Object.freeze({
  eth: 1,
  sep: 11155111,
});

const REGISTRY_NAMES: Readonly<Record<number, string>> = Object.freeze({
  1: "Ethereum Mainnet",
  11155111: "Ethereum Sepolia",
});

export type RouteChain = { kind: "default" } | { kind: "id"; chainId: number } | { kind: "unknown"; token: string };

export function resolveRouteChain(token: string): RouteChain {
  if (token === "") return { kind: "default" };
  if (/^[1-9][0-9]{0,15}$/.test(token) && Number.isSafeInteger(Number(token))) {
    return { kind: "id", chainId: Number(token) };
  }
  const name = token.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(CHAIN_SHORT_NAMES, name)) {
    return { kind: "id", chainId: CHAIN_SHORT_NAMES[name] };
  }
  return { kind: "unknown", token };
}

/** The registry's name for a chain, when it's one a link may name. */
export function registryChainName(chainId: number): string | undefined {
  return REGISTRY_NAMES[chainId];
}
