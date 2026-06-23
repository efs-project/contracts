"use client";

import { useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { decodeEventLog, encodeAbiParameters, parseAbiItem, zeroAddress, zeroHash } from "viem";
import { usePublicClient, useReadContract, useWalletClient } from "wagmi";
import { Cog6ToothIcon, StopIcon } from "@heroicons/react/24/outline";
import { useSortDiscovery } from "~~/hooks/efs/useSortDiscovery";
import { useDeployedContractInfo, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
import { useTargetNetwork } from "~~/hooks/scaffold-eth/useTargetNetwork";
import { createExternalFileReference, uploadOnchainFile } from "~~/lib/efs/uploadOnchainFile";
import { useBackgroundOps } from "~~/services/store/backgroundOps";
import type { ClassifiedContainer } from "~~/utils/efs/containers";
import { EDGE_RESOLVER_ABI, getEdgeResolverAddress } from "~~/utils/efs/edgeResolver";
import { SORT_OVERLAY_ABI } from "~~/utils/efs/sortOverlay";
import { TRANSPORT_LABELS, computeContentHash, detectTransport, resolveGatewayUrl } from "~~/utils/efs/transports";
import { ensureWalletChain, notification } from "~~/utils/scaffold-eth";

export type CreationType = "Folder" | "File" | "PasteLink" | "List";

// Reserved bytes that MUST be percent-encoded (UPPERCASE %XX) in a canonical
// anchor name — mirrors EFSIndexer.sol::_isReservedByte. NOTE: '%' (0x25) is
// deliberately NOT here; the escape parser in validateAnchorName handles it.
function isReservedAnchorByte(b: number): boolean {
  if (b < 0x20 || b === 0x7f) return true; // C0 controls + DEL
  // space " # & / : = ? @ [ \ ] ^ ` { | }
  return [
    0x20, 0x22, 0x23, 0x26, 0x2f, 0x3a, 0x3d, 0x3f, 0x40, 0x5b, 0x5c, 0x5d, 0x5e, 0x60, 0x7b, 0x7c, 0x7d,
  ].includes(b);
}

const isUpperHex = (b: number): boolean => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46); // 0-9 A-F
const hexNibble = (b: number): number => (b <= 0x39 ? b - 0x30 : b - 0x41 + 10);
const hex2 = (b: number): string => b.toString(16).toUpperCase().padStart(2, "0");

// Mirrors EFSIndexer.sol::_isValidAnchorName exactly so the client precheck and the on-chain rule
// agree: a name accepted here is accepted on-chain, and vice versa. The canonical form (ADR-0025)
// gives every name ONE on-chain spelling — reserved bytes appear ONLY as UPPERCASE %XX escapes,
// every other byte (including high-bit UTF-8) appears bare. Reserved characters are therefore typed
// as their %XX escape (e.g. a literal "/" → "%2F"); auto-encoding is deliberately not done here so
// the entered string is exactly what gets attested.
function validateAnchorName(rawName: string): string | null {
  // NFC-normalize first (ADR-0025): the canonical on-chain name is NFC + percent-encoding, and the
  // contract can't verify normalization, so the client MUST. Validating (and, at submit, attesting) the
  // NFC form means precomposed "é" and decomposed "é" map to ONE permanent anchor, not two.
  const name = rawName.normalize("NFC");
  if (name.length === 0) return "Name cannot be empty.";
  if (name === "." || name === "..") return "Name cannot be '.' or '..'.";
  const bytes = new TextEncoder().encode(name);
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    if (c === 0x25) {
      // '%' must introduce a canonical UPPERCASE %XX escape carrying a reserved byte (or '%' itself).
      if (i + 2 >= bytes.length)
        return "Incomplete escape: '%' must be followed by two uppercase hex digits (e.g. %2F).";
      const h1 = bytes[i + 1];
      const h2 = bytes[i + 2];
      if (!isUpperHex(h1) || !isUpperHex(h2)) return "Percent-escapes must use UPPERCASE hex (e.g. %2F, not %2f).";
      const decoded = (hexNibble(h1) << 4) | hexNibble(h2);
      if (!isReservedAnchorByte(decoded) && decoded !== 0x25)
        return `%${String.fromCharCode(h1)}${String.fromCharCode(h2)} is not allowed: only reserved characters may be percent-encoded; write unreserved bytes bare.`;
      i += 2; // consume the two hex digits
    } else if (isReservedAnchorByte(c)) {
      const label =
        c === 0x20 ? "space" : c < 0x20 || c === 0x7f ? `control byte 0x${hex2(c)}` : `'${String.fromCharCode(c)}'`;
      return `Name cannot contain a bare ${label}; percent-encode it as %${hex2(c)}.`;
    }
  }
  return null;
}

/**
 * Best-effort extraction of a human-readable message from viem/wagmi/ethers errors.
 * Falls back to a short generic message — never swallows silently.
 */
function extractErrorMessage(e: unknown): string {
  const anyErr = e as {
    shortMessage?: string;
    details?: string;
    message?: string;
    cause?: { details?: string; shortMessage?: string };
  };
  if (typeof anyErr?.details === "string" && anyErr.details.length < 200) return anyErr.details;
  if (typeof anyErr?.cause?.details === "string") return anyErr.cause.details;
  if (typeof anyErr?.shortMessage === "string") return anyErr.shortMessage;
  if (typeof anyErr?.cause?.shortMessage === "string") return anyErr.cause.shortMessage;
  if (typeof anyErr?.message === "string") return anyErr.message.slice(0, 200);
  return "Creation failed. See console.";
}

const INDEXER_CHILDREN_ABI = [
  {
    inputs: [
      { internalType: "bytes32", name: "parentUID", type: "bytes32" },
      { internalType: "uint256", name: "index", type: "uint256" },
    ],
    name: "getChildAt",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "parentUID", type: "bytes32" },
      { internalType: "bytes32", name: "schema", type: "bytes32" },
      { internalType: "uint256", name: "index", type: "uint256" },
    ],
    name: "getChildBySchemaAt",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export type CreateItemModalProps = {
  /** Open the modal with this creation type. `null` closes it. */
  creationType: CreationType | null;
  onClose: () => void;

  /** Parent anchor the new item attaches to. */
  currentAnchorUID: string | null;

  /**
   * The resolved top-level container. When a direct child of an Address
   * container is being created, EAS refuses refUID = bytes32(uint160(addr))
   * (it's not a valid attestation UID), so the new anchor must be attested
   * with `refUID = 0, recipient = addr` instead — EFSIndexer.onAttest then
   * re-derives the parent as `bytes32(uint160(recipient))`. Schema and
   * attestation containers resolve through an alias anchor (a real
   * attestation) so the standard path applies; if no alias exists, raw
   * schema UIDs also fail EAS validation and we fall back in the same way.
   */
  container?: ClassifiedContainer | null;

  anchorSchemaUID: string;
  dataSchemaUID: string;
  propertySchemaUID: string;
  // PIN/TAG schema split (ADR-0041): file placement and PROPERTY value bindings
  // are PIN (cardinality 1); descriptive labels and folder visibility are TAG (cardinality N).
  pinSchemaUID: string;
  tagSchemaUID: string;
  mirrorSchemaUID: string;

  indexerAddress?: `0x${string}`;
  easAddress?: `0x${string}`;
  sortOverlayAddress?: `0x${string}`;
  lensAddresses?: string[];

  /** Called after a folder is created. */
  onFolderCreated?: (uid: string, name: string) => void;
  /** Called after a file is uploaded. Passes the sort UIDs the user wants auto-processed. */
  onFileCreated?: (enabledSortUIDs: string[]) => void;
  /** Called after a list is created. Receives the list-slot ANCHOR UID (not the LIST UID). */
  onListCreated?: (anchorUID: string) => void;
};

