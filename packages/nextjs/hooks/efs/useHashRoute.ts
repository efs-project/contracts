import { useEffect, useMemo, useSyncExternalStore } from "react";
import { HASH_ROUTE_EVENT, type HashRoute, parseHashRoute } from "~~/utils/efs/hashRoute";

const subscribe = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange);
  window.addEventListener("popstate", onChange);
  window.addEventListener(HASH_ROUTE_EVENT, onChange);
  return () => {
    window.removeEventListener("hashchange", onChange);
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(HASH_ROUTE_EVENT, onChange);
  };
};

/** `location.hash`, kept current. Empty during the static (server) render. */
export function useLocationHash(): string {
  const hash = useSyncExternalStore(
    subscribe,
    () => window.location.hash,
    () => "",
  );
  // A Next <Link> into this page updates the URL with history.pushState, which
  // fires no event; re-read once after mount so that hash is seen.
  useEffect(() => {
    window.dispatchEvent(new Event(HASH_ROUTE_EVENT));
  }, []);
  return hash;
}

/** The explorer route in the URL fragment, or `null` when the fragment isn't one. */
export function useHashRoute(): HashRoute | null {
  const hash = useLocationHash();
  return useMemo(() => parseHashRoute(hash), [hash]);
}
