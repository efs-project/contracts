"use client";

import { useEffect, useState } from "react";
import { MarkdownView } from "~~/components/markdown/MarkdownView";
import { useItemOverview, type UseItemOverviewArgs } from "~~/hooks/efs/useItemOverview";
import { safeDownloadName } from "~~/utils/markdown/downloadName";

const COLLAPSE_KEY = "efs.overviewCollapsed";

function DownloadCard({ bytes, fileName, note }: { bytes: Uint8Array; fileName: string; note: string }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const u = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [bytes]);
  return (
    <div className="text-sm">
      <p className="opacity-70 mb-2">{note}</p>
      {url && (
        <a className="btn btn-sm btn-outline" href={url} download={safeDownloadName(fileName)}>
          Download {safeDownloadName(fileName)}
        </a>
      )}
    </div>
  );
}

export function OverviewPane(props: Omit<UseItemOverviewArgs, "enabled">) {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    setCollapsed(typeof window !== "undefined" && window.localStorage.getItem(COLLAPSE_KEY) === "1");
  }, []);
  const toggle = () => {
    setCollapsed(c => {
      const next = !c;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const state = useItemOverview({ ...props, enabled: props.anchorUID != null });

  if (state.kind === "none") return null;

  return (
    <aside className="w-96 flex-shrink-0 border-r border-base-300 overflow-y-auto bg-base-100">
      <div className="flex items-center justify-between px-3 py-2 border-b border-base-content/10">
        <span className="text-xs font-semibold text-base-content/70">Overview</span>
        <button className="btn btn-ghost btn-xs" onClick={toggle}>
          {collapsed ? "Show" : "Hide"}
        </button>
      </div>
      {!collapsed && (
        <div className="p-3">
          {state.kind === "loading" && <span className="loading loading-spinner loading-sm" />}
          {state.kind === "error" && <p className="text-error text-sm">{state.message}</p>}
          {state.kind === "too-large" && (
            <p className="text-sm opacity-70">Too large to preview ({Math.ceil(state.size / 1024)} KB).</p>
          )}
          {state.kind === "binary" && (
            <DownloadCard
              bytes={state.bytes}
              fileName={state.fileName}
              note={`This Overview file is not markdown (${state.contentType ?? "unknown type"}).`}
            />
          )}
          {state.kind === "markdown" && (
            <>
              <MarkdownView source={state.text} />
              {state.source === "mirror" && (
                <p className="mt-4 text-[10px] opacity-50">served from an external mirror</p>
              )}
            </>
          )}
        </div>
      )}
    </aside>
  );
}
