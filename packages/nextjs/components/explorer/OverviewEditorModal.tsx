"use client";

/**
 * OverviewEditorModal — the save UI for the on-chain Overview (README.md) editor.
 * ============================================================================
 *
 * Hosts the controlled <MarkdownEditor> and drives the save through the EFS write
 * seams: `uploadOnchainFile` writes the README.md DATA + placement via layered
 * multiAttest (and inlines small markdown as a `data:` MIRROR when available),
 * then `applySystemTag` marks the DATA as a system-managed Overview. Both run as
 * the connected wallet and are not atomic. Editing replaces the author's own
 * version only (lens-scoped): re-saving the same (parent, "README.md") reuses the
 * file ANCHOR and supersedes the prior placement PIN in O(1) (ADR-0041), so the
 * author's previous Overview is cleanly superseded without touching anyone else's
 * lens.
 *
 * This modal is intentionally a thin shell: the EFS machinery lives in the seams
 * (the in-progress SDK will own fetch/resolution/hashing). No React hook is
 * called inside the seams.
 */
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePublicClient, useWalletClient } from "wagmi";
import { StopIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { MarkdownEditor } from "~~/components/markdown/MarkdownEditor";
import { useDeployedContractInfo } from "~~/hooks/scaffold-eth";
import { useTargetNetwork } from "~~/hooks/scaffold-eth/useTargetNetwork";
import { applySystemTag, createWalletClientAttest } from "~~/lib/efs/applySystemTag";
import { CHUNK_SIZE } from "~~/lib/efs/sstore2";
import { uploadOnchainFile } from "~~/lib/efs/uploadOnchainFile";
import { useBackgroundOps } from "~~/services/store/backgroundOps";
import { EDGE_RESOLVER_ABI, getEdgeResolverAddress } from "~~/utils/efs/edgeResolver";
import { MAX_RENDER_BYTES } from "~~/utils/markdown/limits";
import { ensureWalletChain, notification } from "~~/utils/scaffold-eth";

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
  const publicClient = usePublicClient({ chainId: targetNetwork.id });
  const { data: walletClient } = useWalletClient();
  const { data: indexer } = useDeployedContractInfo({ contractName: "Indexer" });
  const indexerAbi = indexer?.abi;
  // EAS address — the target of the batched `multiAttest` in the upload seam.
  const { data: eas } = useDeployedContractInfo({ contractName: "EAS" });
  const easAddress = eas?.address;

  const [text, setText] = useState(initialText);
  const [isSaving, setIsSaving] = useState(false);
  const [canCancelSave, setCanCancelSave] = useState(true);
  const cancelledRef = useRef(false);

  const handleSave = async () => {
    if (!walletClient || !publicClient || !indexerAbi || !easAddress) {
      notification.error("Wallet, network, or EAS/Indexer address not ready. Reconnect and retry.");
      return;
    }
    if (!ensureWalletChain(walletClient, targetNetwork.id, targetNetwork.name)) return;
    const attest = createWalletClientAttest({ walletClient, easAddress });

    const edgeResolverAddress = await getEdgeResolverAddress(targetNetwork.id);
    if (!edgeResolverAddress) {
      notification.error("EdgeResolver address not available. Is it deployed?");
      return;
    }
    const edgeResolverAbi = EDGE_RESOLVER_ABI;

    cancelledRef.current = false;
    setCanCancelSave(true);
    setIsSaving(true);
    const opId = useBackgroundOps.getState().start("Saving Overview…");
    try {
      const bytes = new TextEncoder().encode(text);
      // Refuse to save an Overview the pane would then refuse to render: the
      // viewer caps markdown at MAX_RENDER_BYTES, so anything larger would cost
      // a pile of on-chain transactions and only ever display "too large".
      if (bytes.length > MAX_RENDER_BYTES) {
        const msg = `Overview is ${(bytes.length / 1024).toFixed(0)} KB; the renderer caps at ${MAX_RENDER_BYTES / 1024} KB.`;
        notification.error(msg);
        useBackgroundOps.getState().fail(opId, msg);
        setIsSaving(false);
        return;
      }
      await uploadOnchainFile({
        name: "README.md",
        bytes,
        contentType: "text/markdown",
        parentAnchorUID,
        walletClient,
        publicClient,
        chainId: targetNetwork.id,
        easAddress,
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
        onCanCancelChange: setCanCancelSave,
        onProgress: msg => useBackgroundOps.getState().log(opId, msg),
        // Apply the system TAG on the DATA BEFORE the placement PIN makes the
        // README reachable, so a stopped/rejected/failed tag can never leave a
        // visible, untagged README in the directory (Codex P2). If this throws,
        // uploadOnchainFile skips placement — nothing reachable leaks.
        beforePlacement: async dataUID => {
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
        },
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
      setCanCancelSave(true);
    }
  };

  if (typeof document === "undefined") return null;

  const encodedBytes = new TextEncoder().encode(text).length;
  const overCap = encodedBytes > MAX_RENDER_BYTES;
  // Honest popup estimate: the ~11 attestations collapse to ~4 `multiAttest`
  // popups plus the system TAG. Small markdown can store inline when
  // /transports/data is seeded; older chains fall back inside the upload seam.
  const inlineEligible = encodedBytes > 0 && encodedBytes <= 4096;
  const fallbackStorageTxs = 1 + Math.max(1, Math.ceil(encodedBytes / CHUNK_SIZE));
  const estTxs = inlineEligible ? `~5-${5 + fallbackStorageTxs}` : `~${5 + fallbackStorageTxs}`;
  const storageCopy = inlineEligible
    ? "small saves inline when /transports/data is seeded; fallback storage adds one manager plus one chunk transaction"
    : "storage adds one manager plus one transaction per content chunk";

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="terminal-panel bg-base-200 border border-base-300 rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="relative px-6 py-4 border-b border-base-300/80">
          <h3 className="neon-text text-base font-bold uppercase tracking-[0.18em] text-primary pr-8">
            {mode === "edit" ? "Edit Overview" : "Create Overview"}
          </h3>
          <p className="text-xs text-base-content/60 mt-2 leading-relaxed pr-8">
            Saving writes {estTxs} on-chain transactions as your connected wallet (the file edges are now batched into a
            few signatures; {storageCopy}). Editing replaces your own version only (lens-scoped) — it never touches
            anyone else&apos;s.
          </p>
          <button
            type="button"
            onClick={() => {
              // Closing during an in-flight save must cancel it — otherwise the
              // modal (and its Stop button) unmounts while uploadOnchainFile keeps
              // seeing isCancelled()===false and broadcasts the remaining txs
              // (Codex P2). Route close through the same cancellation path as Stop.
              if (isSaving) {
                if (canCancelSave) cancelledRef.current = true;
                else return;
              }
              onClose();
            }}
            aria-label="Close editor"
            title={
              isSaving ? (canCancelSave ? "Stop saving and close" : "Final placement is in progress") : "Close editor"
            }
            disabled={isSaving && !canCancelSave}
            className="btn btn-ghost btn-sm btn-circle absolute right-3 top-3"
          >
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 overflow-y-auto flex-1">
          {!walletClient ? (
            <div className="text-center text-base-content/70 py-12">Connect a wallet to edit the Overview.</div>
          ) : (
            <>
              <MarkdownEditor value={text} onChange={setText} />
              {overCap && (
                <div className="mt-3 text-sm text-error">
                  This Overview is {(encodedBytes / 1024).toFixed(0)} KB — over the {MAX_RENDER_BYTES / 1024} KB render
                  cap. The viewer would only show &quot;too large&quot;, so saving is disabled. Trim the content.
                </div>
              )}
              {isSaving && (
                <div className="mt-4 flex items-center gap-2 text-sm text-base-content/70">
                  <span className="loading loading-spinner loading-xs" />
                  Saving Overview on-chain… (see the background-ops drawer for progress)
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-base-300/80 flex items-center justify-end gap-2">
          {isSaving ? (
            <button
              type="button"
              className={`btn ${canCancelSave ? "btn-error" : "btn-warning"}`}
              disabled={!canCancelSave}
              onClick={() => {
                if (canCancelSave) cancelledRef.current = true;
              }}
              title={
                canCancelSave
                  ? "Stops at the next safe boundary. If final placement has begun, approve remaining prompts to finish safely."
                  : "Final placement is in progress. Use the wallet prompt if you need to reject the current transaction."
              }
            >
              <StopIcon className="w-4 h-4" />
              {canCancelSave ? "Stop" : "Finishing placement"}
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
              disabled={isSaving || text.trim().length === 0 || !indexerAbi || !easAddress || overCap}
            >
              {isSaving && <span className="loading loading-spinner loading-xs" />}
              {isSaving ? "Saving…" : "Save"}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};
