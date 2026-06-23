import { notification } from "~~/utils/scaffold-eth/notification";

/**
 * Guards a raw walletClient write against a chain mismatch. Reads in this app
 * follow the selected target network; raw walletClient writes follow the wallet.
 * When they diverge (wallet on a different chain than the UI), a write would land
 * on the wrong chain with target-chain-derived addresses. Call this before any
 * raw write. Returns true if safe to proceed; otherwise fires an error toast and
 * returns false. (useScaffoldWriteContract has its own equivalent guard.)
 */
export function ensureWalletChain(
  walletClient: { chain?: { id: number } } | undefined,
  expectedChainId: number,
  expectedChainName: string,
): boolean {
  // No wallet at all — preconditions in the caller already handle this; bail quietly.
  if (!walletClient) return false;
  // Wallet present but chain not yet resolved (wagmi still negotiating). Tell the
  // user rather than blocking silently.
  if (!walletClient.chain) {
    notification.error("Wallet network not detected yet. Reconnect your wallet and try again.");
    return false;
  }
  if (walletClient.chain.id !== expectedChainId) {
    notification.error(`Wallet is on the wrong network. Switch your wallet to ${expectedChainName} to continue.`);
    return false;
  }
  return true;
}
