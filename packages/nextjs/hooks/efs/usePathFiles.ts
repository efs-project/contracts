/**
 * usePathFiles — Query TagResolver for DATAs + sub-folders at an Anchor, filtered by attester.
 *
 * Uses EFSFileView.getFilesAtPath(anchorUID, attesters, schema, start, length).
 */
import { useCallback, useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { useDeployedContractInfo } from "~~/hooks/scaffold-eth";

export interface PathFileItem {
  uid: string;
  name: string;
  parentUID: string;
  isFolder: boolean;
  hasData: boolean;
  childCount: bigint;
  propertyCount: bigint;
  timestamp: bigint;
  attester: string;
  schema: string;
  contentHash: string;
}

const FILE_VIEW_PATH_ABI = [
  {
    inputs: [
      { internalType: "bytes32", name: "anchorUID", type: "bytes32" },
      { internalType: "address[]", name: "attesters", type: "address[]" },
      { internalType: "bytes32", name: "schema", type: "bytes32" },
      { internalType: "uint256", name: "start", type: "uint256" },
      { internalType: "uint256", name: "length", type: "uint256" },
    ],
    name: "getFilesAtPath",
    outputs: [
      {
        components: [
          { internalType: "bytes32", name: "uid", type: "bytes32" },
          { internalType: "string", name: "name", type: "string" },
          { internalType: "bytes32", name: "parentUID", type: "bytes32" },
          { internalType: "bool", name: "isFolder", type: "bool" },
          { internalType: "bool", name: "hasData", type: "bool" },
          { internalType: "uint256", name: "childCount", type: "uint256" },
          { internalType: "uint256", name: "propertyCount", type: "uint256" },
          { internalType: "uint64", name: "timestamp", type: "uint64" },
          { internalType: "address", name: "attester", type: "address" },
          { internalType: "bytes32", name: "schema", type: "bytes32" },
          { internalType: "bytes32", name: "contentHash", type: "bytes32" },
        ],
        internalType: "struct EFSFileView.FileSystemItem[]",
        name: "",
        type: "tuple[]",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

interface UsePathFilesOptions {
  anchorUID: string | null;
  attesters: string[];
  schema: string | null;
  pageSize?: number;
  refreshKey?: number;
}

export function usePathFiles({ anchorUID, attesters, schema, pageSize = 50, refreshKey = 0 }: UsePathFilesOptions) {
  const [items, setItems] = useState<PathFileItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const publicClient = usePublicClient();
  const { data: fileViewInfo } = useDeployedContractInfo({ contractName: "EFSFileView" });

  const fetch = useCallback(async () => {
    if (!anchorUID || !schema || attesters.length === 0 || !publicClient || !fileViewInfo) {
      setItems([]);
      return;
    }
    setIsLoading(true);
    try {
      const result = (await publicClient.readContract({
        address: fileViewInfo.address as `0x${string}`,
        abi: FILE_VIEW_PATH_ABI,
        functionName: "getFilesAtPath",
        args: [anchorUID as `0x${string}`, attesters as `0x${string}`[], schema as `0x${string}`, 0n, BigInt(pageSize)],
      })) as readonly {
        uid: `0x${string}`;
        name: string;
        parentUID: `0x${string}`;
        isFolder: boolean;
        hasData: boolean;
        childCount: bigint;
        propertyCount: bigint;
        timestamp: bigint;
        attester: `0x${string}`;
        schema: `0x${string}`;
        contentHash: `0x${string}`;
      }[];

      setItems(
        result.map(item => ({
          uid: item.uid,
          name: item.name,
          parentUID: item.parentUID,
          isFolder: item.isFolder,
          hasData: item.hasData,
          childCount: item.childCount,
          propertyCount: item.propertyCount,
          timestamp: item.timestamp,
          attester: item.attester,
          schema: item.schema,
          contentHash: item.contentHash,
        })),
      );
    } catch (e) {
      console.error("Failed to fetch path files:", e);
      setItems([]);
    } finally {
      setIsLoading(false);
    }
  }, [anchorUID, attesters, schema, publicClient, fileViewInfo, pageSize, refreshKey]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { items, isLoading, refetch: fetch };
}
