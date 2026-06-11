"use client";

import { useEffect, useState } from "react";
import { OverviewEditorModal } from "./OverviewEditorModal";
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

type OverviewPaneProps = Omit<UseItemOverviewArgs, "enabled"> & {
  /** False for address-container roots (the upload helper would revert on the synthetic parent). */
  canEdit?: boolean;
  /** Parent anchor for the README — equals the current anchor UID. */
  editAnchorUID?: `0x${string}`;
  anchorSchemaUID?: `0x${string}`;
  propertySchemaUID?: `0x${string}`;
  pinSchemaUID?: `0x${string}`;
  tagSchemaUID?: `0x${string}`;
  mirrorSchemaUID?: `0x${string}`;
  indexerAddress?: `0x${string}`;
  onOverviewSaved?: () => void;
};

export function OverviewPane(props: OverviewPaneProps) {
  const {
    canEdit,
    editAnchorUID,
    anchorSchemaUID,
    propertySchemaUID,
    pinSchemaUID,
    tagSchemaUID,
    mirrorSchemaUID,
    indexerAddress,
    onOverviewSaved,
    ...overviewArgs
  } = props;
  const [collapsed, setCollapsed] = useState(false);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    setCollapsed(typeof window !== "undefined" && window.localStorage.getItem(COLLAPSE_KEY) === "1");
  }, []);
  const setCollapsedPersist = (next: boolean) => {
    setCollapsed(next);
    try {
      window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
    } catch {
      /* ignore */
    }
  };

  const state = useItemOverview({ ...overviewArgs, enabled: overviewArgs.anchorUID != null });

  const canShowEdit = state.kind === "markdown" && state.source === "onchain" && canEdit && editAnchorUID && indexerAddress;
  const showMirrorDisabled = state.kind === "markdown" && state.source === "mirror";

  // The pane does not exist until we've actually found a README. While resolving
  // (`loading`) or when there's none, render nothing — no flashing empty shell or
  // spinner. The hook keeps running (this component stays mounted); once it has
  // content the pane materializes.
  if (state.kind === "none" || state.kind === "loading") return null;

  // Collapsed → a thin icon rail that returns the column width to the file list
  // (rather than leaving an empty w-96 shell).
  if (collapsed) {
    return (
      <aside className="w-9 flex-shrink-0 border-r border-base-300 bg-base-100 flex flex-col items-center pt-2">
        <button
          className="btn btn-ghost btn-xs px-1 font-bold"
          onClick={() => setCollapsedPersist(false)}
          title="Show Overview"
          aria-label="Show Overview"
        >
          »
        </button>
        <span className="mt-2 text-[10px] font-semibold text-base-content/50 [writing-mode:vertical-rl]">Overview</span>
      </aside>
    );
  }

  return (
    <aside className="w-96 flex-shrink-0 border-r border-base-300 overflow-y-auto bg-base-100">
      <div className="flex items-center justify-between px-3 py-2 border-b border-base-content/10">
        <span className="text-xs font-semibold text-base-content/70">Overview</span>
        <div className="flex items-center gap-1">
          {canShowEdit && (
            <button className="btn btn-ghost btn-xs" onClick={() => setEditing(true)} title="Edit this Overview">
              Edit
            </button>
          )}
          {showMirrorDisabled && (
            <button className="btn btn-ghost btn-xs" disabled title="Editing is only available for on-chain Overviews">
              Edit
            </button>
          )}
          <button
            className="btn btn-ghost btn-xs px-1 font-bold"
            onClick={() => setCollapsedPersist(true)}
            title="Collapse Overview"
            aria-label="Collapse Overview"
          >
            «
          </button>
        </div>
      </div>
      <div className="p-3">
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
      {editing &&
        state.kind === "markdown" &&
        editAnchorUID &&
        anchorSchemaUID &&
        overviewArgs.dataSchemaUID &&
        propertySchemaUID &&
        pinSchemaUID &&
        tagSchemaUID &&
        mirrorSchemaUID &&
        indexerAddress && (
          <OverviewEditorModal
            mode="edit"
            initialText={state.text}
            parentAnchorUID={editAnchorUID}
            anchorSchemaUID={anchorSchemaUID}
            dataSchemaUID={overviewArgs.dataSchemaUID}
            propertySchemaUID={propertySchemaUID}
            pinSchemaUID={pinSchemaUID}
            tagSchemaUID={tagSchemaUID}
            mirrorSchemaUID={mirrorSchemaUID}
            indexerAddress={indexerAddress}
            onSaved={() => {
              onOverviewSaved?.();
              setEditing(false);
            }}
            onClose={() => setEditing(false)}
          />
        )}
    </aside>
  );
}
