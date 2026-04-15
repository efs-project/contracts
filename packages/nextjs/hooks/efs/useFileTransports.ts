/**
 * useFileTransports — Fetch MIRRORs for a DATA attestation, grouped by transport type.
 *
 * Reads from EFSFileView.getDataMirrors(dataUID, start, length).
 */
import { useCallback, useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { useDeployedContractInfo } from "~~/hooks/scaffold-eth";

export interface MirrorItem {
  uid: string;
  transportDefinition: string;
  uri: string;
  attester: string;
  timestamp: bigint;
}

const FILE_VIEW_MIRRORS_ABI = [
  {
    inputs: [
      { internalType: "bytes32", name: "dataUID", type: "bytes32" },
      { internalType: "uint256", name: "start", type: "uint256" },
      { internalType: "uint256", name: "length", type: "uint256" },
    ],
    name: "getDataMirrors",
    outputs: [
      {
        components: [
          { internalType: "bytes32", name: "uid", type: "bytes32" },
          { internalType: "bytes32", name: "transportDefinition", type: "bytes32" },
          { internalType: "string", name: "uri", type: "string" },
          { internalType: "address", name: "attester", type: "address" },
          { internalType: "uint64", name: "timestamp", type: "uint64" },
        ],
        internalType: "struct EFSFileView.MirrorItem[]",
        name: "",
        type: "tuple[]",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

interface UseFileTransportsOptions {
  dataUID: string | null;
  pageSize?: number;
}

export function useFileTransports({ dataUID, pageSize = 50 }: UseFileTransportsOptions) {
  const [mirrors, setMirrors] = useState<MirrorItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const publicClient = usePublicClient();
  const { data: fileViewInfo } = useDeployedContractInfo({ contractName: "EFSFileView" });

  const fetch = useCallback(async () => {
    if (!dataUID || !publicClient || !fileViewInfo) {
      setMirrors([]);
      return;
    }
    setIsLoading(true);
    try {
      const result = (await publicClient.readContract({
        address: fileViewInfo.address as `0x${string}`,
        abi: FILE_VIEW_MIRRORS_ABI,
        functionName: "getDataMirrors",
        args: [dataUID as `0x${string}`, 0n, BigInt(pageSize)],
      })) as readonly {
        uid: `0x${string}`;
        transportDefinition: `0x${string}`;
        uri: string;
        attester: `0x${string}`;
        timestamp: bigint;
      }[];

      setMirrors(
        result.map(m => ({
          uid: m.uid,
          transportDefinition: m.transportDefinition,
          uri: m.uri,
          attester: m.attester,
          timestamp: m.timestamp,
        })),
      );
    } catch (e) {
      console.error("Failed to fetch mirrors:", e);
      setMirrors([]);
    } finally {
      setIsLoading(false);
    }
  }, [dataUID, publicClient, fileViewInfo, pageSize]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { mirrors, isLoading, refetch: fetch };
}
