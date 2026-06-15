/**
 * useItemOverview — resolve an EFS item's "Overview" markdown.
 *
 * Resolves the item's `README.md` directly through the router's EXACT path
 * lookup (EFSIndexer `resolveAnchor` / `_nameToAnchor`, lens-scoped, first-lens-
 * wins) — no directory listing or scan. The router returns 404 when the anchor
 * doesn't exist or no active lens has content there, which we read as "no
 * Overview". On success: cap by `MAX_RENDER_BYTES`, sniff text/binary, decode as
 * UTF-8 markdown.
 */
import { useEffect, useState } from "react";
import type { Abi, PublicClient } from "viem";
import { FileNotFoundError, FileTooLargeError, fetchFileContent } from "~~/utils/efs/fetchFileContent";
import { MAX_RENDER_BYTES } from "~~/utils/markdown/limits";
import { sniffContent } from "~~/utils/markdown/sniff";

/** The one canonical Overview filename. Anchor names are case-sensitive on-chain. */
const OVERVIEW_NAME = "README.md";

export type OverviewState =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "markdown"; text: string; source: "onchain" | "mirror" }
  | {
      kind: "binary";
      bytes: Uint8Array;
      contentType: string | null;
      fileName: string;
      size: number;
      source: "onchain" | "mirror";
    }
  | { kind: "too-large"; size: number }
  | { kind: "error"; message: string };

export interface UseItemOverviewArgs {
  enabled: boolean;
  anchorUID: `0x${string}` | null;
  lensAddresses: string[];
  resourcePathNames: string[];
  publicClient: PublicClient | undefined;
  routerAddress?: `0x${string}`;
  routerAbi?: Abi;
  /** Not read by the hook; carried for the consuming component's write-readiness. */
  dataSchemaUID?: `0x${string}`;
  /** Bump to force a re-resolution (e.g. after the editor saves a new Overview). */
  refreshKey?: number;
}

export function useItemOverview(args: UseItemOverviewArgs): OverviewState {
  const [state, setState] = useState<OverviewState>({ kind: "none" });
  useEffect(() => {
    const ready =
      args.enabled &&
      args.anchorUID &&
      // Explicit empty / unresolvable lenses (e.g. a shared `?lenses=` URL) scope
      // the view to nothing — short-circuit to `none` rather than fall through to
      // the router's default-lens resolution.
      args.lensAddresses.length > 0 &&
      args.publicClient &&
      args.routerAddress &&
      args.routerAbi;
    if (!ready) {
      setState({ kind: "none" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    (async () => {
      try {
        // Resolve README.md by EXACT path through the router (lens-scoped,
        // first-lens-wins). The router's resolveAnchor-backed lookup is O(1) and
        // pagination-proof — no directory page to scan. 404 ⇒ no such file or no
        // content for the active lens ⇒ no Overview.
        const fetched = await fetchFileContent({
          routerAddress: args.routerAddress!,
          routerAbi: args.routerAbi!,
          publicClient: args.publicClient!,
          lensAddresses: args.lensAddresses,
          resourcePath: [...args.resourcePathNames, OVERVIEW_NAME],
          // Bound the fetch itself — don't download an oversized external mirror
          // body just to find out it's too large to render.
          maxBytes: MAX_RENDER_BYTES,
        });
        if (cancelled) return;
        // Size cap (belt — the fetch already aborts past maxBytes), then sniff.
        if (fetched.bytes.length > MAX_RENDER_BYTES) {
          setState({ kind: "too-large", size: fetched.bytes.length });
          return;
        }
        if (sniffContent(fetched.bytes) === "binary") {
          setState({
            kind: "binary",
            bytes: fetched.bytes,
            contentType: fetched.contentType,
            fileName: OVERVIEW_NAME,
            size: fetched.bytes.length,
            source: fetched.source,
          });
          return;
        }
        setState({ kind: "markdown", text: new TextDecoder("utf-8").decode(fetched.bytes), source: fetched.source });
      } catch (e) {
        if (cancelled) return;
        if (e instanceof FileNotFoundError) {
          setState({ kind: "none" });
          return;
        }
        if (e instanceof FileTooLargeError) {
          setState({ kind: "too-large", size: e.size });
          return;
        }
        setState({ kind: "error", message: e instanceof Error ? e.message : "Failed to load Overview" });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    args.enabled,
    args.anchorUID,
    args.lensAddresses.join(","),
    args.resourcePathNames.join("/"),
    args.refreshKey,
    // Contract/client readiness — `useDeployedContractInfo` resolves async, so
    // these flip from undefined once bytecode loads; re-resolve when they do.
    args.routerAddress,
    !!args.routerAbi,
    !!args.publicClient,
  ]);
  return state;
}
