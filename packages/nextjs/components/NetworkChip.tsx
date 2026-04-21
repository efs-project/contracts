"use client";

/**
 * NetworkChip — compact corner badge showing the active chain, build, and
 * deployed contracts.
 *
 * For the alpha, this is **read-only**: it tells the user "you're on Devnet" or
 * "you're on Local" so they know whether data is real. Runtime network switching
 * (swap RPC URL, probe local first, pick from a list) is deferred — see
 * docs/FUTURE_WORK.md. Switching today means changing env vars and rebuilding,
 * which is fine for ops but not for casual visitors.
 *
 * Placement: lives in the bottom-right corner via the Footer's fixed bar.
 * Previously sat in the header with flavor-coloured badges (info / success),
 * which drew the eye to a piece of meta-info most visitors don't care about.
 * Now rendered in a subdued ghost style at reduced opacity so it reads as
 * "status, available if you need it" rather than "primary call to action".
 *
 * Label inference (this app only targets hardhat chain id 31337, so the split
 * is "is the RPC URL pointing at localhost or somewhere else?"):
 *   - hardhat chain + localhost/127.0.0.1 URL  → "Local"
 *   - hardhat chain + any other URL            → "Devnet"
 *   - any other chain id                       → chain.name
 *
 * Pill contents: "<flavor> · <short-sha>". The short SHA lets users sanity-check
 * that the devnet frontend they're hitting is the commit they expect without
 * opening the popover — the #1 source of "why doesn't my change appear?"
 * confusion is stale JS served from a CDN / ServiceWorker cache.
 *
 * Popover surfaces (Chain, RPC URL, Build, Contracts) are each one-click-copy
 * so a bug report can paste the exact commit + RPC URL + contract addresses
 * the user was looking at when something went wrong.
 */
import { useEffect, useState } from "react";
import { useAccount, useConfig } from "wagmi";
import { CheckIcon, DocumentDuplicateIcon, GlobeAltIcon } from "@heroicons/react/24/outline";
import deployedContracts from "~~/contracts/deployedContracts";

const HARDHAT_CHAIN_ID = 31337;

type NetworkFlavor = "local" | "devnet" | "other" | "unknown";

// All flavors render ghost-style — the chip is informational, not a CTA, so
// colour-coding would overstate its importance. The label alone differentiates.
const flavorLabels: Record<NetworkFlavor, string> = {
  local: "Local",
  devnet: "Devnet",
  other: "", // derived from chain.name
  unknown: "?",
};

function inferFlavor(rpcUrl: string | undefined, chainId: number | undefined): NetworkFlavor {
  if (!rpcUrl || !chainId) return "unknown";
  if (chainId === HARDHAT_CHAIN_ID) {
    if (rpcUrl.startsWith("http://127.0.0.1") || rpcUrl.startsWith("http://localhost")) return "local";
    return "devnet";
  }
  return "other";
}

// Build-time constants baked by next.config.js.
const GIT_SHA: string = process.env.NEXT_PUBLIC_GIT_SHA ?? "";
const FORK_BLOCK: string = process.env.NEXT_PUBLIC_FORK_BLOCK ?? "";

// Core contracts to surface in the popover. Chosen to cover the three-layer
// model users ask about: the kernel (Indexer), the read path (FileView), and
// the URL resolver (Router). Resolvers + sort overlay stay hidden behind the
// scaffold debug UI; adding them here would turn the popover into a wall of
// addresses nobody scrolls through on a first look.
const CORE_CONTRACTS = ["Indexer", "EFSFileView", "EFSRouter"] as const;

/** Small async-copy button with 1.2s "✓" feedback. Extracted so Chain/Build/
 * Contracts sections can share it without each owning its own `useState`. */
const CopyButton = ({ value, label }: { value: string; label: string }) => {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard unavailable (insecure origin, older browser) — silent no-op
    }
  };
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={label}
      className="flex-shrink-0 p-1 rounded hover:bg-base-200 transition-colors"
    >
      {copied ? <CheckIcon className="h-3.5 w-3.5 text-success" /> : <DocumentDuplicateIcon className="h-3.5 w-3.5" />}
    </button>
  );
};

