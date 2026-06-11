// Safe transaction-builder layer for the Safe-native EFS deploy (docs/DEPLOYMENT.md §1, §3-§4).
//
// Why this exists: a Gnosis Safe has NO private key. It executes via owner-signed Safe transactions
// (`execTransaction`), not the EOA-signing that orchestrate.ts assumes. To deploy the whole EFS system
// *from* the EFS.eth Safe (so every CREATE3 address + the root-scaffolding authorship trace to the
// multisig, and everything is born owned by the Safe — no transfer phase), we precompute the whole
// per-phase call list off-chain and submit it as ONE MultiSend batch the Safe executes.
//
// This layer deliberately drives the *canonical on-chain Safe v1.4.1 contracts directly* via ethers
// rather than depending on `@safe-global/protocol-kit`. Everything protocol-kit would do here —
// MultiSend encoding, the EIP-712 SafeTx hash, `execTransaction` — is a thin wrapper over calldata we
// can build against stable ABIs, and the canonical Safe singleton + factory + MultiSendCallOnly are
// already present on the pinned Sepolia fork (and on real Sepolia/mainnet). Adding the SDK would pull
// a large dependency tree for no runtime gain on the deploy path. The owner-signing model is designed
// for the real threshold-N Safe (collect N EIP-712 signatures, concatenate sorted by signer); the
// fork rehearsal uses a 1-of-1 test Safe whose single owner is the test signer.
//
// MultiSend vs MultiSendCallOnly: the Safe `delegatecall`s the MultiSend contract, so the batch runs
// in the Safe's storage/identity context — msg.sender to every inner call IS the Safe. That is exactly
// what makes the CREATE3 addresses Safe-keyed (CreateX's permissioned-salt guard matches the Safe) and
// the scaffolding attester == SystemAccount-owned-by-Safe. We use MultiSendCallOnly: every inner op is
// a plain CALL (never a nested delegatecall), and CallOnly hard-rejects any delegatecall op, which is
// the safer batch primitive for a deploy that should only ever CALL CreateX / the proxies / EAS.

import { AbiCoder, Contract, Signer, ZeroAddress, concat, getBytes, keccak256, solidityPacked, toBeHex } from "ethers";
import { ethers } from "hardhat";

/// Canonical Safe v1.4.1 deployment addresses — identical on Sepolia, mainnet, and most chains, and
/// confirmed present on the pinned Sepolia fork (FORK_BLOCK). These are the deterministic Safe
/// singleton-factory deployments; see https://github.com/safe-global/safe-deployments.
export const SAFE_PROXY_FACTORY_141 = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
export const SAFE_SINGLETON_141 = "0x41675C099F32341bf84BFc5382aF534df5C7461a";
export const SAFE_L2_SINGLETON_141 = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
export const SAFE_MULTISEND_CALL_ONLY_141 = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2";
export const SAFE_COMPAT_FALLBACK_HANDLER_141 = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99";

/// One leg of a MultiSend batch — a plain CALL the Safe makes (in its own context).
export interface SafeCall {
  to: string;
  value?: bigint;
  data: string;
  /// Human label for logging / the freeze ledger (not encoded).
  label?: string;
}

const ABI = AbiCoder.defaultAbiCoder();

// ── MultiSend encoding ─────────────────────────────────────────────────────────────────────────────
// MultiSend's `multiSend(bytes transactions)` expects the txs tightly packed (NOT abi-encoded):
//   operation (uint8) ++ to (address,20) ++ value (uint256,32) ++ dataLength (uint256,32) ++ data.
// Operation is 0 (CALL) for every leg — MultiSendCallOnly reverts on operation==1 (delegatecall).
export function encodeMultiSend(calls: SafeCall[]): string {
  const parts = calls.map(c => {
    const data = getBytes(c.data);
    return solidityPacked(
      ["uint8", "address", "uint256", "uint256", "bytes"],
      [0, c.to, c.value ?? 0n, BigInt(data.length), data],
    );
  });
  const packed = concat(parts);
  const multiSendIface = new ethers.Interface(["function multiSend(bytes transactions) payable"]);
  return multiSendIface.encodeFunctionData("multiSend", [packed]);
}

