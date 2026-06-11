"use client";

/**
 * OverviewEditorModal — the save UI for the on-chain Overview (README.md) editor.
 * ============================================================================
 *
 * Hosts the controlled <MarkdownEditor> and drives the save through the two SDK
 * seams: `uploadOnchainFile` (writes the README.md DATA + placement) and
 * `applySystemTag` (marks the DATA as a system-managed Overview). Both run as the
 * connected wallet — a single save is ~8–10 on-chain transactions and is NOT
 * atomic. Editing replaces the author's own version only (lens-scoped): re-saving
 * the same (parent, "README.md") reuses the file ANCHOR and supersedes the prior
 * placement PIN in O(1) (ADR-0041), so the author's previous Overview is cleanly
 * superseded without touching anyone else's lens.
 *
 * This modal is intentionally a thin shell: the EFS machinery lives in the seams
 * (the in-progress SDK will own fetch/resolution/hashing). No React hook is
 * called inside the seams — the `attest` handle is injected per the seams' design.
 */

import { useRef, useState } from "react";
import { StopIcon } from "@heroicons/react/24/outline";
import { usePublicClient, useWalletClient } from "wagmi";
import { MarkdownEditor } from "~~/components/markdown/MarkdownEditor";
import { useDeployedContractInfo, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
import { useTargetNetwork } from "~~/hooks/scaffold-eth/useTargetNetwork";
import { applySystemTag } from "~~/lib/efs/applySystemTag";
import type { AttestFn } from "~~/lib/efs/uploadOnchainFile";
import { uploadOnchainFile } from "~~/lib/efs/uploadOnchainFile";
import { useBackgroundOps } from "~~/services/store/backgroundOps";
import { EDGE_RESOLVER_ABI, getEdgeResolverAddress } from "~~/utils/efs/edgeResolver";
import { notification } from "~~/utils/scaffold-eth";

export interface OverviewEditorModalProps {
  mode: "create" | "edit";
  initialText: string;
  parentAnchorUID: `0x${string}`;
  anchorSchemaUID: `0x${string}`;
  dataSchemaUID: `0x${string}`;
  propertySchemaUID: `0x${string}`;
  pinSchemaUID: `0x${string}`;
  tagSchemaUID: `0x${string}`;
  mirrorSchemaUID: `0x${string}`;
  indexerAddress: `0x${string}`;
  onSaved: () => void; // bump the refresh key in the parent
  onClose: () => void;
}

export const OverviewEditorModal = (props: OverviewEditorModalProps) => {
  const {
    mode,
    initialText,
    parentAnchorUID,
    anchorSchemaUID,
    dataSchemaUID,
    propertySchemaUID,
    pinSchemaUID,
    tagSchemaUID,
    mirrorSchemaUID,
    indexerAddress,
    onSaved,
    onClose,
  } = props;

  const { targetNetwork } = useTargetNetwork();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  // attest is the EAS write handle; the seams take it injected (they're plain
  // async and can't call a React hook). The scaffold handle's `variables.args` is
  // a strict 1-tuple `[AttestRequest | undefined]`, while the seams' `AttestFn`
  // widens it to `readonly unknown[]` — a contravariant gap, so the handle is NOT
  // directly assignable. The seams always call with exactly one attest-request
  // element, so the runtime shape is identical; we bridge the variance with a
  // single localized cast at the hook boundary rather than loosening `AttestFn`.
  const { writeContractAsync } = useScaffoldWriteContract({ contractName: "EAS" });
  const attest = writeContractAsync as unknown as AttestFn;
  const { data: indexer } = useDeployedContractInfo({ contractName: "Indexer" });
  const indexerAbi = indexer?.abi;

  const [text, setText] = useState(initialText);
  const [isSaving, setIsSaving] = useState(false);
  const cancelledRef = useRef(false);

  const handleSave = async () => {
    if (!walletClient || !publicClient || !indexerAbi) return;

    const edgeResolverAddress = await getEdgeResolverAddress(targetNetwork.id);
    if (!edgeResolverAddress) {
      notification.error("EdgeResolver address not available. Is it deployed?");
      return;
    }
    const edgeResolverAbi = EDGE_RESOLVER_ABI;

    cancelledRef.current = false;
    setIsSaving(true);
    const opId = useBackgroundOps.getState().start("Saving Overview…");
    try {
      const bytes = new TextEncoder().encode(text);
      const { dataUID } = await uploadOnchainFile({
        name: "README.md",
        bytes,
        contentType: "text/markdown",
        parentAnchorUID,
        walletClient,
        publicClient,
        chainId: targetNetwork.id,
        attest,
        indexerAddress,
        indexerAbi,
        anchorSchemaUID,
        dataSchemaUID,
        propertySchemaUID,
        pinSchemaUID,
        tagSchemaUID,
        mirrorSchemaUID,
        edgeResolverAddress,
        edgeResolverAbi,
        isCancelled: () => cancelledRef.current,
        onProgress: msg => useBackgroundOps.getState().log(opId, msg),
      });
      await applySystemTag({
        dataUID,
        walletClient,
        publicClient,
        attest,
        indexerAddress,
        indexerAbi,
        anchorSchemaUID,
        tagSchemaUID,
        edgeResolverAddress,
        edgeResolverAbi,
      });
      useBackgroundOps.getState().complete(opId, "Overview saved");
      onSaved();
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("__UPLOAD_CANCELLED__")) {
        useBackgroundOps.getState().fail(opId, "Cancelled");
      } else {
        useBackgroundOps.getState().fail(opId, msg);
        notification.error(`Save failed: ${msg}`);
      }
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
      <div className="bg-base-100 rounded-xl shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-base-300">
          <h3 className="text-lg font-semibold">{mode === "edit" ? "Edit Overview" : "Create Overview"}</h3>
          <p className="text-xs text-base-content/60 mt-1">
            Saving writes ~8–10 on-chain transactions as your connected wallet. Editing replaces your own version only
            (lens-scoped) — it never touches anyone else&apos;s.
          </p>
        </div>

        {/* Body */}
        <div className="px-5 py-4 overflow-y-auto flex-1">
          {!walletClient ? (
            <div className="text-center text-base-content/70 py-12">Connect a wallet to edit the Overview.</div>
          ) : (
            <>
              <MarkdownEditor value={text} onChange={setText} />
              {isSaving && (
                <div className="mt-3 flex items-center gap-2 text-sm text-base-content/70">
                  <span className="loading loading-spinner loading-xs" />
                  Saving Overview on-chain… (see the background-ops drawer for progress)
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-base-300 flex items-center justify-end gap-2">
          {isSaving ? (
            <button
              type="button"
              className="btn btn-error"
              onClick={() => {
                cancelledRef.current = true;
              }}
              title="Stop saving. Transactions already broadcast will still settle on-chain."
            >
              <StopIcon className="w-4 h-4" />
              Stop
            </button>
          ) : (
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={isSaving}>
              Cancel
            </button>
          )}
          {walletClient && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSave}
              disabled={isSaving || text.trim().length === 0 || !indexerAbi}
            >
              {isSaving && <span className="loading loading-spinner loading-xs" />}
              {isSaving ? "Saving…" : "Save"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
