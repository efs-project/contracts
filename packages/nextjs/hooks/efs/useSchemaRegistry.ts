import { useMemo } from "react";
import { zeroHash } from "viem";
import { useDeployedContractInfo, useScaffoldReadContract } from "~~/hooks/scaffold-eth";

export const useSchemaRegistry = () => {
  // 1. Fetch Contract Addresses & Info
  const { data: indexer } = useDeployedContractInfo("Indexer");

  // 2. Fetch Dynamic Data from Contracts
  const { data: easAddress } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "getEAS",
  });

  const { data: rootAnchorUID } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "rootAnchorUID",
  });

  // 3. Fetch Schema UIDs directly from Indexer (Source of Truth)
  const { data: anchorUID } = useScaffoldReadContract({ contractName: "Indexer", functionName: "ANCHOR_SCHEMA_UID" });
  const { data: propertyUID } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "PROPERTY_SCHEMA_UID",
  });
  const { data: dataUID } = useScaffoldReadContract({ contractName: "Indexer", functionName: "DATA_SCHEMA_UID" });
  // BLOB schema was dropped (ADR-0049) — no BLOB_SCHEMA_UID read.

  // PIN_SCHEMA_UID and TAG_SCHEMA_UID live on EdgeResolver (not Indexer) — they
  // were registered with the EdgeResolver address as their resolver (ADR-0041).
  // Debug flows use these to attest and decode edge payloads via the schemas.PIN
  // and schemas.TAG keys.
  const { data: pinUID } = useScaffoldReadContract({ contractName: "EdgeResolver", functionName: "PIN_SCHEMA_UID" });
  const { data: tagUID } = useScaffoldReadContract({ contractName: "EdgeResolver", functionName: "TAG_SCHEMA_UID" });

  const schemas = useMemo(() => {
    if (!anchorUID) return null;
    return {
      ANCHOR: anchorUID,
      PROPERTY: propertyUID,
      DATA: dataUID,
      PIN: pinUID,
      TAG: tagUID,
    };
  }, [anchorUID, propertyUID, dataUID, pinUID, tagUID]);

  return {
    schemas,
    rootTopicUid: rootAnchorUID && rootAnchorUID !== zeroHash ? (rootAnchorUID as string) : null,
    easAddress,
    indexerAddress: indexer?.address,
    indexerAbi: indexer?.abi,
  };
};
