"use client";

/**
 * SwitchTheme — compact two-position light/dark toggle.
 *
 * Layout: a single rounded pill. Both sun and moon sit inside the track at
 * low opacity (so the "which side is which" affordance is always visible),
 * and an opaque thumb slides left↔right carrying the icon of the currently-
 * active theme. One control instead of three separate elements (icon + pill
 * + icon) that the old layout used.
 *
 * `next-themes` gives us `resolvedTheme`; we gate on `mounted` to avoid a
 * hydration mismatch (server can't know the user's preference).
 */
import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { MoonIcon, SunIcon } from "@heroicons/react/24/outline";

export const SwitchTheme = ({ className = "" }: { className?: string }) => {
  const { setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const isDarkMode = resolvedTheme === "dark";
  const handleToggle = () => setTheme(isDarkMode ? "light" : "dark");

  // Pre-hydration skeleton with matching footprint so the header doesn't
  // reflow when the real toggle mounts.
  if (!mounted) {
    return <div aria-hidden className={`h-7 w-[3.25rem] rounded-full bg-base-300 ${className}`} />;
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDarkMode}
      aria-label={isDarkMode ? "Switch to light mode" : "Switch to dark mode"}
      onClick={handleToggle}
      className={`relative h-7 w-[3.25rem] rounded-full bg-base-300 hover:bg-base-200 transition-colors ${className}`}
    >
      {/* Track icons — always visible at low opacity so both "sides" of the pill are legible. */}
      <SunIcon className="absolute left-1.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 opacity-40 pointer-events-none" />
      <MoonIcon className="absolute right-1.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 opacity-40 pointer-events-none" />
      {/* Thumb — slides between the two ends and carries the *active* icon opaquely. */}
      <span
        className={`absolute top-0.5 h-6 w-6 rounded-full bg-primary text-primary-content flex items-center justify-center shadow transition-all duration-200 ${
          isDarkMode ? "left-[calc(100%-1.625rem)]" : "left-0.5"
        }`}
      >
        {isDarkMode ? <MoonIcon className="h-3.5 w-3.5" /> : <SunIcon className="h-3.5 w-3.5" />}
      </span>
    </button>
  );
};
