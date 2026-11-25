import { useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useSwitchChain } from "wagmi";
import { useGlobalState } from "~~/services/store/store";
import { resolveRouteChain } from "~~/utils/efs/routeChain";
import { ChainWithAttributes, getTargetNetworks, isBurnerConnector } from "~~/utils/scaffold-eth";

export type RouteChainStatus =
  /** No chain in the link: the viewer's chain. */
  | { kind: "default" }
  /** The link's chain is the one being shown. */
  | { kind: "active"; chain: ChainWithAttributes }
  /** A chain this app isn't set up for (or not a chain at all). */
  | { kind: "unsupported"; token: string; chainId?: number }
  /** A connected wallet is on another chain; the viewer decides whether to switch. */
  | { kind: "wallet-elsewhere"; chain: ChainWithAttributes; walletChainId: number }
  /** The app's own burner wallet is being moved to the link's chain. */
  | { kind: "switching"; chain: ChainWithAttributes };

const networks = getTargetNetworks();

/**
 * Applies the chain an explorer link names (`#sep/…`) to this view. With no
 * wallet connected the app simply reads that chain; a connected wallet is the
 * app's source of truth for its chain, so it is never switched behind the
 * viewer's back — the explorer asks instead. The app's own burner wallet (Easy
 * Edits) isn't the viewer's wallet, so it is moved silently (once; if that
 * fails the viewer gets the switch button). The switch is never saved as the
 * viewer's preference (see `routeChainId` in the store), and leaving the view
 * puts the chain the viewer was on back, so `#/…` means their chain again.
 */
export function useRouteChain(token: string): RouteChainStatus {
  const resolved = useMemo(() => resolveRouteChain(token), [token]);
  const chain = resolved.kind === "id" ? networks.find(n => n.id === resolved.chainId) : undefined;
  const { isConnected, chainId: walletChainId, connector } = useAccount();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const burner = isConnected && isBurnerConnector(connector);
  const targetId = useGlobalState(s => s.targetNetwork.id);
  const setTargetNetwork = useGlobalState(s => s.setTargetNetwork);
  const setRouteChainId = useGlobalState(s => s.setRouteChainId);
  // Read in the cleanup below, which outlives the render it was created in.
  const walletRef = useRef({ isConnected, burner, walletChainId, switchChain });
  walletRef.current = { isConnected, burner, walletChainId, switchChain };

  useEffect(() => {
    if (!chain) return;
    setRouteChainId(chain.id);
    // The chain the viewer was on before this link's chain took over.
    const before = useGlobalState.getState().targetNetwork;
    return () => {
      setRouteChainId(null);
      // Put it back unless something else has moved the chain since (a header
      // switch). The app's burner wallet is moved back too; a viewer's own
      // wallet stays where they put it (the wallet is the source of truth).
      if (before.id === chain.id) return;
      const wallet = walletRef.current;
      const { targetNetwork, setTargetNetwork } = useGlobalState.getState();
      if (!wallet.isConnected && targetNetwork.id === chain.id) setTargetNetwork(before);
      else if (wallet.burner && wallet.walletChainId === chain.id) wallet.switchChain({ chainId: before.id });
    };
  }, [chain, setRouteChainId]);

  // Re-asserted whenever the target moves (e.g. the saved preference being
  // restored once the wallet state settles), so the link's chain holds.
  useEffect(() => {
    if (chain && !isConnected && targetId !== chain.id) setTargetNetwork(chain);
  }, [chain, isConnected, targetId, setTargetNetwork]);

  // One silent attempt per link chain: a failed switch must not retry forever.
  const [burnerAttempted, setBurnerAttempted] = useState<number | null>(null);
  useEffect(() => {
    if (!chain || !burner || walletChainId === chain.id || burnerAttempted === chain.id) return;
    setBurnerAttempted(chain.id);
    switchChain({ chainId: chain.id });
  }, [chain, burner, walletChainId, burnerAttempted, switchChain]);

  if (resolved.kind === "default") return { kind: "default" };
  if (!chain) return { kind: "unsupported", token, chainId: resolved.kind === "id" ? resolved.chainId : undefined };
  if (isConnected && walletChainId !== undefined && walletChainId !== chain.id) {
    return burner && (isSwitching || burnerAttempted !== chain.id)
      ? { kind: "switching", chain }
      : { kind: "wallet-elsewhere", chain, walletChainId };
  }
  return { kind: "active", chain };
}
