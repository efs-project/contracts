import { useMemo } from "react";
import { encodePacked, keccak256, zeroHash } from "viem";
import { useDeployedContractInfo, useScaffoldReadContract } from "~~/hooks/scaffold-eth";

// Definitions matching the Deploy script
export const SCHEMA_DEFS = {
    TOPIC: { definition: "string name", revocable: false, resolver: "TopicResolver" },
    TAG: { definition: "bytes32 definition", revocable: true, resolver: "TagResolver" },
    PROPERTY: { definition: "string value", revocable: true, resolver: "PropertyResolver" },
    FILE: { definition: "uint8 type, string data", revocable: true, resolver: "FileResolver" },
    BLOB: { definition: "bytes data, string contentType", revocable: true, resolver: "BlobResolver" },
} as const;

export const useSchemaRegistry = () => {
    // 1. Fetch Contract Addresses & Info
    const { data: topicResolver } = useDeployedContractInfo({ contractName: "TopicResolver" });
    const { data: tagResolver } = useDeployedContractInfo({ contractName: "TagResolver" });
    const { data: propertyResolver } = useDeployedContractInfo({ contractName: "PropertyResolver" });
    const { data: fileResolver } = useDeployedContractInfo({ contractName: "FileResolver" });
    const { data: blobResolver } = useDeployedContractInfo({ contractName: "BlobResolver" });
    const { data: indexer } = useDeployedContractInfo({ contractName: "Indexer" });

    // 2. Fetch Dynamic Data from Contracts
    const { data: easAddress } = useScaffoldReadContract({
        contractName: "Indexer",
        functionName: "getEAS",
    });

    const { data: rootTopicUid } = useScaffoldReadContract({
        contractName: "TopicResolver",
        functionName: "rootTopicUid",
    });

    // 3. Calculate Schema UIDs
    const schemas = useMemo(() => {
        if (!topicResolver || !tagResolver || !propertyResolver || !fileResolver || !blobResolver) return null;

        const resolvers = {
            TopicResolver: topicResolver.address,
            TagResolver: tagResolver.address,
            PropertyResolver: propertyResolver.address,
            FileResolver: fileResolver.address,
            BlobResolver: blobResolver.address,
        };

        const calculated: Record<string, string> = {};
        for (const [key, def] of Object.entries(SCHEMA_DEFS)) {
            const resolverAddr = resolvers[def.resolver as keyof typeof resolvers];
            if (resolverAddr) {
                // UID = keccak256(abi.encodePacked(definition, resolver, revocable))
                calculated[key] = keccak256(encodePacked(
                    ["string", "address", "bool"],
                    [def.definition, resolverAddr, def.revocable]
                ));
            }
        }
        return calculated;
    }, [topicResolver, tagResolver, propertyResolver, fileResolver, blobResolver]);

    return {
        schemas,
        rootTopicUid: (rootTopicUid && rootTopicUid !== zeroHash) ? rootTopicUid : null,
        easAddress,
        indexerAddress: indexer?.address,
        indexerAbi: indexer?.abi,
    };
};
