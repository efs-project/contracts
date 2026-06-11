// Canonical chain constants for the EFS deploy (Phase D).
//
// EAS + SchemaRegistry are the canonical Sepolia deployments (also present on the pinned Sepolia
// fork). CreateX is the canonical cross-chain factory (same address everywhere). These are the
// per-chain constants the verify gate asserts against (`proxy.getEAS() == EAS`).

/// CreateX canonical factory — identical address on Sepolia, mainnet, and most chains.
export const CREATEX_ADDRESS = "0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed";

/// EAS on Sepolia (and the pinned fork).
export const EAS_ADDRESS = "0xC2679fBD37d54388Ce493F1DB75320D236e1815e";

/// EAS SchemaRegistry on Sepolia (and the pinned fork). The deploy reads it from EAS at runtime and
/// falls back to this constant.
export const SCHEMA_REGISTRY_ADDRESS = "0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0";
