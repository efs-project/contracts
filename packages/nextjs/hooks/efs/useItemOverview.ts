/**
 * useItemOverview — resolve an EFS item's "Overview" markdown.
 *
 * Thin orchestration seam composing already-built utils:
 *   1. List the item's data-schema (file) children lens-scoped via
 *      `EFSFileView.getDirectoryPageBySchemaAndAddressList` (single page; the
 *      SDK will own pagination later).
 *   2. First-lens-wins: per lens in order, restrict children to that lens's
 *      attester, then pick the one named `README.md` (`selectOverview`). The
 *      first lens yielding a pick provides the page.
 *   3. Fetch the picked file's bytes through the router (`fetchFileContent`).
 *   4. Cap by `MAX_RENDER_BYTES`, sniff text/binary, decode as UTF-8 markdown.
 *
 * No caching / retry / pagination beyond the single page shown here — matches
 * the planned SDK boundary (EFS machinery stays thin in client code).
 */
import { useEffect, useState } from "react";
import type { Abi, PublicClient } from "viem";
import { fetchFileContent } from "~~/utils/efs/fetchFileContent";
import { selectOverview } from "~~/utils/efs/selectOverview";
import { MAX_RENDER_BYTES } from "~~/utils/markdown/limits";
import { sniffContent } from "~~/utils/markdown/sniff";

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
  fileViewAddress?: `0x${string}`;
  fileViewAbi?: Abi;
  routerAddress?: `0x${string}`;
  routerAbi?: Abi;
  dataSchemaUID?: `0x${string}`;
  /** Bump to force a re-resolution (e.g. after the editor saves a new Overview). */
  refreshKey?: number;
}

/**
 * One decoded `EFSFileView.FileSystemItem` — the fields this hook reads. The
 * full struct also carries parentUID/isFolder/hasData/childCount/propertyCount/
 * timestamp/schema/contentHash; we only need uid + name + attester.
 */
interface FileSystemItem {
  uid: `0x${string}`;
  name: string;
  attester: `0x${string}`;
}

export function useItemOverview(args: UseItemOverviewArgs): OverviewState {
  const [state, setState] = useState<OverviewState>({ kind: "none" });
  useEffect(() => {
    const ready =
      args.enabled &&
      args.anchorUID &&
      args.publicClient &&
      args.fileViewAddress &&
      args.fileViewAbi &&
      args.routerAddress &&
      args.routerAbi &&
      args.dataSchemaUID;
    if (!ready) {
      setState({ kind: "none" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    (async () => {
      try {
        // 1. List children lens-scoped. Matches useLensesDirectoryPage's call
        //    (arg order: parentAnchor, anchorSchema, attesters, cursor "0x",
        //    maxItems) and decode (DirectoryPage = { items, nextCursor }; viem
        //    yields a named object, but a positional tuple is handled too).
        const pageRaw = (await args.publicClient!.readContract({
          address: args.fileViewAddress!,
          abi: args.fileViewAbi!,
          functionName: "getDirectoryPageBySchemaAndAddressList",
          args: [args.anchorUID!, args.dataSchemaUID!, args.lensAddresses as `0x${string}`[], "0x", 1000n],
        })) as any;
        const items: FileSystemItem[] = (pageRaw?.items ?? pageRaw?.[0] ?? []) as FileSystemItem[];
        if (cancelled) return;
        // 2. First-lens-wins: the lens's child named README.md. `selectOverview`
        //    matches the name exactly; system-tag visibility is handled by the
        //    normal explorer tag filter, not here.
        let picked: { uid: string; name: string } | null = null;
        for (const lens of args.lensAddresses) {
          const lensChildren = items
            .filter(it => it.attester.toLowerCase() === lens.toLowerCase())
            .map(it => ({ uid: it.uid, name: it.name }));
          picked = selectOverview(lensChildren);
          if (picked) break;
        }
        if (!picked) {
          if (!cancelled) setState({ kind: "none" });
          return;
        }
        // 3. Fetch the picked file's bytes through the router.
        const fetched = await fetchFileContent({
          routerAddress: args.routerAddress!,
          routerAbi: args.routerAbi!,
          publicClient: args.publicClient!,
          lensAddresses: args.lensAddresses,
          resourcePath: [...args.resourcePathNames, picked.name],
        });
        if (cancelled) return;
        // 4. Size cap, then sniff (bytes-only, never trusting attester MIME).
        if (fetched.bytes.length > MAX_RENDER_BYTES) {
          setState({ kind: "too-large", size: fetched.bytes.length });
          return;
        }
        if (sniffContent(fetched.bytes) === "binary") {
          setState({
            kind: "binary",
            bytes: fetched.bytes,
            contentType: fetched.contentType,
            fileName: picked.name,
            size: fetched.bytes.length,
            source: fetched.source,
          });
          return;
        }
        setState({ kind: "markdown", text: new TextDecoder("utf-8").decode(fetched.bytes), source: fetched.source });
      } catch (e) {
        if (!cancelled) setState({ kind: "error", message: e instanceof Error ? e.message : "Failed to load Overview" });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    args.enabled,
    args.anchorUID,
    args.dataSchemaUID,
    args.lensAddresses.join(","),
    args.resourcePathNames.join("/"),
    args.refreshKey,
  ]);
  return state;
}
