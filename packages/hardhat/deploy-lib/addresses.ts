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

/// The canonical EFS.eth Safe (team multisig) the Sepolia/mainnet ceremony deploys FROM (PR #24
/// 50yr-review, M-4). Because the Safe is the CreateX caller, it is mixed into every CREATE3 salt — so
/// the realized proxy addresses AND the 9 schema UIDs are keyed to THIS address. A typo to a different
/// *valid* Safe would pass the shape checks (code + threshold + owners) yet silently key the entire
/// permanent deploy to the wrong place. So the ceremony asserts the supplied EFS_SAFE_ADDRESS equals
/// this constant on real networks. If the EFS.eth Safe address legitimately changes, update this
/// constant in the same PR that re-signs the freeze table (a deliberate edit, never a silent env typo).
/// Override only for a one-off with EFS_SAFE_EXPECTED_OVERRIDE=1 (e.g. a throwaway test Safe on a public
/// testnet) — never for the real freeze.
export const EXPECTED_EFS_SAFE = "0x1Ad8B0a3F7F6892e9206FcA4c93871FEA3cA11D7";
