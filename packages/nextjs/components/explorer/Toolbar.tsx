"use client";

import { useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
import { notification } from "~~/utils/scaffold-eth";

export type PathItem = {
  uid: string;
  name: string;
};

export const Toolbar = ({
  currentPath,
  currentAnchorUID,
  anchorSchemaUID,
  dataSchemaUID,
  onNavigate,
}: {
  currentPath: PathItem[];
  currentAnchorUID: string | null;
  anchorSchemaUID: string;
  dataSchemaUID: string;
  onNavigate: (uid: string) => void;
}) => {
  const { writeContractAsync: attest } = useScaffoldWriteContract("EAS");

  // Modal State
  const [creationType, setCreationType] = useState<"Folder" | "File" | null>(null);
  const [newName, setNewName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Dialog Ref for DaisyUI
  const modalRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (creationType && modalRef.current) {
      modalRef.current.showModal();
    } else if (!creationType && modalRef.current) {
      modalRef.current.close();
    }
  }, [creationType]);

  const handleOpenModal = (type: "Folder" | "File") => {
    if (!currentAnchorUID) {
      notification.error("Cannot create item: Root not found.");
      return;
    }
    setCreationType(type);
    setNewName("");
  };

  const handleCloseModal = () => {
    setCreationType(null);
    setNewName("");
  };

  const handleSubmitCreate = async () => {
    if (!currentAnchorUID || !newName) return;
    setIsSubmitting(true);

    try {
      const schemaUID = creationType === "File" ? (dataSchemaUID as `0x${string}`) : ethers.ZeroHash;
      const encodedName = ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32"], [newName, schemaUID]);

      await attest({
        functionName: "attest",
        args: [
          {
            schema: anchorSchemaUID as `0x${string}`,
            data: {
              recipient: ethers.ZeroAddress,
              expirationTime: 0n,
              revocable: false,
              refUID: currentAnchorUID as `0x${string}`,
              data: encodedName as `0x${string}`,
              value: 0n,
            },
          },
        ],
      });

      if (creationType === "File") {
        notification.info("File Anchor created. Attach data to make it functional.");
      } else {
        notification.success("Folder created successfully.");
      }
      handleCloseModal();
    } catch (e) {
      console.error(e);
      notification.error("Creation failed. See console.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex justify-between items-center p-2 bg-base-100 rounded-lg">
      <div className="breadcrumbs text-sm">
        <ul>
          {currentPath.map((p, i) => (
            <li key={i}>
              <button
                onClick={() => onNavigate(p.uid)}
                className={`hover:text-primary ${i === currentPath.length - 1 ? "font-bold cursor-default" : "cursor-pointer"}`}
                disabled={i === currentPath.length - 1}
              >
                {p.name}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex gap-2">
        <button className="btn btn-sm btn-ghost" onClick={() => handleOpenModal("Folder")} disabled={!currentAnchorUID}>
          New Folder
        </button>
        <button className="btn btn-sm btn-primary" onClick={() => handleOpenModal("File")} disabled={!currentAnchorUID}>
          New File
        </button>
      </div>

      {/* DaisyUI Modal */}
      <dialog id="create_modal" className="modal" ref={modalRef}>
        <div className="modal-box">
          <h3 className="font-bold text-lg">Create New {creationType}</h3>
          <div className="py-4 form-control w-full">
            <label className="label">
              <span className="label-text">Name</span>
            </label>
            <input
              type="text"
              placeholder={`Enter ${creationType} Name`}
              className="input input-bordered w-full"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && newName) handleSubmitCreate();
                if (e.key === "Escape") handleCloseModal();
              }}
              autoFocus
            />
          </div>
          <div className="modal-action">
            <button className="btn btn-ghost" onClick={handleCloseModal} disabled={isSubmitting}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={handleSubmitCreate} disabled={!newName || isSubmitting}>
              {isSubmitting ? "Creating..." : "Create"}
            </button>
          </div>
        </div>
        <form method="dialog" className="modal-backdrop">
          <button onClick={handleCloseModal}>close</button>
        </form>
      </dialog>
    </div>
  );
};
