import { sepolia } from "viem/chains";

/**
 * HTTP drip-faucet client — gives a connecting wallet a little gas so users
 * don't have to hunt for a faucet.
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
const FAUCET_URL = (process.env.NEXT_PUBLIC_FAUCET_URL ?? "").trim().replace(/\/$/, "");

/**
 * Chain the HTTP faucet funds; the drip fires only when the wallet is on it.
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
