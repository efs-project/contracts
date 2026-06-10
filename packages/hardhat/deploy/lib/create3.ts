// CREATE3 proxy deploy helper (Phase D deploy core) — ADR-0048, docs/DEPLOYMENT.md §3 step 2.
//
// Deploys a TransparentUpgradeableProxy (OZ v5) at a CREATE3-deterministic address via the canonical
// CreateX factory, with the resolver's `initialize(...)` calldata baked into the proxy constructor so
// deploy+init is atomic (the proxy's ERC1967 constructor calls the impl via delegatecall during
// construction). Each proxy auto-creates its own ProxyAdmin owned by `initialOwner` (the deployer).
//
// Address determinism: EFS uses PERMISSIONED salts (leading 20 bytes = deployer) with the cross-chain
// redeploy flag byte (#20) = 0x00. CreateX then derives the address from the GUARDED salt
// `keccak256(deployer ++ rawSalt)`. The address depends only on (deployer EOA, rawSalt) — identical on
// Sepolia and mainnet for the same deployer, which is exactly the parity property we want (same proxy
// address ⇒ same schema UID ⇒ portable data). See ICreateX.sol NatSpec + docs/DEPLOYMENT.md §1.

import { AbiCoder, Contract, Signer, concat, getBytes, hexlify, keccak256, solidityPacked, zeroPadValue } from "ethers";
import { ethers } from "hardhat";
import { CREATEX_ADDRESS } from "./addresses";
import type { ResolverName } from "./schemas";

/// Committed, FROZEN per-resolver salt entropy (bytes 21..31 of the raw salt — 11 bytes). These are
/// parity-critical: the realized proxy address is a function of (deployer, salt), so changing a salt
/// changes the address and every UID baked against it. Frozen at Phase D; do not edit without a new
/// ADR + a full re-freeze of the affected schema(s). Chosen as the ASCII tag of the resolver, left-
/// padded — human-legible in the salt and collision-free across the six resolvers.
// Each value is exactly 11 bytes (bytes 21..31 of the raw salt). The bytes are the ASCII tag of the
// resolver, right-aligned and zero-padded — human-legible in the salt and collision-free.
export const RESOLVER_SALT_ENTROPY: Record<ResolverName, string> = {
  EFSIndexer: "0x00656673696e6465786572", // "efsindexer" (11 bytes)
  EdgeResolver: "0x0000000000000065646765", // "edge" (11 bytes)
  MirrorResolver: "0x00000000006d6972726f72", // "mirror" (11 bytes)
  ListResolver: "0x000000000000006c697374", // "list" (11 bytes)
  ListEntryResolver: "0x00006c697374656e747279", // "listentry" (11 bytes)
  AliasResolver: "0x000000000000616c696173", // "alias" (11 bytes)
};

/// Build the FULL 32-byte raw salt for a resolver: leading 20 bytes = deployer (permissioned),
/// byte 20 = 0x00 (no cross-chain redeploy protection — address keyed on (deployer, salt)),
/// bytes 21..31 = the committed 11-byte entropy.
export function buildRawSalt(deployer: string, resolver: ResolverName): string {
  const entropy = RESOLVER_SALT_ENTROPY[resolver];
  const entropyBytes = getBytes(zeroPadValue(entropy, 11)); // right-aligned 11 bytes
  return hexlify(
    concat([
      getBytes(deployer), // 20 bytes, permissioned-sender prefix
      "0x00", // byte 20: redeploy-protection flag = False (cross-chain-parity address)
      entropyBytes, // bytes 21..31
    ]),
  ); // 32-byte hex string
}

/// The guarded salt CreateX uses internally for a permissioned salt with flag byte 0x00:
/// `keccak256(abi.encodePacked(bytes32(uint256(uint160(deployer))), rawSalt))`.
export function guardedSalt(deployer: string, rawSalt: string): string {
  return keccak256(solidityPacked(["bytes32", "bytes32"], [zeroPadValue(deployer, 32), rawSalt]));
}

/// A CreateX handle bound to the canonical factory address.
export async function getCreateX(signer: Signer): Promise<Contract> {
  return (await ethers.getContractAt("ICreateX", CREATEX_ADDRESS, signer)) as unknown as Contract;
}

