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
 * Popover surfaces (Chain, RPC URL, Client build, Server build, Contracts)
 * are each one-click-copy so a bug report can paste the exact commit + RPC
 * URL + contract addresses the user was looking at when something went wrong.
 *
 * Server build is fetched lazily from `<rpc-origin>/version.json` when the
 * active flavor is `devnet` (see `useServerVersion`). When client and server
 * SHAs differ, a warning triangle joins the pill — the #1 cause of
 * confusion during devnet iteration is loading a stale client JS bundle
 * against a newer server (or vice versa), and this surfaces it at a glance.
 * On static IPFS clients pointed at arbitrary RPC providers the fetch is
 * skipped / silently fails, so nothing renders.
 */
import { useEffect, useState } from "react";
import { useAccount, useConfig } from "wagmi";
import { CheckIcon, DocumentDuplicateIcon, ExclamationTriangleIcon, GlobeAltIcon } from "@heroicons/react/24/outline";
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

/**
 * Shape of the `/version.json` served by the devnet VPS (published by the
 * devnet agent's rebuild pipeline). All fields are optional on the client side
 * — if the server ever stops emitting one, we just hide that line.
 */
type ServerVersion = {
  server_build?: string;
  server_build_short?: string;
  repo_branch?: string;
  published_at_utc?: string;
  site_url?: string;
};

/**
 * Fetches `/version.json` from the origin that serves the RPC URL.
 *
 * **Why it's safe to call unconditionally in a static IPFS build.** The chip
 * ships in `app.efs.eth.limo` / `eth.link` and any IPFS gateway mirror. Those
 * deployments may point at arbitrary RPC providers (Alchemy, Infura,
 * self-hosted hardhat) that have no `/version.json` endpoint and no CORS
 * headers for this origin. We therefore:
 *
 * 1. Gate on `flavor === "devnet"` — skip the fetch entirely for `local`
 *    (hardhat serves JSON-RPC only, no HTTP routes) and `other` (real
 *    networks won't have the endpoint).
 * 2. Swallow every failure silently — missing route, CORS block, timeout,
 *    aborted request, malformed JSON. The popover just omits the server
 *    build line. **Never crash.** The chip is informational.
 * 3. Abort on unmount / rpcUrl change / 3s timeout so a slow network doesn't
 *    leave the component in a permanent loading state.
 */
function useServerVersion(rpcUrl: string | undefined, flavor: NetworkFlavor): { data: ServerVersion | null } {
  const [data, setData] = useState<ServerVersion | null>(null);

  useEffect(() => {
    if (flavor !== "devnet" || !rpcUrl) {
      setData(null);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);

    (async () => {
      try {
        // Derive from the RPC URL's origin, not `window.location` — a
        // statically-hosted client on `app.efs.eth.limo` pointed at a
        // devnet VPS must fetch from the VPS, not from its own origin.
        const url = new URL("/version.json", rpcUrl).toString();
        const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as ServerVersion;
        if (!cancelled && json && typeof json === "object") {
          setData(json);
        }
      } catch {
        // Expected for anything except a correctly-configured devnet VPS.
        // Network error, CORS block, 404, abort, JSON parse failure — all
        // land here and should result in the line simply not rendering.
      } finally {
        clearTimeout(timer);
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [rpcUrl, flavor]);

  return { data };
}

/** Formats an ISO timestamp as a short relative phrase (e.g. "3h ago").
 * Returns undefined for invalid / future / missing input so the caller can
 * skip rendering. Keeps the popover terse — we'd rather show nothing than
 * `Invalid Date`. */
function formatRelative(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  const delta = Date.now() - t;
  if (delta < 0) return undefined; // clock skew — skip
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

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

  // Fetches `/version.json` from the RPC origin when we're on devnet — silent
  // no-op otherwise. Safe to call unconditionally; see `useServerVersion` for
  // why the static-SPA-on-IPFS-with-arbitrary-RPC case doesn't crash here.
  const { data: serverVersion } = useServerVersion(rpcUrl, flavor);
  const serverFullSha = serverVersion?.server_build ?? "";
  const serverShortSha = serverVersion?.server_build_short || (serverFullSha ? serverFullSha.slice(0, 7) : "");
  // Compare by 7-char short SHA — avoids false-positive mismatches when one
  // side sends short and the other full. Only meaningful when both sides
  // provided a SHA; otherwise `null` (skip the warning).
  const buildsMatch = shortSha && serverShortSha ? shortSha.toLowerCase() === serverShortSha.toLowerCase() : null;
  const serverPublishedRelative = formatRelative(serverVersion?.published_at_utc);

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
        aria-label={
          `Active network: ${label}${shortSha ? `, build ${shortSha}` : ""}` +
          (buildsMatch === false ? ` — server build ${serverShortSha} differs` : "")
        }
        title={
          buildsMatch === false
            ? `${label} — client ${GIT_SHA || "?"} · server ${serverFullSha || serverShortSha} (mismatch)`
            : shortSha
              ? `${label} — build ${GIT_SHA}`
              : label
        }
        className="badge badge-ghost gap-1 cursor-pointer h-6 px-2 text-xs font-normal opacity-50 hover:opacity-100 transition-opacity"
      >
        <GlobeAltIcon className="h-3 w-3" aria-hidden />
        <span>{label}</span>
        {shortSha && <span className="opacity-60 font-mono text-[10px]">· {shortSha}</span>}
        {buildsMatch === false && (
          <ExclamationTriangleIcon
            className="h-3 w-3 text-warning"
            aria-hidden
            title="Client and server builds differ"
          />
        )}
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
              <div className="text-[10px] uppercase tracking-wide opacity-60">
                {serverVersion ? "Client build" : "Build"}
              </div>
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
          {serverVersion && (serverFullSha || serverShortSha) && (
            <div>
              <div className="text-[10px] uppercase tracking-wide opacity-60 flex items-center gap-1">
                Server build
                {buildsMatch === false && (
                  <span
                    className="text-warning normal-case tracking-normal text-[10px] font-medium"
                    title="Client and server are on different commits"
                  >
                    · mismatch
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <div className="font-mono text-xs flex-1 min-w-0 truncate" title={serverFullSha || serverShortSha}>
                  {(serverFullSha || serverShortSha).slice(0, 12)}
                  {(serverFullSha || serverShortSha).length > 12 && "…"}
                </div>
                <CopyButton value={serverFullSha || serverShortSha} label="Copy server commit SHA" />
              </div>
              <div className="text-[11px] opacity-60 mt-0.5 flex gap-2">
                {serverVersion.repo_branch && (
                  <span>
                    Branch: <span className="font-mono">{serverVersion.repo_branch}</span>
                  </span>
                )}
                {serverPublishedRelative && <span>Published {serverPublishedRelative}</span>}
              </div>
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
