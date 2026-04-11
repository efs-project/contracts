"use client";

import { useRef, useState } from "react";
import { ethers } from "ethers";
import { decodeEventLog, parseAbiItem } from "viem";
import { usePublicClient, useWalletClient } from "wagmi";
import { useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
import { notification } from "~~/utils/scaffold-eth";

interface CreateSortModalProps {
  /** Current directory anchor UID (for local sorts) */
  parentAnchorUID: string | null;
  /** /sorts/ anchor UID (for global sorts) */
  sortsAnchorUID: string | undefined;
  anchorSchemaUID: string;
  sortInfoSchemaUID: string | undefined;
  /** Available ISortFunc contracts: [{name, address}] */
  sortFunctions: { name: string; address: string }[];
  /**
   * Active schema context from the parent view. When the user selects
   * sourceType = "Children by schema", this schema is used as SORT_INFO.targetSchema
   * so the sort processes the correct kernel (e.g. DATA_SCHEMA_UID for a file view).
   * Falls back to ZeroHash ("all schemas") when unset or sourceType = 0.
   */
  filterBySchema?: string;
  onCreated?: () => void;
  onClose: () => void;
  isOpen: boolean;
}

export const CreateSortModal = ({
  parentAnchorUID,
  sortsAnchorUID,
  anchorSchemaUID,
  sortInfoSchemaUID,
  sortFunctions,
  filterBySchema,
  onCreated,
  onClose,
  isOpen,
}: CreateSortModalProps) => {
  const [name, setName] = useState("");
  const [selectedSortFunc, setSelectedSortFunc] = useState("");
  const [isGlobal, setIsGlobal] = useState(false);
  const [sourceType, setSourceType] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const modalRef = useRef<HTMLDialogElement>(null);
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { writeContractAsync: attest } = useScaffoldWriteContract({ contractName: "EAS" });

  // Open/close dialog
  if (isOpen && modalRef.current && !modalRef.current.open) {
    modalRef.current.showModal();
  } else if (!isOpen && modalRef.current?.open) {
    modalRef.current.close();
  }

  const handleClose = () => {
    setName("");
    setSelectedSortFunc("");
    setIsGlobal(false);
    setSourceType(0);
    onClose();
  };

  const handleCreate = async () => {
    if (!name || !selectedSortFunc || !publicClient || !walletClient || !sortInfoSchemaUID) return;

    const targetParent = isGlobal ? sortsAnchorUID : parentAnchorUID;
    if (!targetParent) {
      notification.error(isGlobal ? "/sorts/ anchor not found." : "No directory selected.");
      return;
    }

    setIsSubmitting(true);
    try {
      // Step 1: Create the naming anchor under the target parent
      const encodedAnchor = ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32"], [name, sortInfoSchemaUID]);

      const anchorTxHash = await attest({
        functionName: "attest",
        args: [
          {
            schema: anchorSchemaUID as `0x${string}`,
            data: {
              recipient: ethers.ZeroAddress,
              expirationTime: 0n,
              revocable: false,
              refUID: targetParent as `0x${string}`,
              data: encodedAnchor as `0x${string}`,
              value: 0n,
            },
          },
        ],
      });

      if (!anchorTxHash) throw new Error("Naming anchor creation failed.");

      const anchorReceipt = await publicClient.waitForTransactionReceipt({ hash: anchorTxHash });
      let namingAnchorUID: string | undefined;
      for (const log of anchorReceipt.logs) {
        try {
          const event = decodeEventLog({
            abi: [
              parseAbiItem(
                "event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)",
              ),
            ],
            data: log.data,
            topics: log.topics,
          });
          namingAnchorUID = (event.args as any).uid as string;
          break;
        } catch {
          // Not our event
        }
      }

      if (!namingAnchorUID) throw new Error("Could not extract naming anchor UID.");

      // Step 2: Create the SORT_INFO attestation referencing the naming anchor
      // sourceType 0 ("all children") ignores targetSchema, so we emit ZeroHash.
      // sourceType 1 ("children by schema") needs the active schema context —
      // falling back to ZeroHash here would silently create a sort keyed on the
      // generic-folder schema and process the wrong kernel.
      const targetSchema =
        sourceType === 1 && filterBySchema && filterBySchema !== ethers.ZeroHash ? filterBySchema : ethers.ZeroHash;
      const encodedSortInfo = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "bytes32", "uint8"],
        [selectedSortFunc, targetSchema, sourceType],
      );

      const sortInfoTxHash = await attest({
        functionName: "attest",
        args: [
          {
            schema: sortInfoSchemaUID as `0x${string}`,
            data: {
              recipient: ethers.ZeroAddress,
              expirationTime: 0n,
              revocable: true,
              refUID: namingAnchorUID as `0x${string}`,
              data: encodedSortInfo as `0x${string}`,
              value: 0n,
            },
          },
        ],
      });

      if (sortInfoTxHash) {
        await publicClient.waitForTransactionReceipt({ hash: sortInfoTxHash });
      }

      notification.success(`Sort "${name}" created successfully.`);
      onCreated?.();
      handleClose();
    } catch (e: any) {
      console.error("Sort creation failed:", e);
      notification.error(e?.shortMessage ?? e?.message ?? "Sort creation failed.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <dialog className="modal" ref={modalRef}>
      <div className="modal-box">
        <h3 className="font-bold text-lg">Create New Sort</h3>

        <div className="py-4 flex flex-col gap-4">
          {/* Name */}
          <div className="form-control w-full">
            <label className="label">
              <span className="label-text">Sort Name</span>
            </label>
            <input
              type="text"
              placeholder="e.g. BySize, ByRating"
              className="input input-bordered w-full"
              value={name}
              onChange={e => setName(e.target.value)}
              autoFocus
            />
          </div>

          {/* Sort Function */}
          <div className="form-control w-full">
            <label className="label">
              <span className="label-text">Sort Function</span>
            </label>
            <select
              className="select select-bordered w-full"
              value={selectedSortFunc}
              onChange={e => setSelectedSortFunc(e.target.value)}
            >
              <option value="" disabled>
                Select a sort function...
              </option>
              {sortFunctions.map(sf => (
                <option key={sf.address} value={sf.address}>
                  {sf.name}
                </option>
              ))}
            </select>
          </div>

          {/* Source Type */}
          <div className="form-control w-full">
            <label className="label">
              <span className="label-text">Source</span>
            </label>
            <select
              className="select select-bordered w-full"
              value={sourceType}
              onChange={e => setSourceType(Number(e.target.value))}
            >
              <option value={0}>All children</option>
              <option value={1} disabled={!filterBySchema || filterBySchema === ethers.ZeroHash}>
                Children by schema{!filterBySchema || filterBySchema === ethers.ZeroHash ? " (no schema context)" : ""}
              </option>
            </select>
          </div>

          {/* Scope toggle */}
          <div className="form-control">
            <label className="label cursor-pointer justify-start gap-3">
              <input
                type="checkbox"
                className="toggle toggle-primary"
                checked={isGlobal}
                onChange={e => setIsGlobal(e.target.checked)}
                disabled={!sortsAnchorUID}
              />
              <span className="label-text">
                {isGlobal ? "Global (available everywhere via /sorts/)" : "Local (only this directory)"}
              </span>
            </label>
          </div>
        </div>

        <div className="modal-action">
          <button className="btn btn-ghost" onClick={handleClose} disabled={isSubmitting}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={handleCreate}
            disabled={!name || !selectedSortFunc || isSubmitting}
          >
            {isSubmitting ? "Creating..." : "Create Sort"}
          </button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button onClick={handleClose}>close</button>
      </form>
    </dialog>
  );
};
