// EFS frozen-schema source of truth (Phase D deploy core).
//
// The nine schemas frozen at Sepolia registration (ADR-0048; docs/SEPOLIA_FREEZE_TABLE.md).
// Each schema's UID is `keccak256(abi.encodePacked(fieldString, resolverProxyAddr, revocable))`.
// The field strings here are the GOLDEN VECTORS — they must be byte-identical to the
// corresponding constants in the resolver contracts. The verify gate (deploy-lib/verify.ts)
// re-derives the self-UID getters on-chain and asserts they equal what this file produces, so
// any drift between this file and the contracts aborts the deploy before any schema is registered.
//
// SORT_INFO is intentionally DEFERRED (not in this set) — added later additively.

import { solidityPackedKeccak256 } from "ethers";

/// The six resolver contracts behind CREATE3 proxies. The key is the artifact/contract name.
export type ResolverName =
  | "EFSIndexer"
  | "EdgeResolver"
  | "MirrorResolver"
  | "ListResolver"
  | "ListEntryResolver"
  | "AliasResolver";

export interface SchemaDef {
  /// Canonical EFS schema name (matches the freeze table).
  name: string;
  /// The exact EAS field string. MUST match the contract constant byte-for-byte.
  fieldString: string;
  /// EAS `revocable` flag baked into the UID.
  revocable: boolean;
  /// The resolver contract whose PROXY address is baked into this schema's UID.
  resolver: ResolverName;
}

// The 9 frozen schemas, in deploy/register order. Field strings + revocable flags are FROZEN
// (changing any orphans the schema's data on a chain where it is registered).
export const SCHEMAS: SchemaDef[] = [
  { name: "ANCHOR", fieldString: "string name, bytes32 schemaUID", revocable: false, resolver: "EFSIndexer" },
  // PROPERTY is NON-revocable (ADR-0052): a value is dumb, shared, interned content — an
  // "anchor for a string" that many PINs can point at — not a claim. The revocable claim is
  // the PIN (the binding), not the value. Non-revocability is what makes a value safely
  // shareable: a shared value can't be yanked out from under other bindings. Symmetric with
  // DATA (value = content, claim = edge). Matches the contract constant + golden vector.
  { name: "PROPERTY", fieldString: "string value", revocable: false, resolver: "EFSIndexer" },
  // DATA is an empty schema — pure file identity (ADR-0049).
  { name: "DATA", fieldString: "", revocable: false, resolver: "EFSIndexer" },
  { name: "PIN", fieldString: "bytes32 definition", revocable: true, resolver: "EdgeResolver" },
  { name: "TAG", fieldString: "bytes32 definition, int256 weight", revocable: true, resolver: "EdgeResolver" },
  {
    name: "MIRROR",
    fieldString: "bytes32 transportDefinition, string uri",
    revocable: true,
    resolver: "MirrorResolver",
  },
  {
    name: "LIST",
    fieldString: "bool allowsDuplicates, bool appendOnly, uint8 targetType, bytes32 targetSchema, uint256 maxEntries",
    revocable: false,
    resolver: "ListResolver",
  },
  {
    name: "LIST_ENTRY",
    fieldString: "bytes32 listUID, bytes32 target",
    revocable: true,
    resolver: "ListEntryResolver",
  },
  { name: "REDIRECT", fieldString: "bytes32 target, uint16 kind", revocable: true, resolver: "AliasResolver" },
];

/// The distinct resolver contracts, in deploy order (impls first, then proxies).
export const RESOLVERS: ResolverName[] = [
  "EFSIndexer",
  "EdgeResolver",
  "MirrorResolver",
  "ListResolver",
  "ListEntryResolver",
  "AliasResolver",
];

/// Compute an EAS schema UID for a field string against a resolver proxy address.
/// EAS: `UID = keccak256(abi.encodePacked(schema, resolver, revocable))`.
export function computeSchemaUID(fieldString: string, resolverProxy: string, revocable: boolean): string {
  return solidityPackedKeccak256(["string", "address", "bool"], [fieldString, resolverProxy, revocable]);
}

/// Given a map of resolver -> realized proxy address, compute every schema UID.
export function computeAllSchemaUIDs(proxies: Record<ResolverName, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of SCHEMAS) {
    out[s.name] = computeSchemaUID(s.fieldString, proxies[s.resolver], s.revocable);
  }
  return out;
}