export const CreateItemModal = ({
  creationType,
  onClose,
  currentAnchorUID,
  container,
  anchorSchemaUID,
  dataSchemaUID,
  propertySchemaUID,
  pinSchemaUID,
  tagSchemaUID,
  mirrorSchemaUID,
  indexerAddress,
  easAddress: _easAddress,
  sortOverlayAddress,
  lensAddresses,
  onFolderCreated,
  onFileCreated,
  onListCreated,
}: CreateItemModalProps) => {
  const { writeContractAsync: attest } = useScaffoldWriteContract({ contractName: "EAS" });
  const { data: indexer } = useDeployedContractInfo({ contractName: "Indexer" });
  // EAS address for the batched `multiAttest` upload seam. Prefer the prop; fall
  // back to the deployed-contracts registry so File upload works even if the prop
  // wasn't threaded through.
  const { data: easInfo } = useDeployedContractInfo({ contractName: "EAS" });
  const easAddress = _easAddress ?? (easInfo?.address as `0x${string}` | undefined);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: listReaderInfo } = useDeployedContractInfo({ contractName: "ListReader" as any });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listReaderAddress = (listReaderInfo as any)?.address as `0x${string}` | undefined;
  const { targetNetwork } = useTargetNetwork();
  const { data: listSchemaUID } = useReadContract({
    chainId: targetNetwork.id,
    address: listReaderAddress,
    abi: [
      {
        inputs: [],
        name: "LIST_SCHEMA_UID",
        outputs: [{ name: "", type: "bytes32" }],
        stateMutability: "view",
        type: "function",
      },
    ] as const,
    functionName: "LIST_SCHEMA_UID",
    query: { enabled: !!listReaderAddress },
  });

  const [internalType, setInternalType] = useState<CreationType | null>(creationType);
  const [newName, setNewName] = useState("");
  const [fileToUpload, setFileToUpload] = useState<File | null>(null);
  const [pasteUri, setPasteUri] = useState("");
  const [pasteContentType, setPasteContentType] = useState("");
  const [pasteSize, setPasteSize] = useState("");
  const [pasteContentHash, setPasteContentHash] = useState<`0x${string}` | null>(null);
  const [isFetchingInfo, setIsFetchingInfo] = useState(false);
  // Mirror of the live pasteUri readable from inside an in-flight handleFetchInfo (whose closed-over
  // `pasteUri` is frozen at call time). Lets a fetch detect a mid-flight URI edit and discard its now-
  // stale HEAD/GET results instead of binding URI-A's hash/size/type onto URI-B's DATA (PR #24 P2).
  const latestPasteUriRef = useRef(pasteUri);
  useEffect(() => {
    latestPasteUriRef.current = pasteUri;
  }, [pasteUri]);
  const [showPasteDetails, setShowPasteDetails] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [canCancelSubmit, setCanCancelSubmit] = useState(true);
  const [existingAnchorWarning, setExistingAnchorWarning] = useState(false);

  // List-specific state (ADR-0044)
  const [listName, setListName] = useState("");
  const [listTargetType, setListTargetType] = useState<0 | 1 | 2>(0); // default ANY
  const [listAllowsDuplicates, setListAllowsDuplicates] = useState(false);
  const [listAppendOnly, setListAppendOnly] = useState(false);
  const [listTargetSchema, setListTargetSchema] = useState("");
  const [listMaxEntries, setListMaxEntries] = useState("0");
  const [showListRules, setShowListRules] = useState(false);

  // Only surface the inline error once the user has typed something; empty-name
  // is already covered by the disabled submit button.
  const nameValidationError = newName ? validateAnchorName(newName) : null;

  const { availableSorts } = useSortDiscovery({
    parentAnchor: currentAnchorUID ?? undefined,
    indexerAddress,
    easAddress: _easAddress,
    lensAddresses: lensAddresses ?? [],
  });
  const [disabledAutoSorts, setDisabledAutoSorts] = useState<Set<string>>(new Set());
  const [showSortConfig, setShowSortConfig] = useState(false);

  const enabledSortUIDs = availableSorts.filter(s => !disabledAutoSorts.has(s.sortInfoUID)).map(s => s.sortInfoUID);

  const modalRef = useRef<HTMLDialogElement>(null);
  // Flipped by the Stop button mid-upload. Checked between transactions so we
  // break cleanly on the next safe boundary (can't abort an already-broadcast tx).
  const cancelledRef = useRef(false);
  const publicClient = usePublicClient({ chainId: targetNetwork.id });
  const { data: walletClient } = useWalletClient();

  // Sync external `creationType` prop to internal state + dialog visibility.
  useEffect(() => {
    setInternalType(creationType);
    if (creationType) {
      setNewName("");
      setListName("");
      setFileToUpload(null);
      setPasteUri("");
      setPasteContentType("");
      setPasteSize("");
      setPasteContentHash(null);
      setShowPasteDetails(false);
      setExistingAnchorWarning(false);
      modalRef.current?.showModal();
    } else {
      modalRef.current?.close();
    }
  }, [creationType]);

  const handleClose = () => {
    modalRef.current?.close();
    onClose();
  };
  const requestClose = () => {
    if (isSubmitting) {
      if (canCancelSubmit) cancelledRef.current = true;
      return;
    }
    handleClose();
  };

  /** Fetch content info from a pasted URI via its gateway. */
  const handleFetchInfo = async () => {
    if (!pasteUri) return;
    const gatewayUrl = resolveGatewayUrl(pasteUri);
    if (!gatewayUrl) {
      notification.error("Cannot fetch info for this URI type. Enter values manually.");
      return;
    }
    // Capture the URI this fetch is for; discard results if the user edits the field mid-flight (P2).
    const fetchedUri = pasteUri;
    const stale = () => latestPasteUriRef.current !== fetchedUri;
    setIsFetchingInfo(true);
    setShowPasteDetails(true);
    try {
      const headResp = await fetch(gatewayUrl, { method: "HEAD" });
      if (stale()) return; // URI edited mid-flight — don't write this URI's metadata onto another
      if (!headResp.ok) throw new Error(`HTTP ${headResp.status}`);

      const ct = headResp.headers.get("content-type");
      if (ct) setPasteContentType(ct.split(";")[0].trim());

      const cl = headResp.headers.get("content-length");
      if (cl) setPasteSize(cl);

      const sizeNum = cl ? parseInt(cl, 10) : 0;
      if (sizeNum > 0 && sizeNum <= 10 * 1024 * 1024) {
        notification.info("Downloading file to compute content hash...");
        const getResp = await fetch(gatewayUrl);
        if (!getResp.ok) throw new Error(`HTTP ${getResp.status}`);
        const bytes = new Uint8Array(await getResp.arrayBuffer());
        if (stale()) return; // URI edited mid-flight — discard
        setPasteSize(String(bytes.length));
        setPasteContentHash(computeContentHash(bytes));
        notification.success("Content hash computed.");
      } else if (sizeNum > 10 * 1024 * 1024) {
        notification.info(`File is ${Math.round(sizeNum / 1024 / 1024)}MB — hash not computed (too large).`);
      } else {
        const MAX_AUTO_DOWNLOAD = 10 * 1024 * 1024;
        notification.info("Downloading file to determine size and hash (cap: 10 MB)...");
        const controller = new AbortController();
        const getResp = await fetch(gatewayUrl, { signal: controller.signal });
        if (!getResp.ok) throw new Error(`Gateway returned ${getResp.status} — cannot compute hash`);
        const reader = getResp.body?.getReader();
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        let truncated = false;
        if (reader) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done || !value) break;
              if (totalBytes + value.length > MAX_AUTO_DOWNLOAD) {
                truncated = true;
                controller.abort();
                break;
              }
              chunks.push(value);
              totalBytes += value.length;
            }
          } catch (err) {
            if (err instanceof Error && err.name !== "AbortError") throw err;
          }
        }
        if (stale()) return; // URI edited mid-flight — discard
        if (truncated) {
          notification.info("File exceeds 10 MB — hash not computed. Enter values manually.");
        } else if (totalBytes > 0) {
          const bytes = new Uint8Array(totalBytes);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          setPasteSize(String(totalBytes));
          setPasteContentHash(computeContentHash(bytes));
          notification.success("Content hash computed.");
          if (!ct) {
            const getCt = getResp.headers.get("content-type");
            if (getCt) setPasteContentType(getCt.split(";")[0].trim());
          }
        }
      }
    } catch (e) {
      console.error("Fetch info failed:", e);
      notification.error("Could not fetch info from gateway. Enter values manually.");
    } finally {
      setIsFetchingInfo(false);
    }
  };

  const extractUIDFromReceipt = (receipt: any): `0x${string}` | undefined => {
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
        return (event.args as any).uid as `0x${string}`;
      } catch {
        // not our event
      }
    }
    return undefined;
  };

  // For Address containers the top-level parent is `bytes32(uint160(addr))`,
  // which is NOT a valid EAS attestation UID. Passing it as refUID makes EAS
  // revert. EFSIndexer.onAttest has a carve-out: if refUID == 0 and recipient
  // != 0, it derives the parent as `bytes32(uint160(recipient))`. We use that
  // path only when the user is creating a direct child of the Address
  // container root; deeper children reference real anchor attestations.
  const anchorParent = (): { refUID: `0x${string}`; recipient: `0x${string}` } => {
    if (
      container?.kind === "address" &&
      container.address &&
      currentAnchorUID &&
      currentAnchorUID.toLowerCase() === container.uid.toLowerCase()
    ) {
      return { refUID: ethers.ZeroHash as `0x${string}`, recipient: container.address };
    }
    return { refUID: currentAnchorUID as `0x${string}`, recipient: ethers.ZeroAddress as `0x${string}` };
  };

  // ── List creation (ADR-0044 §1) ────────────────────────────────────────────
  // A list is placed exactly like a file: a named ANCHOR (anchorType=LIST_SCHEMA_UID)
  // under the folder, the free-floating LIST holding the config, and a PIN binding the
  // LIST to the anchor. Deleting the list later = revoking that PIN (the anchor + LIST
  // are permanent, like a file's anchor + DATA).
  const handleCreateList = async () => {
    if (!listSchemaUID) {
      notification.error("LIST_SCHEMA_UID not available. Is ListReader deployed?");
      return;
    }
    if (!currentAnchorUID) {
      notification.error("Open a folder first to create a list.");
      return;
    }
    const name = listName.trim();
    if (!name) {
      notification.error("Enter a name for the list.");
      return;
    }
    const nameError = validateAnchorName(name);
    if (nameError) {
      notification.error(nameError);
      return;
    }
    // The on-chain list-slot anchor name MUST be the NFC-normalized form (ADR-0025), exactly as in
    // handleSubmit — the contract can't verify normalization, so a precomposed vs decomposed Unicode
    // name would mint two distinct permanent (ADR-0002) list-slot anchors for one human name. Attest
    // (and resolve-existing against) the NFC form; display/op-title strings keep the raw `name`.
    const nfcName = name.normalize("NFC");
    // SCHEMA mode: require a full 32-byte UID BEFORE attesting the (non-revocable)
    // list-slot anchor. A loose `0x…` check let `0x1` through, which then reverted at
    // the LIST attest — but only after the anchor was already created, leaving a
    // permanent unplaced list card that can't be opened. Validate up front.
    if (listTargetType === 2 && !/^0x[0-9a-fA-F]{64}$/.test(listTargetSchema.trim())) {
      notification.error("EFS Files mode requires a 32-byte schema UID (0x + 64 hex).");
      return;
    }
    let maxE: bigint;
    try {
      maxE = BigInt(listMaxEntries.trim() || "0");
    } catch {
      notification.error("Max entries must be a non-negative integer");
      return;
    }
    if (maxE < 0n) {
      notification.error("Max entries must be a non-negative integer");
      return;
    }
    // Validate the resolver invariants BEFORE creating the non-revocable list-slot anchor,
    // so a bad config can't leave a permanent unplaced list card (the LIST attest would
    // otherwise revert only after the anchor is on-chain). maxEntries is uint256 — no practical
    // ceiling, so a planet-scale cap (e.g. a continent's population, which exceeds 2^32) is allowed.
    if (listAppendOnly && listAllowsDuplicates && maxE === 0n) {
      // ListResolver rejects the only unbounded-growth combination (ADR-0044 §3).
      notification.error("An append-only list that allows duplicates needs a Max entries cap (> 0).");
      return;
    }
    if (!publicClient) return;

    setIsSubmitting(true);
    const ops = useBackgroundOps.getState();
    const opId = ops.start(`Create list: ${name}`);
    try {
      // 1. List-slot ANCHOR (anchorType = LIST_SCHEMA_UID). Reuse if it already exists.
      // This resolveAnchor reuse is also the RECOVERY path. List creation is 3 sequential txs
      // (anchor → LIST → PIN) and the anchor is permanent (ADR-0002): if the LIST or placement
      // PIN is rejected/fails after the anchor lands, that anchor persists as a dead slot. But
      // re-running create with the SAME name in this folder reuses this anchor and finishes the
      // placement — so the dead state is fully recoverable, and openList() points the user here.
      // (Atomic single-signature creation awaits the EFSUploadGateway batch-wrapper — see
      // docs/FUTURE_WORK.md § "EFSUploadGateway batch-wrapper".)
      let listAnchorUID: `0x${string}` | undefined;
      if (indexer) {
        try {
          const existing = (await publicClient.readContract({
            address: indexer.address as `0x${string}`,
            abi: indexer.abi,
            functionName: "resolveAnchor",
            args: [currentAnchorUID as `0x${string}`, nfcName, listSchemaUID as `0x${string}`],
          })) as `0x${string}`;
          if (existing && existing !== zeroHash) {
            // Parity with file creation: the slot already exists, so submitting places a new list
            // here and supersedes any current placement (cardinality-1 PIN) — the previous list
            // stays on-chain, just hidden, exactly like replacing a file. Warn on the first click;
            // only proceed (reuse the anchor) after the user confirms with a second click.
            if (!existingAnchorWarning) {
              setExistingAnchorWarning(true);
              ops.clear(opId); // nothing written yet — don't leave a phantom running op
              return;
            }
            listAnchorUID = existing;
            setExistingAnchorWarning(false);
            ops.log(opId, "List slot already exists; reusing anchor (user confirmed).");
          }
        } catch {
          /* anchor doesn't exist yet — create below */
        }
      }
      if (!listAnchorUID) {
        const parent = anchorParent();
        const anchorData = encodeAbiParameters(
          [
            { name: "name", type: "string" },
            { name: "forSchema", type: "bytes32" },
          ],
          [nfcName, listSchemaUID as `0x${string}`],
        );
        const aTx = await attest(
          {
            functionName: "attest",
            args: [
              {
                schema: anchorSchemaUID as `0x${string}`,
                data: {
                  recipient: parent.recipient,
                  expirationTime: 0n,
                  revocable: false,
                  refUID: parent.refUID,
                  data: anchorData,
                  value: 0n,
                },
              },
            ],
          },
          { silent: true },
        );
        if (!aTx) throw new Error("No tx for list anchor");
        const aRcpt = await publicClient.waitForTransactionReceipt({ hash: aTx });
        listAnchorUID = extractUIDFromReceipt(aRcpt);
        if (!listAnchorUID) throw new Error("Could not extract list anchor UID");
      }

      // 2. The LIST itself — free-floating config (ADR-0044 5-field schema).
      ops.log(opId, "Creating list…");
      // Trim to match the validated value above — otherwise surrounding whitespace passes
      // the `.trim()` check but reaches encodeAbiParameters as an invalid bytes32 (reverting
      // only after the non-revocable anchor is already created).
      const schemaBytes = (listTargetType === 2 ? listTargetSchema.trim() : zeroHash) as `0x${string}`;
      const listData = encodeAbiParameters(
        [
          { name: "allowsDuplicates", type: "bool" },
          { name: "appendOnly", type: "bool" },
          { name: "targetType", type: "uint8" },
          { name: "targetSchema", type: "bytes32" },
          { name: "maxEntries", type: "uint256" },
        ],
        [listAllowsDuplicates, listAppendOnly, listTargetType, schemaBytes, maxE],
      );
      const lTx = await attest(
        {
          functionName: "attest",
          args: [
            {
              schema: listSchemaUID as `0x${string}`,
              data: {
                recipient: zeroAddress,
                expirationTime: 0n,
                revocable: false,
                refUID: zeroHash,
                data: listData,
                value: 0n,
              },
            },
          ],
        },
        { silent: true },
      );
      if (!lTx) throw new Error("No tx for LIST");
      const lRcpt = await publicClient.waitForTransactionReceipt({ hash: lTx });
      const listUID = extractUIDFromReceipt(lRcpt);
      if (!listUID) throw new Error("Could not extract LIST UID");

      // 3. PIN places the LIST at the anchor (definition=anchor, refUID=LIST). Revocable → deletable.
      ops.log(opId, "Placing list in folder…");
      const pinData = encodeAbiParameters([{ name: "definition", type: "bytes32" }], [listAnchorUID]);
      const pTx = await attest(
        {
          functionName: "attest",
          args: [
            {
              schema: pinSchemaUID as `0x${string}`,
              data: {
                recipient: zeroAddress,
                expirationTime: 0n,
                revocable: true,
                refUID: listUID,
                data: pinData,
                value: 0n,
              },
            },
          ],
        },
        { silent: true },
      );
      if (!pTx) throw new Error("No tx for placement PIN");
      await publicClient.waitForTransactionReceipt({ hash: pTx });

      ops.complete(opId, `List "${name}" created`);
      handleClose();
      onListCreated?.(listAnchorUID);
      notification.success(`List "${name}" created.`);
    } catch (e) {
      const msg = extractErrorMessage(e);
      ops.fail(opId, msg);
      notification.error(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = async () => {
    if (!currentAnchorUID || !newName || !walletClient || !publicClient || !internalType) return;
    if (!ensureWalletChain(walletClient, targetNetwork.id, targetNetwork.name)) return;
    const nameError = validateAnchorName(newName);
    if (nameError) {
      notification.error(nameError);
      return;
    }
    // The on-chain anchor name MUST be the NFC-normalized form (ADR-0025) — the contract can't verify
    // normalization, so precomposed/decomposed Unicode would otherwise mint two distinct permanent
    // anchors for the same human name. Attest (and resolve-existing against) the NFC form everywhere.
    const nfcName = newName.normalize("NFC");
    if (internalType === "File" && !fileToUpload) {
      notification.error("Please select a file to upload.");
      return;
    }
    if (internalType === "PasteLink" && !pasteUri) {
      notification.error("Please enter a URI.");
      return;
    }

    // Pre-flight: writing a file means deploying N chunks + ~5 attestations.
    // If the wallet has 0 funds every step will fail silently at the RPC layer;
    // surface it up front rather than midway.
    try {
      const bal = await publicClient.getBalance({ address: walletClient.account.address });
      if (bal === 0n) {
        notification.error("Wallet has 0 ETH on this network. Click the faucet icon to fund it, then retry.");
        return;
      }
    } catch {
      // non-fatal — let the real tx surface its own error
    }

    setIsSubmitting(true);
    setCanCancelSubmit(true);
    cancelledRef.current = false;

    const ops = useBackgroundOps.getState();
    const opTitle =
      internalType === "Folder"
        ? `Create folder: ${newName}`
        : internalType === "PasteLink"
          ? `Add link: ${newName}`
          : `Upload file: ${fileToUpload?.name || newName}`;
    const opId = ops.start(opTitle);

    const CANCEL_SENTINEL = "__UPLOAD_CANCELLED__";

    try {
      if (internalType === "Folder") {
        const encodedName = ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32"], [nfcName, ethers.ZeroHash]);

        let newAnchorUID: `0x${string}` | undefined;
        if (indexer) {
          try {
            const existingUID = (await publicClient.readContract({
              address: indexer.address as `0x${string}`,
              abi: indexer.abi,
              functionName: "resolveAnchor",
              args: [currentAnchorUID as `0x${string}`, nfcName, ethers.ZeroHash as `0x${string}`],
            })) as `0x${string}`;
            if (existingUID && existingUID !== ethers.ZeroHash) {
              newAnchorUID = existingUID;
              ops.log(opId, "Folder already exists; reusing anchor.");
            }
          } catch (e) {
            console.warn("Failed to check if anchor exists", e);
          }
        }

        if (!newAnchorUID) {
          const parent = anchorParent();
          const txHash = await attest(
            {
              functionName: "attest",
              args: [
                {
                  schema: anchorSchemaUID as `0x${string}`,
                  data: {
                    recipient: parent.recipient,
                    expirationTime: 0n,
                    revocable: false,
                    refUID: parent.refUID,
                    data: encodedName as `0x${string}`,
                    value: 0n,
                  },
                },
              ],
            },
            { silent: true },
          );
          if (!txHash) throw new Error("No txHash returned for ANCHOR creation.");
          const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
          newAnchorUID = extractUIDFromReceipt(receipt);
          if (!newAnchorUID) throw new Error("Could not extract new Anchor UID");

          // Visibility TAG — folder visibility is tag-only (ADR-0038 / ADR-0041).
          // A folder appears in a lens-scoped listing iff at least one lens attester
          // has an active TAG(definition=dataSchemaUID, refUID=folder). A TAG is active iff
          // it exists and is not EAS-revoked — weight is opaque metadata (ADR-0041 §4).
          // weight=1n is the conventional default; the kernel does not interpret it.
          const encodedTag = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "int256"], [dataSchemaUID, 1n]);
          try {
            const tagTx = await attest(
              {
                functionName: "attest",
                args: [
                  {
                    schema: tagSchemaUID as `0x${string}`,
                    data: {
                      recipient: ethers.ZeroAddress,
                      expirationTime: 0n,
                      revocable: true,
                      refUID: newAnchorUID,
                      data: encodedTag as `0x${string}`,
                      value: 0n,
                    },
                  },
                ],
              },
              { silent: true },
            );
            if (!tagTx) throw new Error("Visibility TAG attestation failed.");
            await publicClient.waitForTransactionReceipt({ hash: tagTx });
          } catch (e) {
            console.warn("Empty-folder visibility tag failed; folder will remain hidden until it has content.", e);
          }
        }

        notification.success("Folder created successfully.");
        handleClose();

        if (sortOverlayAddress && indexerAddress && currentAnchorUID && walletClient?.account && publicClient) {
          const pendingSortCount = enabledSortUIDs.length;
          if (pendingSortCount > 0) ops.log(opId, `Processing ${pendingSortCount} sort overlay(s)...`);
          for (const sortInfoUID of enabledSortUIDs) {
            try {
              const config = (await publicClient.readContract({
                address: sortOverlayAddress,
                abi: SORT_OVERLAY_ABI,
                functionName: "getSortConfig",
                args: [sortInfoUID as `0x${string}`],
              })) as { sortFunc: string; targetSchema: `0x${string}`; sourceType: number };

              if (config.sourceType !== 0 && config.sourceType !== 1) continue;

              const [currentIndex, staleness] = (await Promise.all([
                publicClient.readContract({
                  address: sortOverlayAddress,
                  abi: SORT_OVERLAY_ABI,
                  functionName: "getLastProcessedIndex",
                  args: [sortInfoUID as `0x${string}`, currentAnchorUID as `0x${string}`],
                }),
                publicClient.readContract({
                  address: sortOverlayAddress,
                  abi: SORT_OVERLAY_ABI,
                  functionName: "getSortStaleness",
                  args: [sortInfoUID as `0x${string}`, currentAnchorUID as `0x${string}`],
                }),
              ])) as [bigint, bigint];
              const totalCount = currentIndex + staleness;
              if (totalCount <= currentIndex) continue;

              const items: `0x${string}`[] = [];
              for (let i = currentIndex; i < totalCount; i++) {
                const uid =
                  config.sourceType === 0
                    ? ((await publicClient.readContract({
                        address: indexerAddress,
                        abi: INDEXER_CHILDREN_ABI,
                        functionName: "getChildAt",
                        args: [currentAnchorUID as `0x${string}`, i],
                      })) as `0x${string}`)
                    : ((await publicClient.readContract({
                        address: indexerAddress,
                        abi: INDEXER_CHILDREN_ABI,
                        functionName: "getChildBySchemaAt",
                        args: [currentAnchorUID as `0x${string}`, config.targetSchema, i],
                      })) as `0x${string}`);
                items.push(uid);
              }

              const [leftHints, rightHints] = (await publicClient.readContract({
                address: sortOverlayAddress,
                abi: SORT_OVERLAY_ABI,
                functionName: "computeHints",
                args: [sortInfoUID as `0x${string}`, currentAnchorUID as `0x${string}`, items],
              })) as [`0x${string}`[], `0x${string}`[]];

              const { request } = await publicClient.simulateContract({
                address: sortOverlayAddress,
                abi: SORT_OVERLAY_ABI,
                functionName: "processItems",
                args: [
                  sortInfoUID as `0x${string}`,
                  currentAnchorUID as `0x${string}`,
                  currentIndex,
                  items,
                  leftHints,
                  rightHints,
                ],
                account: walletClient.account,
              });
              const txHash = await walletClient.writeContract(request);
              await publicClient.waitForTransactionReceipt({ hash: txHash });
            } catch (e) {
              console.error("Auto-process sort after folder creation failed:", e);
            }
          }
        }

        if (newAnchorUID) onFolderCreated?.(newAnchorUID, nfcName);
        ops.complete(opId, "Folder ready.");
        return;
      }

      // --- FILE UPLOAD or PASTE LINK ---
      const fileAnchorSchemaUID = dataSchemaUID as `0x${string}`;

      let knownFileAnchorUID: `0x${string}` | null | undefined;
      if (indexer) {
        try {
          const existingUID = (await publicClient.readContract({
            address: indexer.address as `0x${string}`,
            abi: indexer.abi,
            functionName: "resolveAnchor",
            args: [currentAnchorUID as `0x${string}`, nfcName, fileAnchorSchemaUID],
          })) as `0x${string}`;
          if (existingUID && existingUID !== ethers.ZeroHash) {
            if (!existingAnchorWarning) {
              setExistingAnchorWarning(true);
              setIsSubmitting(false);
              // Nothing has been written yet — drop the op instead of leaving
              // it running forever while the user confirms.
              ops.clear(opId);
              return;
            }
            knownFileAnchorUID = existingUID;
            setExistingAnchorWarning(false);
          } else {
            knownFileAnchorUID = null;
          }
        } catch (e) {
          console.warn("Failed to check if anchor exists", e);
        }
      }

      // ── FILE upload → the shared SDK seam (`uploadOnchainFile`): layered
      //    `multiAttest` (one popup per DAG layer instead of ~11) + pipelined
      //    SSTORE2 chunk deploys + inline `data:` URI for small files. Replaces the
      //    long inline per-attestation sequence that used to live here; PasteLink
      //    below uses the same seam for external URI records (no storage deploys).
      if (internalType === "File") {
        const dataBytes = new Uint8Array(await fileToUpload!.arrayBuffer());
        const fileContentType = fileToUpload!.type || "application/octet-stream";
        if (dataBytes.length === 0) {
          const msg = "Cannot upload an empty file.";
          notification.error(msg);
          ops.fail(opId, msg);
          return;
        }
        if (!easAddress || !indexer) {
          const msg = "EAS / Indexer address unavailable. Is it deployed?";
          notification.error(msg);
          ops.fail(opId, msg);
          return;
        }
        const edgeResolverAddress = await getEdgeResolverAddress(targetNetwork.id);
        if (!edgeResolverAddress) {
          const msg = "EdgeResolver address not available. Is it deployed?";
          notification.error(msg);
          ops.fail(opId, msg);
          return;
        }
        await uploadOnchainFile({
          name: nfcName,
          bytes: dataBytes,
          contentType: fileContentType,
          parentAnchorUID: currentAnchorUID as `0x${string}`,
          walletClient,
          publicClient,
          chainId: targetNetwork.id,
          easAddress,
          indexerAddress: indexer.address as `0x${string}`,
          indexerAbi: indexer.abi,
          anchorSchemaUID: anchorSchemaUID as `0x${string}`,
          dataSchemaUID: dataSchemaUID as `0x${string}`,
          propertySchemaUID: propertySchemaUID as `0x${string}`,
          pinSchemaUID: pinSchemaUID as `0x${string}`,
          tagSchemaUID: tagSchemaUID as `0x${string}`,
          mirrorSchemaUID: mirrorSchemaUID as `0x${string}`,
          edgeResolverAddress,
          edgeResolverAbi: EDGE_RESOLVER_ABI,
          // Address-root carve-out: a file placed directly under an Address container
          // root needs refUID=0 + recipient=addr for its ANCHOR (the synthetic
          // bytes32(addr) parent isn't a real attestation). Matches the inline path.
          fileAnchorRefUID: anchorParent().refUID,
          fileAnchorRecipient: anchorParent().recipient,
          knownFileAnchorUID,
          isCancelled: () => cancelledRef.current,
          onCanCancelChange: setCanCancelSubmit,
          onProgress: m => ops.log(opId, m),
        });
        notification.success("File uploaded and placed successfully.");
        ops.complete(opId, "File uploaded and placed.");
        onFileCreated?.(enabledSortUIDs);
        handleClose();
        return;
      }

      // ── PasteLink (external URI; File returned above). ──
      const mirrorUri = pasteUri;
      const detected = detectTransport(pasteUri);
      // Reject `data:` here: inline data is a property of the UPLOAD path (which
      // mints a data: mirror only when /transports/data is seeded, else falls back to
      // SSTORE2). Pasting a data: URI as an external "link" is nonsensical and, on a
      // deploy without /transports/data, would burn DATA/PROPERTY writes then abort on
      // the missing transport anchor. Reject before any attestation is sent.
      if (detected === "unknown" || detected === "data") {
        const msg =
          detected === "data"
            ? `Inline data: URIs aren't a paste-link target — upload the file instead.`
            : `Unsupported URI scheme. Supported: web3://, ipfs://, ar://, https://, magnet:`;
        notification.error(msg);
        ops.fail(opId, msg);
        return;
      }
      const transportName = detected;
      const contentType = pasteContentType || "application/octet-stream";
      const contentHash: `0x${string}` = pasteContentHash || (ethers.ZeroHash as `0x${string}`);
      const fileSize: bigint = pasteSize ? BigInt(pasteSize) : 0n;

      if (!easAddress || !indexer) {
        const msg = "EAS / Indexer address unavailable. Is it deployed?";
        notification.error(msg);
        ops.fail(opId, msg);
        return;
      }
      const edgeResolverAddress = await getEdgeResolverAddress(targetNetwork.id);
      if (!edgeResolverAddress) {
        const msg = "EdgeResolver address not available. Is it deployed?";
        notification.error(msg);
        ops.fail(opId, msg);
        return;
      }

      await createExternalFileReference({
        name: nfcName,
        mirrorUri,
        transportName,
        contentType,
        contentHash,
        fileSize,
        parentAnchorUID: currentAnchorUID as `0x${string}`,
        walletClient,
        publicClient,
        chainId: targetNetwork.id,
        easAddress,
        indexerAddress: indexer.address as `0x${string}`,
        indexerAbi: indexer.abi,
        anchorSchemaUID: anchorSchemaUID as `0x${string}`,
        dataSchemaUID: dataSchemaUID as `0x${string}`,
        propertySchemaUID: propertySchemaUID as `0x${string}`,
        pinSchemaUID: pinSchemaUID as `0x${string}`,
        tagSchemaUID: tagSchemaUID as `0x${string}`,
        mirrorSchemaUID: mirrorSchemaUID as `0x${string}`,
        edgeResolverAddress,
        edgeResolverAbi: EDGE_RESOLVER_ABI,
        fileAnchorRefUID: anchorParent().refUID,
        fileAnchorRecipient: anchorParent().recipient,
        knownFileAnchorUID,
        isCancelled: () => cancelledRef.current,
        onCanCancelChange: setCanCancelSubmit,
        onProgress: m => ops.log(opId, m),
      });

      notification.success("File uploaded and placed successfully.");
      ops.complete(opId, "File uploaded and placed.");
      onFileCreated?.(enabledSortUIDs);
      handleClose();
    } catch (e) {
      if (e instanceof Error && e.message === CANCEL_SENTINEL) {
        ops.fail(opId, "Cancelled by user. Any transactions already broadcast will still settle on-chain.");
      } else {
        console.error(e);
        const msg = extractErrorMessage(e);
        notification.error(msg);
        ops.fail(opId, msg);
      }
    } finally {
      setIsSubmitting(false);
      setCanCancelSubmit(true);
      cancelledRef.current = false;
    }
  };

  return (
    <dialog
      id="create_modal"
      className="modal"
      ref={modalRef}
      onCancel={e => {
        e.preventDefault();
        requestClose();
      }}
    >
      <div className="modal-box">
        <h3 className="font-bold text-lg">
          {internalType === "Folder" ? "Create New Folder" : internalType === "List" ? "Create List" : "Add File"}
        </h3>
        {internalType !== "Folder" && internalType !== "List" && internalType !== null && (
          <div className="tabs tabs-bordered mt-2">
            <button
              className={`tab ${internalType === "File" ? "tab-active" : ""}`}
              onClick={() => setInternalType("File")}
            >
              Upload File
            </button>
            <button
              className={`tab ${internalType === "PasteLink" ? "tab-active" : ""}`}
              onClick={() => setInternalType("PasteLink")}
            >
              Paste Link
            </button>
          </div>
        )}
        {/* List creation form — shown instead of the name/file inputs */}
        {internalType === "List" && (
          <div className="py-3 flex flex-col gap-3">
            <p className="text-xs text-base-content/50">
              Creates a permanent list (non-revocable). You add entries after creation.
            </p>
            <div className="form-control w-full">
              <label className="label pb-1">
                <span className="label-text font-medium">Name</span>
              </label>
              <input
                type="text"
                className="input input-bordered w-full"
                placeholder="e.g. allowlist, team members, curated files…"
                value={listName}
                onChange={e => {
                  setListName(e.target.value);
                  setExistingAnchorWarning(false); // re-confirm against the new name (parity with files)
                }}
                autoFocus
              />
            </div>
            <div className="form-control w-full">
              <label className="label pb-1">
                <span className="label-text font-medium">What are you collecting?</span>
              </label>
              <div className="flex gap-2 flex-wrap">
                {(
                  [
                    [0, "Anything"],
                    [1, "Addresses"],
                    [2, "EFS Files"],
                  ] as const
                ).map(([val, label]) => (
                  <button
                    key={val}
                    type="button"
                    className={`btn btn-sm flex-1 ${listTargetType === val ? "btn-primary" : "btn-ghost border border-base-300"}`}
                    onClick={() => setListTargetType(val)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-base-content/40 mt-1.5">
                {listTargetType === 0 &&
                  "Any bytes32 key — use for arbitrary identifiers, named keys, or anything else."}
                {listTargetType === 1 && "Ethereum addresses — use for allowlists, social graphs, or member sets."}
                {listTargetType === 2 &&
                  "EFS file UIDs — use for curated file collections; entries must match the target schema."}
              </p>
            </div>
            {listTargetType === 2 && (
              <div className="form-control w-full">
                <label className="label pb-1">
                  <span className="label-text">Target Schema UID</span>
                </label>
                <input
                  type="text"
                  className="input input-bordered input-sm font-mono"
                  placeholder="0x…"
                  value={listTargetSchema}
                  onChange={e => setListTargetSchema(e.target.value)}
                />
              </div>
            )}
            <div>
              <button
                type="button"
                className="text-sm text-base-content/50 hover:text-base-content flex items-center gap-1 transition-colors"
                onClick={() => setShowListRules(v => !v)}
              >
                {showListRules ? "▾" : "▸"} Rules
              </button>
              {showListRules && (
                <div className="mt-2 pl-3 border-l-2 border-base-300 flex flex-col gap-2">
                  <label className="flex items-center gap-2 cursor-pointer text-sm">
                    <input
                      type="checkbox"
                      className="checkbox checkbox-sm"
                      checked={listAllowsDuplicates}
                      onChange={e => setListAllowsDuplicates(e.target.checked)}
                    />
                    Allow duplicates
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer text-sm">
                    <input
                      type="checkbox"
                      className="checkbox checkbox-sm"
                      checked={listAppendOnly}
                      onChange={e => setListAppendOnly(e.target.checked)}
                    />
                    Append-only <span className="text-xs text-base-content/40">(entries permanent once added)</span>
                  </label>
                  <div className="flex items-center gap-2 text-sm">
                    <span>Max entries</span>
                    <input
                      type="number"
                      className="input input-bordered input-xs w-24"
                      value={listMaxEntries}
                      min={0}
                      onChange={e => setListMaxEntries(e.target.value)}
                    />
                    <span className="text-xs text-base-content/40">0 = unlimited</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        <div className={`py-4 form-control w-full ${internalType === "List" ? "hidden" : ""}`}>
          <label className="label">
            <span className="label-text">Name</span>
          </label>
          <input
            type="text"
            placeholder={`Enter ${internalType === "Folder" ? "folder" : "file"} name`}
            className={`input input-bordered w-full ${nameValidationError ? "input-error" : ""}`}
            value={newName}
            onChange={e => {
              setNewName(e.target.value);
              setExistingAnchorWarning(false);
            }}
            onKeyDown={e => {
              if (
                e.key === "Enter" &&
                newName &&
                !nameValidationError &&
                (internalType !== "File" || fileToUpload) &&
                (internalType !== "PasteLink" || pasteUri)
              )
                handleSubmit();
              if (e.key === "Escape") requestClose();
            }}
            autoComplete="off"
            autoFocus
          />
          {nameValidationError && (
            <label className="label">
              <span className="label-text-alt text-error">{nameValidationError}</span>
            </label>
          )}
        </div>
        {internalType === "File" && (
          <div className="py-2 form-control w-full">
            <label className="label">
              <span className="label-text">Select File</span>
            </label>
            <input
              type="file"
              className="file-input file-input-bordered w-full"
              onChange={e => {
                if (e.target.files && e.target.files.length > 0) {
                  const file = e.target.files[0];
                  setFileToUpload(file);
                  if (!newName) setNewName(file.name);
                } else {
                  setFileToUpload(null);
                }
              }}
            />
          </div>
        )}
        {internalType === "PasteLink" && (
          <>
            <div className="py-2 form-control w-full">
              <label className="label">
                <span className="label-text">URI</span>
              </label>
              <input
                type="text"
                placeholder="ipfs://Qm..., ar://..., bafyb..."
                className="input input-bordered w-full"
                value={pasteUri}
                onChange={e => {
                  let val = e.target.value.trim();
                  if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44,}|bafy[a-z2-7]{50,})$/.test(val)) {
                    val = `ipfs://${val}`;
                  }
                  if (val !== pasteUri) {
                    // Fetched/entered content metadata describes the PREVIOUS URI — editing the URI must
                    // invalidate it. Otherwise a "Fetch Info" for URI A followed by editing to URI B would
                    // bind A's contentHash/size/type as permanent reserved-key PROPERTY claims on B's DATA
                    // (PR #24 P2). Re-fetch (or re-enter) after changing the URI.
                    setPasteContentHash(null);
                    setPasteSize("");
                    setPasteContentType("");
                  }
                  setPasteUri(val);
                }}
              />
              {pasteUri && (
                <label className="label">
                  <span className="label-text-alt text-base-content/50">
                    Detected: {TRANSPORT_LABELS[detectTransport(pasteUri)]}
                  </span>
                </label>
              )}
            </div>
            <div className="mt-1">
              <button
                type="button"
                className="flex items-center justify-between w-full text-sm text-base-content/60 hover:text-base-content transition-colors"
                onClick={() => setShowPasteDetails(v => !v)}
              >
                <span className="flex items-center gap-1">
                  <span>{showPasteDetails ? "▾" : "▸"}</span>
                  <span>File Details</span>
                  {(pasteContentType || pasteSize || pasteContentHash) && (
                    <span className="badge badge-xs badge-success ml-1">
                      {[pasteContentType && "type", pasteSize && "size", pasteContentHash && "hash"]
                        .filter(Boolean)
                        .join(", ")}
                    </span>
                  )}
                </span>
                {pasteUri && detectTransport(pasteUri) !== "magnet" && detectTransport(pasteUri) !== "onchain" && (
                  <button
                    type="button"
                    className="btn btn-xs btn-outline"
                    onClick={e => {
                      e.stopPropagation();
                      handleFetchInfo();
                    }}
                    disabled={isFetchingInfo}
                  >
                    {isFetchingInfo ? "Fetching..." : "Fetch Info"}
                  </button>
                )}
              </button>
              {showPasteDetails && (
                <div className="mt-2 pl-4 border-l-2 border-base-300 flex flex-col gap-2">
                  <div className="form-control w-full">
                    <label className="label py-1">
                      <span className="label-text text-sm">Content Type</span>
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. image/png, text/html"
                      className="input input-bordered input-sm w-full"
                      value={pasteContentType}
                      onChange={e => setPasteContentType(e.target.value)}
                    />
                  </div>
                  <div className="form-control w-full">
                    <label className="label py-1">
                      <span className="label-text text-sm">Size (bytes)</span>
                    </label>
                    <input
                      type="text"
                      placeholder="Unknown"
                      className="input input-bordered input-sm w-full"
                      value={pasteSize}
                      onChange={e => setPasteSize(e.target.value.replace(/\D/g, ""))}
                    />
                  </div>
                  <div className="form-control w-full">
                    <label className="label py-1">
                      <span className="label-text text-sm">Content Hash</span>
                    </label>
                    <input
                      type="text"
                      placeholder="0x... (auto-computed via Fetch Info)"
                      className="input input-bordered input-sm w-full font-mono text-xs"
                      value={pasteContentHash || ""}
                      onChange={e => {
                        const val = e.target.value;
                        if (!val) {
                          setPasteContentHash(null);
                          return;
                        }
                        setPasteContentHash(val as `0x${string}`);
                      }}
                    />
                    {pasteContentHash && (
                      <label className="label py-0">
                        <span className="label-text-alt text-success text-xs">Verified from file bytes</span>
                      </label>
                    )}
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {existingAnchorWarning && internalType !== "Folder" && (
          <div className="alert alert-warning mt-2 text-sm py-2">
            {internalType === "List" ? (
              <>
                A list named &quot;{listName}&quot; already exists at this slot. Submitting places a new list here — any
                current placement is superseded, and the previous list stays on-chain (hidden, re-placeable), just like
                replacing a file.
              </>
            ) : (
              <>
                A file named &quot;{newName}&quot; already exists here. Submitting will add a new version to the
                existing anchor.
              </>
            )}
          </div>
        )}

        <div className="modal-action items-center">
          {internalType !== "Folder" && internalType !== "List" && availableSorts.length > 0 ? (
            <div className="flex-1">
              <button
                type="button"
                className="flex items-center gap-1.5 text-xs text-base-content/50 hover:text-base-content transition-colors"
                onClick={() => setShowSortConfig(v => !v)}
              >
                <Cog6ToothIcon className="w-3.5 h-3.5" />
                Auto-update {enabledSortUIDs.length}/{availableSorts.length} sort
                {availableSorts.length !== 1 ? "s" : ""}
                <span className="text-base-content/30">{showSortConfig ? "▴" : "▾"}</span>
              </button>
              {showSortConfig && (
                <div className="mt-2 flex flex-col gap-1.5">
                  {availableSorts.map(sort => (
                    <label
                      key={sort.sortInfoUID}
                      className="flex items-center gap-2 text-sm cursor-pointer select-none"
                    >
                      <input
                        type="checkbox"
                        className="checkbox checkbox-xs"
                        checked={!disabledAutoSorts.has(sort.sortInfoUID)}
                        onChange={e => {
                          setDisabledAutoSorts(prev => {
                            const next = new Set(prev);
                            if (e.target.checked) next.delete(sort.sortInfoUID);
                            else next.add(sort.sortInfoUID);
                            return next;
                          });
                        }}
                      />
                      <span className="text-base-content/70">{sort.name}</span>
                      {!sort.isLocal && <span className="text-xs text-base-content/30">global</span>}
                    </label>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="flex-1" />
          )}
          {isSubmitting ? (
            <button
              type="button"
              className={`btn ${canCancelSubmit ? "btn-error" : "btn-warning"}`}
              disabled={!canCancelSubmit}
              onClick={() => {
                if (canCancelSubmit) cancelledRef.current = true;
              }}
              title={
                canCancelSubmit
                  ? "Stops at the next safe boundary. If final placement has begun, approve remaining prompts to finish safely."
                  : "Final placement is in progress. Use the wallet prompt if you need to reject the current transaction."
              }
            >
              <StopIcon className="w-4 h-4" />
              {canCancelSubmit ? "Stop" : "Finishing placement"}
            </button>
          ) : (
            <button className="btn btn-ghost" onClick={handleClose}>
              Close
            </button>
          )}
          <button
            className={`btn ${existingAnchorWarning && internalType !== "Folder" ? "btn-warning" : "btn-primary"}`}
            onClick={internalType === "List" ? handleCreateList : handleSubmit}
            disabled={
              isSubmitting ||
              (internalType !== "List" && (!newName || !!nameValidationError)) ||
              (internalType === "File" && !fileToUpload) ||
              (internalType === "PasteLink" && !pasteUri) ||
              (internalType === "List" && (!listSchemaUID || !listName.trim())) ||
              (internalType === "List" && listTargetType === 2 && !listTargetSchema.startsWith("0x"))
            }
          >
            {isSubmitting && <span className="loading loading-spinner loading-xs" />}
            {isSubmitting
              ? canCancelSubmit
                ? "Creating..."
                : "Finishing..."
              : existingAnchorWarning && internalType !== "Folder" && internalType !== "List"
                ? "Update Existing"
                : internalType === "List"
                  ? "Create List"
                  : "Create"}
          </button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button
          onClick={e => {
            e.preventDefault();
            requestClose();
          }}
        >
          close
        </button>
      </form>
    </dialog>
  );
};
