import { zeroHash } from "viem";

export const TOPIC_SCHEMA_UID = zeroHash;
// Legacy zero hash string for safety/backward compatibility with older indexer data if present
export const LEGACY_TOPIC_SCHEMA = "0x0000000000000000000000000000000000000000000000000000000000000000";

export interface FileSystemItem {
    uid: string;
    name: string;
    schema: string;
    childCount: bigint;
    hasData: boolean;
    // Add other properties as needed from the contract struct if used in frontend
}

export const isTopic = (item: { schema?: string }): boolean => {
    return !item.schema || item.schema === TOPIC_SCHEMA_UID || item.schema === LEGACY_TOPIC_SCHEMA;
};

export const isFile = (item: { schema?: string }, dataSchemaUID: string): boolean => {
    return item.schema === dataSchemaUID;
};
