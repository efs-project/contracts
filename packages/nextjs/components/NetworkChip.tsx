"use client";

/**
 * NetworkChip — compact header badge showing the active chain + RPC URL.
 *
 * For the alpha, this is **read-only**: it tells the user "you're on Devnet" or
 * "you're on Local" so they know whether data is real. Runtime network switching
 * (swap RPC URL, probe local first, pick from a list) is deferred — see
 * docs/FUTURE_WORK.md. Switching today means changing env vars and rebuilding,
 * which is fine for ops but not for casual visitors.
 *
 * Label inference:
 *   - rpc starts with http://127.0.0.1 or http://localhost → "Local"
 *   - rpc starts with "/"  → "Devnet"  (same-origin reverse proxy, e.g. /rpc)
 *   - anything else        → chain.name or "Custom"
 *
 * The click surface reveals the full RPC URL + chain ID so operators can copy
 * them when triaging "why does nothing load" on the devnet.
 */
import { useEffect, useState } from "react";
import { useAccount, useConfig } from "wagmi";
import { CheckIcon, DocumentDuplicateIcon, GlobeAltIcon } from "@heroicons/react/24/outline";

type NetworkFlavor = "local" | "devnet" | "custom" | "unknown";

const flavorStyles: Record<NetworkFlavor, { badge: string; dot: string; label: string }> = {
  local: { badge: "badge-info", dot: "bg-info-content", label: "Local" },
  devnet: { badge: "badge-warning", dot: "bg-warning-content", label: "Devnet" },
  custom: { badge: "badge-warning", dot: "bg-warning-content", label: "Custom" },
  unknown: { badge: "badge-ghost", dot: "bg-base-content/50", label: "?" },
};

function inferFlavor(rpcUrl: string | undefined): NetworkFlavor {
  if (!rpcUrl) return "unknown";
  if (rpcUrl.startsWith("http://127.0.0.1") || rpcUrl.startsWith("http://localhost")) return "local";
  if (rpcUrl.startsWith("/")) return "devnet";
  return "custom";
}

export const NetworkChip = () => {
  const { chain } = useAccount();
  const config = useConfig();
  const [copied, setCopied] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  // Prefer the connected account's chain; fall back to first configured chain so the chip
  // still shows something useful before wallet connect.
  const activeChain = chain ?? config.chains[0];
  const rpcUrl = activeChain?.rpcUrls.default.http[0];
  const flavor = inferFlavor(rpcUrl);
  const style = flavorStyles[flavor];
  const label = flavor === "custom" || flavor === "unknown" ? (activeChain?.name ?? style.label) : style.label;

  // Pre-hydration, render a skeleton to avoid mismatch (chain comes from wagmi hook).
  if (!mounted) {
    return <div className="badge badge-ghost h-7 w-20 animate-pulse" aria-hidden />;
  }

  const onCopy = async () => {
    if (!rpcUrl) return;
    try {
      await navigator.clipboard.writeText(rpcUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard unavailable (insecure origin, older browser) — silent no-op
    }
  };

  return (
    <div className="dropdown dropdown-end">
      <div
        tabIndex={0}
        role="button"
        aria-label={`Active network: ${label}`}
        className={`badge ${style.badge} gap-1.5 cursor-pointer h-7 px-2 font-medium`}
      >
        <GlobeAltIcon className="h-3.5 w-3.5" aria-hidden />
        <span>{label}</span>
      </div>
      <div
        tabIndex={0}
        className="dropdown-content mt-2 z-[50] card card-compact w-72 bg-base-100 shadow-lg border border-base-300"
      >
        <div className="card-body gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-wide opacity-60">Chain</div>
            <div className="font-medium text-sm">
              {activeChain?.name ?? "Unknown"}{" "}
              <span className="opacity-60 font-mono text-xs">({activeChain?.id ?? "?"})</span>
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide opacity-60">RPC URL</div>
            <div className="flex items-start gap-1.5">
              <div className="font-mono text-xs break-all flex-1 min-w-0">{rpcUrl ?? "(none)"}</div>
              {rpcUrl && (
                <button
                  type="button"
                  onClick={onCopy}
                  aria-label="Copy RPC URL"
                  className="flex-shrink-0 p-1 rounded hover:bg-base-200 transition-colors"
                >
                  {copied ? (
                    <CheckIcon className="h-3.5 w-3.5 text-success" />
                  ) : (
                    <DocumentDuplicateIcon className="h-3.5 w-3.5" />
                  )}
                </button>
              )}
            </div>
          </div>
          <div className="text-[11px] opacity-60 pt-1 border-t border-base-200">
            Switching networks requires a rebuild. See <code>NEXT_PUBLIC_HARDHAT_RPC_URL</code>.
          </div>
        </div>
      </div>
    </div>
  );
};
