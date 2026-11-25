"use client";

import { useSwitchChain } from "wagmi";
import type { RouteChainStatus } from "~~/hooks/efs/useRouteChain";
import { type HashRoute, formatHashRoute } from "~~/utils/efs/hashRoute";
import { CHAIN_SHORT_NAMES, registryChainName } from "~~/utils/efs/routeChain";
import { getTargetNetworks, networkLabel } from "~~/utils/scaffold-eth";

const networks = getTargetNetworks();

/** The prefix a link uses for a chain: its registry short name, else its id. */
const linkPrefix = (chainId: number) =>
  Object.keys(CHAIN_SHORT_NAMES).find(name => CHAIN_SHORT_NAMES[name] === chainId) ?? String(chainId);

const chainName = (chainId: number) =>
  networks.find(n => n.id === chainId)?.name ?? registryChainName(chainId) ?? `chain ${chainId}`;

/**
 * Shown instead of the explorer when a link's chain can't be shown as-is: a
 * chain this app isn't set up for, or a connected wallet on another chain.
 * Never falls back to a different chain silently.
 */
export const RouteChainNotice = ({
  status,
  route,
}: {
  status: Extract<RouteChainStatus, { kind: "unsupported" | "wallet-elsewhere" }>;
  route: HashRoute;
}) => {
  const { switchChain, isPending } = useSwitchChain();
  // The same path and options with no chain: open it on the viewer's chain.
  const onOwnChain = formatHashRoute({ segments: route.rawSegments, params: route.params });

  return (
    <div className="flex flex-col items-center text-center gap-4 px-6 py-16 max-w-xl mx-auto">
      {status.kind === "unsupported" ? (
        <>
          <h2 className="text-xl font-bold m-0">Unsupported chain</h2>
          <p className="m-0">
            This link is for{" "}
            <strong>{status.chainId !== undefined ? chainName(status.chainId) : `“${status.token}”`}</strong>
            {status.chainId === undefined
              ? ", which isn't a chain name this explorer knows"
              : ", which this explorer isn't set up for"}
            .
          </p>
          <p className="m-0 text-sm opacity-70">
            Links start with a chain:{" "}
            {networks.map((n, i) => (
              <span key={n.id}>
                {i > 0 && ", "}
                <code>#{linkPrefix(n.id)}/</code> for {networkLabel(n)}
              </span>
            ))}
            , or <code>#/</code> for your current chain.
          </p>
        </>
      ) : (
        <>
          <h2 className="text-xl font-bold m-0">This link is for {networkLabel(status.chain)}</h2>
          <p className="m-0">Your wallet is on {chainName(status.walletChainId)}.</p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={isPending}
            onClick={() => switchChain({ chainId: status.chain.id })}
          >
            Switch wallet to {networkLabel(status.chain)}
          </button>
        </>
      )}
      <a href={onOwnChain} className="link text-sm">
        Open this path on your current chain instead
      </a>
    </div>
  );
};
