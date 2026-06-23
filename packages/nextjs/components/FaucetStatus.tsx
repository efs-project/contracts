"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount, useBalance } from "wagmi";
import { FAUCET_CHAIN_ID, shouldMarkInstantBurnerReady, useFaucetStatus } from "~~/utils/scaffold-eth";

/**
 * Persistent "Adding gas…" indicator next to the wallet while a faucet drip is in
 * flight. The balance widget only refreshes on new-block detection (the ~30s
 * `pollingInterval`), so a connecting user would otherwise see a brief toast and
 * then a long gap before the ETH appears. While a drip is pending this fast-polls
 * the balance (which the header chip shares) and clears the indicator the moment
 * the balance has visibly increased — i.e. the ETH actually landed.
 */
export const FaucetStatus = () => {
  const { pendingHash, setPending, setReady } = useFaucetStatus();
  const { address } = useAccount();
  const queryClient = useQueryClient();
  const { data, queryKey } = useBalance({
    address,
    chainId: FAUCET_CHAIN_ID,
    query: { enabled: !!address },
  });
  const baseline = useRef<bigint | undefined>(undefined);

  // On a fresh drip: snapshot the pre-drip balance (the cached value, before any
  // refetch), then poll the balance fast so the header chip updates within ~2s of
  // the tx mining. Safety timeout so a stuck RPC can't spin forever.
  useEffect(() => {
    if (!pendingHash) {
      baseline.current = undefined;
      return;
    }
    baseline.current = data?.value;
    const poll = setInterval(() => queryClient.invalidateQueries({ queryKey }), 2000);
    const safety = setTimeout(() => setPending(undefined), 90_000);
    return () => {
      clearInterval(poll);
      clearTimeout(safety);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingHash]);

  // Clear once the dripped ETH is visibly in the wallet. If no baseline was
  // cached before the drip, any positive balance is enough to avoid a stuck chip.
  useEffect(() => {
    if (
      shouldMarkInstantBurnerReady({
        pendingHash,
        baselineValue: baseline.current,
        balanceValue: data?.value,
      })
    ) {
      setReady();
    }
  }, [data?.value, pendingHash, setReady]);

  if (!pendingHash) return null;

  return (
    <div
      className="flex items-center gap-2 px-3 py-1 rounded-full bg-base-200 text-xs"
      title="Adding gas to your wallet — waiting for it to land"
    >
      <span className="loading loading-spinner loading-xs" />
      <span className="whitespace-nowrap">Adding gas…</span>
    </div>
  );
};
