import { sepolia } from "viem/chains";
import { create } from "zustand";

/**
 * HTTP drip-faucet client — gives a wallet a little gas after the visitor asks
 * for it through "Enable promptless edits" or "Get test ETH".
 *
 * Serves the chain where no account is unlocked — **live Sepolia (11155111)** by
 * default. The fork chains (local 31337 and the EFS Devnet 26001993) are funded
 * instead by `DevnetAutoFund`, straight from the node's unlocked account (zero
 * infra — no service, no Docker), so this HTTP path stays off there. The target
 * is overridable via `NEXT_PUBLIC_FAUCET_CHAIN_ID` for another real testnet.
 * Active only when `NEXT_PUBLIC_FAUCET_URL` points at a running faucet service;
 * unset ⇒ disabled.
 *
 * The client holds no key; it only POSTs an address. The faucet service decides
 * eligibility (already-funded / cooldown / cap).
 */
export const FAUCET_URL = (process.env.NEXT_PUBLIC_FAUCET_URL ?? "").trim().replace(/\/$/, "");

/**
 * Chain the HTTP faucet funds; callers may drip only when the wallet is on it.
 * Defaults to live Sepolia — the one network with no unlocked account
 * (`DevnetAutoFund` covers the forks). Override with `NEXT_PUBLIC_FAUCET_CHAIN_ID`.
 */
export const FAUCET_CHAIN_ID = Number(process.env.NEXT_PUBLIC_FAUCET_CHAIN_ID) || sepolia.id;

export type DripResult = {
  ok: boolean;
  /** Machine-readable reason when !ok (e.g. "already_funded", "cooldown"). */
  reason?: string;
  /** Human-readable message safe to surface in the UI. */
  message?: string;
  /** Tx hash when ok. */
  txHash?: string;
};

/** True when a faucet endpoint is configured AND we're on the faucet's chain. */
export function isFaucetEnabled(chainId: number | undefined): boolean {
  return FAUCET_URL.length > 0 && chainId === FAUCET_CHAIN_ID;
}

/**
 * Request a drip for `address`. Never throws — network/parse failures resolve to
 * `{ ok: false }` so callers (especially the fire-and-forget connect path) don't
 * need try/catch.
 */
/**
 * Shared status of an in-flight drip, so the header can show a persistent
 * "adding gas" indicator next to the wallet until the dripped ETH lands (the
 * balance widget only refreshes on block-detection, ~30s, so a brief toast
 * leaves a confusing gap). `pendingHash` truthy ⇒ a drip is in flight.
 */
type FaucetStatusStore = {
  pendingHash?: string;
  errorMessage?: string;
  readyAt?: number;
  setPending: (hash?: string) => void;
  setReady: () => void;
  setError: (message: string) => void;
};
export const useFaucetStatus = create<FaucetStatusStore>(set => ({
  pendingHash: undefined,
  errorMessage: undefined,
  readyAt: undefined,
  setPending: hash => set({ pendingHash: hash, errorMessage: undefined }),
  setReady: () => set({ pendingHash: undefined, errorMessage: undefined, readyAt: Date.now() }),
  setError: message => set({ pendingHash: undefined, errorMessage: message }),
}));

export async function requestDrip(address: string): Promise<DripResult> {
  if (!FAUCET_URL) return { ok: false, reason: "disabled" };
  try {
    const res = await fetch(`${FAUCET_URL}/drip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    });
    const body = (await res.json().catch(() => ({}))) as DripResult;
    return res.ok ? { ok: true, txHash: body.txHash } : { ok: false, reason: body.reason, message: body.message };
  } catch {
    return { ok: false, reason: "network_error" };
  }
}