export const NetworkChip = () => {
  const { chain } = useAccount();
  const config = useConfig();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  // Prefer the connected account's chain; fall back to first configured chain so the chip
  // still shows something useful before wallet connect.
  const activeChain = chain ?? config.chains[0];
  const rpcUrl = activeChain?.rpcUrls.default.http[0];
  const flavor = inferFlavor(rpcUrl, activeChain?.id);
  const label = flavor === "other" ? (activeChain?.name ?? "Unknown") : flavorLabels[flavor];
  const shortSha = GIT_SHA ? GIT_SHA.slice(0, 7) : "";

  // Pre-hydration, render a skeleton to avoid mismatch (chain comes from wagmi hook).
  if (!mounted) {
    return <div className="badge badge-ghost h-6 w-16 opacity-40" aria-hidden />;
  }

  // Deployed contracts for the active chain. Hardhat is chain 31337 — if a
  // future build targets a real network, the lookup falls back to empty.
  const chainContracts =
    (deployedContracts as Record<number, Record<string, { address: string }>>)[activeChain?.id ?? 0] ?? {};

  return (
    <div className="dropdown dropdown-end dropdown-top">
      <div
        tabIndex={0}
        role="button"
        aria-label={`Active network: ${label}${shortSha ? `, build ${shortSha}` : ""}`}
        title={shortSha ? `${label} — build ${GIT_SHA}` : label}
        className="badge badge-ghost gap-1 cursor-pointer h-6 px-2 text-xs font-normal opacity-50 hover:opacity-100 transition-opacity"
      >
        <GlobeAltIcon className="h-3 w-3" aria-hidden />
        <span>{label}</span>
        {shortSha && <span className="opacity-60 font-mono text-[10px]">· {shortSha}</span>}
      </div>
      <div
        tabIndex={0}
        className="dropdown-content mb-2 z-[50] card card-compact w-80 bg-base-100 shadow-lg border border-base-300"
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
              {rpcUrl && <CopyButton value={rpcUrl} label="Copy RPC URL" />}
            </div>
          </div>
          {(GIT_SHA || FORK_BLOCK) && (
            <div>
              <div className="text-[10px] uppercase tracking-wide opacity-60">Build</div>
              {GIT_SHA && (
                <div className="flex items-center gap-1.5">
                  <div className="font-mono text-xs flex-1 min-w-0 truncate" title={GIT_SHA}>
                    {GIT_SHA.slice(0, 12)}
                    {GIT_SHA.length > 12 && "…"}
                  </div>
                  <CopyButton value={GIT_SHA} label="Copy commit SHA" />
                </div>
              )}
              {FORK_BLOCK && (
                <div className="text-[11px] opacity-60 mt-0.5">
                  Fork block: <span className="font-mono">{Number(FORK_BLOCK).toLocaleString()}</span>
                </div>
              )}
            </div>
          )}
          {Object.keys(chainContracts).length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide opacity-60">Contracts</div>
              <div className="flex flex-col gap-0.5">
                {CORE_CONTRACTS.filter(n => chainContracts[n]).map(name => (
                  <div key={name} className="flex items-center gap-1.5">
                    <span className="text-[11px] font-medium w-20 flex-shrink-0">
                      {name === "Indexer" ? "EFSIndexer" : name}
                    </span>
                    <span
                      className="font-mono text-[10px] flex-1 min-w-0 truncate opacity-80"
                      title={chainContracts[name].address}
                    >
                      {chainContracts[name].address}
                    </span>
                    <CopyButton value={chainContracts[name].address} label={`Copy ${name} address`} />
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="text-[11px] opacity-60 pt-1 border-t border-base-200">
            Switching networks requires a rebuild. See <code>NEXT_PUBLIC_HARDHAT_RPC_URL</code>.
          </div>
        </div>
      </div>
    </div>
  );
};
