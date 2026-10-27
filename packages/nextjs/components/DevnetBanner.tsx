"use client";

/**
 * DevnetBanner — a floating toast-style banner pinned to the top center of the
 * viewport, surfacing "this is not mainnet".
 *
 * Message configured by `NEXT_PUBLIC_DEVNET_BANNER`. Unset = nothing renders
 * (local dev default). Set to any non-empty string = the banner can be shown on
 * the active Devnet chain, using that string as the banner message. Typical
 * devnet build:
 *
 *   NEXT_PUBLIC_DEVNET_BANNER="EFS Devnet — resets weekly. Data is ephemeral."
 *
 * Positioning: `fixed` at top-center with a max-width so long messages wrap
 * cleanly instead of stretching across ultrawide monitors. Stays visible as the
 * user scrolls — we want the warning in view during any action, not just on
 * initial paint.
 *
 * Dismissal: click × to hide for the browser session (sessionStorage).
 * Reappears on new tabs / full reloads — occasional visitors always see the
 * warning, power users aren't nagged mid-session.
 */
import { useEffect, useState } from "react";
import { ExclamationTriangleIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useTargetNetwork } from "~~/hooks/scaffold-eth";
import { shouldShowDevnetBanner } from "~~/utils/scaffold-eth/devnetBanner";

const DISMISS_KEY = "efs.devnetBanner.dismissed";

export const DevnetBanner = () => {
  const message = process.env.NEXT_PUBLIC_DEVNET_BANNER;
  const { targetNetwork } = useTargetNetwork();
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

  if (!shouldShowDevnetBanner({ chainId: targetNetwork.id, dismissed, message })) return null;

  const onDismiss = () => {
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // sessionStorage unavailable (private browsing on some engines) — just hide for this render.
    }
    setDismissed(true);
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed top-3 left-1/2 -translate-x-1/2 z-[100] w-[min(calc(100vw-1.5rem),48rem)] pointer-events-none"
    >
      {/* rounded-3xl (not rounded-full) so the pill still looks right when the message wraps to 2+ lines on narrow viewports. `items-start` keeps the icon/close aligned to the first line rather than floating mid-height. */}
      <div className="pointer-events-auto flex items-start gap-2 px-4 py-2 bg-warning text-warning-content text-sm font-medium rounded-3xl shadow-lg ring-1 ring-warning-content/10">
        <ExclamationTriangleIcon className="h-4 w-4 flex-shrink-0 mt-0.5" aria-hidden />
        <span className="flex-1 break-words">{message}</span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss banner for this session"
          className="flex-shrink-0 p-1 -mr-1 -mt-0.5 rounded-full hover:bg-warning-content/10 transition-colors"
        >
          <XMarkIcon className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
};