/// Build the TransparentUpgradeableProxy creation bytecode: proxy initcode ++
/// abi.encode(impl, initialOwner, initCalldata). The proxy constructor runs the resolver's
/// initialize() atomically via delegatecall and spins up a ProxyAdmin(initialOwner).
export async function buildProxyInitCode(
  implAddr: string,
  initialOwner: string,
  initCalldata: string,
): Promise<string> {
  const ProxyFactory = await ethers.getContractFactory("TransparentUpgradeableProxy");
  const tx = await ProxyFactory.getDeployTransaction(implAddr, initialOwner, initCalldata);
  return tx.data as string;
}

/// Predict the CREATE3 proxy address for a resolver, given the deployer.
export async function predictProxyAddress(
  createx: Contract,
  deployer: string,
  resolver: ResolverName,
): Promise<{ rawSalt: string; predicted: string }> {
  const rawSalt = buildRawSalt(deployer, resolver);
  const gSalt = guardedSalt(deployer, rawSalt);
  const predicted: string = await createx.computeCreate3Address(gSalt);
  return { rawSalt, predicted };
}

export interface Create3DeployResult {
  resolver: ResolverName;
  impl: string;
  proxy: string;
  predicted: string;
  proxyAdmin: string;
  rawSalt: string;
}

/// Deploy a resolver impl + its CREATE3 TransparentUpgradeableProxy (atomic init), asserting the
/// realized proxy address equals the CREATE3-predicted address. Returns impl/proxy/proxyAdmin/salt.
export async function deployResolverViaCreate3(
  createx: Contract,
  deployer: Signer,
  resolver: ResolverName,
  constructorArgs: unknown[],
  initFn: string,
  initArgs: unknown[],
): Promise<Create3DeployResult> {
  const deployerAddr = await deployer.getAddress();

  // (1) Resolver implementation (non-deterministic address — not in any UID).
  const ImplFactory = await ethers.getContractFactory(resolver, deployer);
  const impl = await ImplFactory.deploy(...constructorArgs);
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();

  // (2) Predict the proxy's CREATE3 address.
  const { rawSalt, predicted } = await predictProxyAddress(createx, deployerAddr, resolver);

  // (3) Build proxy initcode with the resolver's initialize() baked in (atomic deploy+init).
  const initCalldata = impl.interface.encodeFunctionData(initFn, initArgs);
  const proxyInitCode = await buildProxyInitCode(implAddr, deployerAddr, initCalldata);

  // (4) Deploy via CreateX. Parse the realized proxy address from the return + the ProxyAdmin from
  //     the AdminChanged event the proxy emits in its ERC1967 constructor.
  const tx = await createx["deployCreate3(bytes32,bytes)"](rawSalt, proxyInitCode);
  const receipt = await tx.wait();

  const proxyAddr: string = await createx.computeCreate3Address(guardedSalt(deployerAddr, rawSalt));
  if (proxyAddr.toLowerCase() !== predicted.toLowerCase()) {
    throw new Error(`CREATE3 ${resolver}: predicted/realized mismatch (${predicted} != ${proxyAddr})`);
  }
  const code = await ethers.provider.getCode(proxyAddr);
  if (code === "0x") {
    throw new Error(`CREATE3 ${resolver}: no code at predicted proxy address ${proxyAddr}`);
  }

  // ProxyAdmin: TransparentUpgradeableProxy emits AdminChanged(address(0), proxyAdmin) on construction.
  const proxyAdmin = await readProxyAdminFromReceipt(receipt, proxyAddr);

  return { resolver, impl: implAddr, proxy: proxyAddr, predicted, proxyAdmin, rawSalt };
}

const ADMIN_CHANGED_TOPIC = keccak256(ethers.toUtf8Bytes("AdminChanged(address,address)"));

/// Extract the ProxyAdmin address for `proxyAddr` from an AdminChanged event in the deploy receipt.
/// OZ's `AdminChanged(address previousAdmin, address newAdmin)` has both args NON-indexed, so they
/// live in `log.data` as two 32-byte words; the second word is the ProxyAdmin address.
async function readProxyAdminFromReceipt(receipt: any, proxyAddr: string): Promise<string> {
  for (const log of receipt?.logs ?? []) {
    if ((log.address as string).toLowerCase() === proxyAddr.toLowerCase() && log.topics?.[0] === ADMIN_CHANGED_TOPIC) {
      const [, newAdmin] = AbiCoder.defaultAbiCoder().decode(["address", "address"], log.data);
      return ethers.getAddress(newAdmin);
    }
  }
  throw new Error(`Could not locate ProxyAdmin (AdminChanged event) for proxy ${proxyAddr}`);
}