// ── SafeTx (EIP-712) ────────────────────────────────────────────────────────────────────────────────
// Safe v1.4.1 SafeTx struct + the domain that `getTransactionHash` / `execTransaction` use.
const SAFE_TX_TYPE = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
};

export interface SafeTx {
  to: string;
  value: bigint;
  data: string;
  operation: number; // 0=CALL, 1=DELEGATECALL
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: string;
  refundReceiver: string;
  nonce: bigint;
}

/// Build the SafeTx that executes a MultiSend batch. The batch is a single DELEGATECALL (operation=1)
/// from the Safe to MultiSendCallOnly, so the batch's inner CALLs all run with msg.sender == the Safe.
export function buildBatchSafeTx(multiSendCalldata: string, nonce: bigint): SafeTx {
  return {
    to: SAFE_MULTISEND_CALL_ONLY_141,
    value: 0n,
    data: multiSendCalldata,
    operation: 1, // DELEGATECALL into MultiSend so inner calls keep the Safe as msg.sender
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZeroAddress,
    refundReceiver: ZeroAddress,
    nonce,
  };
}

const SAFE_ABI = [
  "function nonce() view returns (uint256)",
  "function getThreshold() view returns (uint256)",
  "function isOwner(address) view returns (bool)",
  "function getOwners() view returns (address[])",
  "function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)",
];

export async function getSafe(safeAddress: string, runner: Signer): Promise<Contract> {
  return new ethers.Contract(safeAddress, SAFE_ABI, runner);
}

/// The EIP-712 SafeTx hash for a v1.4.1 Safe (`domain = {chainId, verifyingContract: safe}`). We read
/// it back from the Safe's own `getTransactionHash` and assert parity, so a domain/typo drift fails
/// loudly rather than producing an unverifiable signature.
export async function safeTxHash(safe: Contract, tx: SafeTx): Promise<string> {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const domain = { chainId, verifyingContract: await safe.getAddress() };
  const local = ethers.TypedDataEncoder.hash(domain, SAFE_TX_TYPE, tx as unknown as Record<string, unknown>);
  const onchain: string = await safe.getTransactionHash(
    tx.to,
    tx.value,
    tx.data,
    tx.operation,
    tx.safeTxGas,
    tx.baseGas,
    tx.gasPrice,
    tx.gasToken,
    tx.refundReceiver,
    tx.nonce,
  );
  if (local.toLowerCase() !== onchain.toLowerCase()) {
    throw new Error(`SafeTx hash mismatch: local ${local} != on-chain ${onchain} (domain/type drift)`);
  }
  return onchain;
}

/// Collect threshold-N owner EIP-712 signatures over the SafeTx and concatenate them in the order Safe
/// requires (ascending by signer address). Each owner signs the typed SafeTx; we use the EIP-712 sig
/// directly (v = 27/28), which Safe validates as an `eth_sign`-free ECDSA owner signature.
///
/// For the fork rehearsal the Safe is 1-of-1 and `owners` is a single test signer. For the real Safe,
/// pass the N owner signers (or pre-collected signatures) — the design is threshold-N, the rehearsal
/// just instantiates it at N=1.
export async function signSafeTx(safe: Contract, tx: SafeTx, owners: Signer[]): Promise<string> {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const domain = { chainId, verifyingContract: await safe.getAddress() };
  // Assert the local hash matches the Safe's own derivation before signing.
  await safeTxHash(safe, tx);

  const sigs: { signer: string; sig: string }[] = [];
  for (const owner of owners) {
    const signer = await owner.getAddress();
    // ethers v6 signs EIP-712 and returns a 65-byte sig with v in {27,28} — exactly what Safe expects
    // for a contract-validated ECDSA owner signature.
    const sig = await (
      owner as unknown as { signTypedData: (d: unknown, t: unknown, v: unknown) => Promise<string> }
    ).signTypedData(domain, SAFE_TX_TYPE, tx as unknown as Record<string, unknown>);
    sigs.push({ signer, sig });
  }
  // Safe requires signatures sorted ascending by signer address.
  sigs.sort((a, b) => (a.signer.toLowerCase() < b.signer.toLowerCase() ? -1 : 1));
  return concat(sigs.map(s => s.sig));
}

