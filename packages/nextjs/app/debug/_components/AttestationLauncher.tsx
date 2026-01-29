"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export const AttestationLauncher = () => {
  const [uid, setUid] = useState("");
  const router = useRouter();

  const handleDebug = () => {
    if (uid) {
      router.push(`/debug/attestation?uid=${uid}`);
    }
  };

  return (
    <div className="flex flex-col items-center gap-4 py-8 bg-base-100">
      <h2 className="text-2xl font-bold">Attestation Debugger</h2>
      <div className="join">
        <input
          className="input input-bordered join-item w-80 font-mono"
          placeholder="Attestation UID"
          value={uid}
          onChange={e => setUid(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleDebug()}
        />
        <button className="btn btn-primary join-item" onClick={handleDebug}>
          Debug
        </button>
      </div>
    </div>
  );
};
