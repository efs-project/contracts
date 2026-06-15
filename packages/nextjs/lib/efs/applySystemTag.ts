/**
 * applySystemTag — SDK SEAM (plain async, no React).
 * ============================================================================
 *
 * Attests the DATA-targeted "system" TAG that marks a piece of content as a
 * system-managed item (e.g. an Overview / README DATA), mirroring the seed's
 * `tagSystemIfMissing` (`packages/hardhat/scripts/seed-impl.ts`).
 *
 * Plain async function — `attest` is injected for the same reason as in
 * `uploadOnchainFile`: it is a `useScaffoldWriteContract` hook handle that
 * cannot be called inside a plain function.
 *
 * Shape (matches seed-impl `makeTag(dataUID, systemDefUID, 1n)`):
 *   schema  = tagSchemaUID
 *   refUID  = dataUID            (DATA-targeted)
 *   data    = encode(["bytes32","int256"], [systemDefUID, 1n])
 *   revocable = true
 *
 * systemDefUID is resolved as: root → /tags → /tags/system. On the devnet seed
 * those folders already exist; if a folder is missing we create the generic
 * folder ANCHOR(s) (name + schema=ZeroHash), mirroring the seed's
 * getOrCreateFolder.
 */
import type { AttestFn } from "./uploadOnchainFile";
import { decodeEventLog, encodeAbiParameters, parseAbiItem, zeroAddress, zeroHash } from "viem";
import type { Abi, PublicClient, TransactionReceipt, WalletClient } from "viem";

export interface ApplySystemTagArgs {
  dataUID: `0x${string}`;

  walletClient: WalletClient;
  publicClient: PublicClient;

  attest: AttestFn;

  indexerAddress: `0x${string}`;
  indexerAbi: Abi;

  anchorSchemaUID: `0x${string}`;
  tagSchemaUID: `0x${string}`;

  edgeResolverAddress: `0x${string}`;
  edgeResolverAbi: Abi;
}

// `hasActiveTagFromAny` is NOT part of the exported EDGE_RESOLVER_ABI in
// utils/efs/edgeResolver.ts, so we declare the one fragment we need here. It is
// the TAG-specific idempotency check used by the seed's tagSystemIfMissing.
const HAS_ACTIVE_TAG_FROM_ANY_ABI = [
  {
    inputs: [
      { internalType: "bytes32", name: "targetID", type: "bytes32" },
      { internalType: "bytes32", name: "definition", type: "bytes32" },
      { internalType: "address[]", name: "attesters", type: "address[]" },
    ],
    name: "hasActiveTagFromAny",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
] as const satisfies Abi;

function extractUIDFromReceipt(receipt: TransactionReceipt): `0x${string}` | undefined {
  for (const log of receipt.logs) {
    try {
      const event = decodeEventLog({
        abi: [
          parseAbiItem(
            "event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)",
          ),
        ],
        data: log.data,
        topics: log.topics,
      });
      return (event.args as { uid: `0x${string}` }).uid;
    } catch {
      // not our event
    }
  }
  return undefined;
}

/**
 * Apply the system TAG to `dataUID`. Idempotent — returns early if the caller
 * already has an active system TAG on this DATA.
 */
export async function applySystemTag(args: ApplySystemTagArgs): Promise<void> {
  const {
    dataUID,
    walletClient,
    publicClient,
    attest,
    indexerAddress,
    indexerAbi,
    anchorSchemaUID,
    tagSchemaUID,
    edgeResolverAddress,
    edgeResolverAbi,
  } = args;

  // The idempotency check needs `hasActiveTagFromAny`, which isn't in the
  // exported EDGE_RESOLVER_ABI the caller passes. Merge the caller's abi with the
  // local fragment so the call resolves regardless of which the caller supplied.
  const resolverAbi = [...edgeResolverAbi, ...HAS_ACTIVE_TAG_FROM_ANY_ABI] as Abi;

  const account = walletClient.account;
  if (!account) throw new Error("walletClient has no account");

  // ── Resolve root → /tags → /tags/system, creating missing folders ──
  const rootUID = (await publicClient.readContract({
    address: indexerAddress,
    abi: indexerAbi,
    functionName: "rootAnchorUID",
  })) as `0x${string}`;

  // getOrCreateFolder: returns the generic-folder anchor at (parent, name),
  // creating it (ANCHOR with schema=ZeroHash) if absent. Mirrors seed-impl.
  const getOrCreateFolder = async (parentUID: `0x${string}`, name: string): Promise<`0x${string}`> => {
    const existing = (await publicClient.readContract({
      address: indexerAddress,
      abi: indexerAbi,
      functionName: "resolveAnchor",
      args: [parentUID, name, zeroHash],
    })) as `0x${string}`;
    if (existing && existing !== zeroHash) return existing;

    const encodedName = encodeAbiParameters(
      [
        { name: "name", type: "string" },
        { name: "schemaUID", type: "bytes32" },
      ],
      [name, zeroHash],
    );
    const tx = await attest(
      {
        functionName: "attest",
        args: [
          {
            schema: anchorSchemaUID,
            data: {
              recipient: zeroAddress,
              expirationTime: 0n,
              revocable: false,
              refUID: parentUID,
              data: encodedName,
              value: 0n,
            },
          },
        ],
      },
      { silent: true },
    );
    if (!tx) throw new Error(`No txHash returned for '${name}' folder anchor creation.`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
    const uid = extractUIDFromReceipt(receipt);
    if (!uid) throw new Error(`Could not extract '${name}' folder anchor UID`);
    return uid;
  };

  const tagsUID = await getOrCreateFolder(rootUID, "tags");
  const systemDefUID = await getOrCreateFolder(tagsUID, "system");

  // ── Idempotency: skip if this attester already has an active system TAG ──
  const already = (await publicClient.readContract({
    address: edgeResolverAddress,
    abi: resolverAbi,
    functionName: "hasActiveTagFromAny",
    args: [dataUID, systemDefUID, [account.address]],
  })) as boolean;
  if (already) return;

  // ── Attest the DATA-targeted system TAG (weight 1, matches makeTag) ──
  const encodedTag = encodeAbiParameters(
    [
      { name: "definition", type: "bytes32" },
      { name: "weight", type: "int256" },
    ],
    [systemDefUID, 1n],
  );
  const tagTx = await attest(
    {
      functionName: "attest",
      args: [
        {
          schema: tagSchemaUID,
          data: {
            recipient: zeroAddress,
            expirationTime: 0n,
            revocable: true,
            refUID: dataUID,
            data: encodedTag,
            value: 0n,
          },
        },
      ],
    },
    { silent: true },
  );
  if (!tagTx) throw new Error("system TAG attestation did not return a transaction hash.");
  await publicClient.waitForTransactionReceipt({ hash: tagTx });
}