/// Execute a prepared SafeTx through `execTransaction`, paid for by `executor` (any account — gas is
/// the executor's; authority is the owner signatures). Returns the tx receipt.
export async function execSafeTx(safe: Contract, tx: SafeTx, signatures: string, executor: Signer): Promise<unknown> {
  const safeWithExecutor = safe.connect(executor) as Contract;
  const sent = await safeWithExecutor.execTransaction(
    tx.to,
    tx.value,
    tx.data,
    tx.operation,
    tx.safeTxGas,
    tx.baseGas,
    tx.gasPrice,
    tx.gasToken,
    tx.refundReceiver,
    signatures,
  );
  return sent.wait();
}

/// Convenience: build → sign (1-of-N owners) → execute a MultiSend batch as the Safe, in one call.
/// Returns the receipt and the SafeTx hash (useful for the freeze ledger).
export async function executeBatchAsSafe(
  safe: Contract,
  calls: SafeCall[],
  owners: Signer[],
  executor: Signer,
): Promise<{ receipt: unknown; txHash: string; nonce: bigint }> {
  const nonce: bigint = await safe.nonce();
  const multiSend = encodeMultiSend(calls);
  const tx = buildBatchSafeTx(multiSend, nonce);
  const txHash = await safeTxHash(safe, tx);
  const signatures = await signSafeTx(safe, tx, owners);
  const receipt = await execSafeTx(safe, tx, signatures, executor);
  return { receipt, txHash, nonce };
}

// ── Deploy a fresh 1-of-1 test Safe on a fork (rehearsal only) ───────────────────────────────────────
// Real deploys use the existing EFS.eth Safe; this stands up a throwaway canonical Safe via the
// canonical SafeProxyFactory + singleton so the fork rehearsal exercises real Safe execution (not a
// mock). `setup(...)` initializes owners + threshold; we use the v1.4.1 singleton (the non-L2 variant
// is fine on a single chain — same execTransaction semantics).
const PROXY_FACTORY_ABI = [
  "function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
  "event ProxyCreation(address indexed proxy, address singleton)",
];
const SAFE_SETUP_ABI = [
  "function setup(address[] _owners,uint256 _threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address payable paymentReceiver)",
];

export async function deployTestSafe(deployer: Signer, owners: string[], threshold: number): Promise<string> {
  const factory = new ethers.Contract(SAFE_PROXY_FACTORY_141, PROXY_FACTORY_ABI, deployer);
  const setupIface = new ethers.Interface(SAFE_SETUP_ABI);
  const initializer = setupIface.encodeFunctionData("setup", [
    owners,
    threshold,
    ZeroAddress, // to
    "0x", // data
    SAFE_COMPAT_FALLBACK_HANDLER_141,
    ZeroAddress, // paymentToken
    0, // payment
    ZeroAddress, // paymentReceiver
  ]);
  const saltNonce = BigInt(keccak256(toBeHex(BigInt(Date.now()), 32)));
  const tx = await factory.createProxyWithNonce(SAFE_SINGLETON_141, initializer, saltNonce);
  const receipt = await tx.wait();
  // Parse the ProxyCreation event for the proxy address.
  for (const log of receipt?.logs ?? []) {
    try {
      const parsed = factory.interface.parseLog({ topics: log.topics, data: log.data });
      if (parsed?.name === "ProxyCreation") return ethers.getAddress(parsed.args.proxy);
    } catch {
      /* not ours */
    }
  }
  // Fallback: compute from CreateX-less proxy creation is non-trivial; require the event.
  throw new Error("deployTestSafe: ProxyCreation event not found");
}

void ABI;
