"use client";

/**
 * DevnetBanner — a thin top-of-page banner that surfaces "this is not mainnet".
 *
 * Rendered conditionally on `NEXT_PUBLIC_DEVNET_BANNER`. Unset = nothing renders
 * (local dev default). Set to any non-empty string = banner is shown, using that
 * string as the banner message. Typical devnet build:
 *
 *   NEXT_PUBLIC_DEVNET_BANNER="DEVNET — resets weekly. Do not store real data."
 *
 * The banner is dismissable for the browser session (sessionStorage) so power
 * users aren't nagged, but it reappears on a full reload — we want occasional
 * visitors to always see it. Choose sessionStorage over localStorage so dismissal
 * resets when the tab is closed; a returning user gets the warning again.
 */
import { useEffect, useState } from "react";
import { ExclamationTriangleIcon, XMarkIcon } from "@heroicons/react/24/outline";

const DISMISS_KEY = "efs.devnetBanner.dismissed";

export const DevnetBanner = () => {
  const message = process.env.NEXT_PUBLIC_DEVNET_BANNER;
  const [dismissed, setDismissed] = useState(true); // start hidden to avoid flash on unset builds

  useEffect(() => {
    if (!message) return;
    // Check sessionStorage after mount so SSR doesn't hydrate-mismatch.
    try {
      setDismissed(sessionStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      setDismissed(false);
    }
  }, [message]);

  if (!message || dismissed) return null;

  const onDismiss = () => {
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // sessionStorage unavailable (private browsing on some engines) — just hide for this render.
    }
    setDismissed(true);
  };

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-warning text-warning-content text-sm font-medium border-b border-warning">
      <ExclamationTriangleIcon className="h-4 w-4 flex-shrink-0" aria-hidden />
      <span className="flex-1 truncate">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss banner for this session"
        className="flex-shrink-0 p-1 rounded hover:bg-warning-content/10 transition-colors"
      >
        <XMarkIcon className="h-4 w-4" />
      </button>
    </div>
  );
};
