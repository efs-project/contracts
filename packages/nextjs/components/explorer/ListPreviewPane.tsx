"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  decodeAbiParameters,
  decodeEventLog,
  encodeAbiParameters,
  getAddress,
  parseAbiItem,
  zeroAddress,
  zeroHash,
} from "viem";
import { usePublicClient, useReadContract, useWriteContract } from "wagmi";
import {
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  PencilSquareIcon,
  PlusIcon,
  QueueListIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { Address, AddressInput } from "~~/components/scaffold-eth";
import { useDeployedContractInfo, useTargetNetwork } from "~~/hooks/scaffold-eth";
import { useBackgroundOps } from "~~/services/store/backgroundOps";
import { EDGE_RESOLVER_ABI } from "~~/utils/efs/edgeResolver";
import {
  RANK_STEP,
  addrFromKey,
  computeInsertWeight,
  memberKeyForText,
  shortHex,
  unpackText,
} from "~~/utils/efs/listEncoding";
import { notification } from "~~/utils/scaffold-eth";

// ── ABIs ────────────────────────────────────────────────────────────────────

const LIST_READER_ABI = [
  {
    inputs: [{ name: "listUID", type: "bytes32" }],
    name: "getMode",
    outputs: [
      {
        name: "m",
        type: "tuple",
        components: [
          { name: "exists", type: "bool" },
          { name: "curator", type: "address" },
          { name: "allowsDuplicates", type: "bool" },
          { name: "appendOnly", type: "bool" },
          { name: "targetType", type: "uint8" },
          { name: "targetSchema", type: "bytes32" },
          { name: "maxEntries", type: "uint256" },
        ],
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "listUID", type: "bytes32" },
      { name: "attester", type: "address" },
      { name: "start", type: "uint256" },
      { name: "len", type: "uint256" },
    ],
    name: "entries",
    outputs: [
      {
        name: "",
        type: "tuple[]",
        components: [
          { name: "entryUID", type: "bytes32" },
          { name: "targetType", type: "uint8" },
          { name: "identityKey", type: "bytes32" },
        ],
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "LIST_ENTRY_SCHEMA_UID",
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const EAS_ABI = [
  {
    inputs: [
      {
        components: [
          { name: "schema", type: "bytes32" },
          {
            components: [
              { name: "recipient", type: "address" },
              { name: "expirationTime", type: "uint64" },
              { name: "revocable", type: "bool" },
              { name: "refUID", type: "bytes32" },
              { name: "data", type: "bytes" },
              { name: "value", type: "uint256" },
            ],
            name: "data",
            type: "tuple",
          },
        ],
        name: "attest",
        type: "tuple",
      },
    ],
    name: "attest",
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      {
        components: [
          { name: "schema", type: "bytes32" },
          {
            components: [
              { name: "uid", type: "bytes32" },
              { name: "value", type: "uint256" },
            ],
            name: "data",
            type: "tuple",
          },
        ],
        name: "revocationRequest",
        type: "tuple",
      },
    ],
    name: "revoke",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [{ name: "uid", type: "bytes32" }],
    name: "getAttestation",
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "uid", type: "bytes32" },
          { name: "schema", type: "bytes32" },
          { name: "time", type: "uint64" },
          { name: "expirationTime", type: "uint64" },
          { name: "revocationTime", type: "uint64" },
          { name: "refUID", type: "bytes32" },
          { name: "recipient", type: "address" },
          { name: "attester", type: "address" },
          { name: "revocable", type: "bool" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

const LIST_ENTRY_RESOLVER_ABI = [
  {
    inputs: [
      { name: "listUID", type: "bytes32" },
      { name: "start", type: "uint256" },
      { name: "len", type: "uint256" },
    ],
    name: "getListAttesters",
    outputs: [{ name: "", type: "address[]" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// EFSIndexer fragments used for entry-scoped PROPERTY placement & reads (ADR-0046).
// Order ("weight") and label ("name") live as PIN-bound PROPERTYs on the stable
// entry UID, so we need the same schema UIDs and `resolveAnchor` the contentType
// flow in CreateItemModal uses.
const INDEXER_PROPERTY_ABI = [
  {
    inputs: [],
    name: "PROPERTY_SCHEMA_UID",
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "ANCHOR_SCHEMA_UID",
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "PIN_SCHEMA_UID",
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "parentUID", type: "bytes32" },
      { name: "name", type: "string" },
      { name: "schema", type: "bytes32" },
    ],
    name: "resolveAnchor",
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// Entry-scoped property key names (ADR-0046 §2–3). Order is "weight" (continuity
// with ADR-0044 vocabulary, §"Open sub-decisions" default); label is the reserved
// "name" key (ADR-0034).
const ORDER_KEY = "weight";
const NAME_KEY = "name";
// Editable list description (ADR-0046 pattern): a PIN-bound PROPERTY on the stable
// list UID, lens-scoped. Falls back to MODE_META[targetType].blurb when unset.
const DESC_KEY = "description";

// ── Constants ───────────────────────────────────────────────────────────────

const MODE = { ANY: 0, ADDR: 1, SCHEMA: 2 } as const;

const MODE_META: Record<number, { noun: string; singular: string; verb: string; placeholder: string; blurb: string }> =
  {
    0: {
      noun: "items",
      singular: "item",
      verb: "Add item",
      placeholder: "Add an item…",
      blurb: "A free-text list — groceries, todos, anything.",
    },
    1: {
      noun: "addresses",
      singular: "address",
      verb: "Add address",
      placeholder: "0x… or name.eth",
      blurb: "A ranked roster of Ethereum addresses.",
    },
    2: {
      noun: "attestations",
      singular: "attestation",
      verb: "Add attestation",
      placeholder: "Attestation UID (0x…)",
      blurb: "A curated set of attestations of one schema.",
    },
  };

// Encoding/ordering helpers live in ~~/utils/efs/listEncoding (unit-tested in
// listEncoding.test.ts). Only this component-local coercion stays here.
const toBig = (w: unknown) => (typeof w === "bigint" ? w : BigInt(String(w)));

// ── Types ─────────────────────────────────────────────────────────────────────

interface Entry {
  entryUID: `0x${string}`;
  targetType: number;
  identityKey: `0x${string}`;
  /**
   * Display order, read from the entry-scoped "weight" PROPERTY (ADR-0046),
   * lens-scoped to the viewing attester. `null` when the entry has no order
   * property yet (legacy / mid-write) — those sort last by entryUID tiebreak.
   */
  order: bigint | null;
  /**
   * Free-text label, read from the entry-scoped "name" PROPERTY (ADR-0046),
   * lens-scoped. `null` when no label override is set; rendering then falls
   * back to the entity's own display (address / attestation / legacy text).
   */
  label: string | null;
}

/** The raw membership tuple `ListReader.entries` returns (post-ADR-0046, no weight). */
interface RawEntry {
  entryUID: `0x${string}`;
  targetType: number;
  identityKey: `0x${string}`;
}
interface Props {
  uid: string;
  name: string;
  attester: string;
  onClose: () => void;
  connectedAddress?: `0x${string}`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

const DragDots = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
    <circle cx="5" cy="4" r="1.4" />
    <circle cx="11" cy="4" r="1.4" />
    <circle cx="5" cy="8" r="1.4" />
    <circle cx="11" cy="8" r="1.4" />
    <circle cx="5" cy="12" r="1.4" />
    <circle cx="11" cy="12" r="1.4" />
  </svg>
);

/** A SCHEMA-mode row: fetch the target attestation and summarize it. */
const AttestationLabel = ({ uid, easAddress }: { uid: `0x${string}`; easAddress?: `0x${string}` }) => {
  const { targetNetwork } = useTargetNetwork();
  const { data: att } = useReadContract({
    chainId: targetNetwork.id,
    address: easAddress,
    abi: EAS_ABI,
    functionName: "getAttestation",
    args: [uid],
    query: { enabled: !!easAddress },
  });
  const revoked = att && toBig(att.revocationTime) > 0n;
  // References should display by the referenced entity's name. Anchors (files/folders)
  // encode `(string name, bytes32 schemaUID)` — decode it for a human label; non-anchor
  // targets (DATA, PROPERTY, …) fail the decode and fall back to the short UID.
  let anchorName: string | null = null;
  if (att?.data && att.data !== "0x") {
    try {
      const [nm] = decodeAbiParameters([{ type: "string" }, { type: "bytes32" }], att.data);
      if (typeof nm === "string" && nm.length > 0 && nm.length < 200 && /^[\x20-\x7e]*$/.test(nm)) anchorName = nm;
    } catch {
      /* not an anchor — keep the UID */
    }
  }
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      {anchorName ? (
        <span className="text-sm truncate">{anchorName}</span>
      ) : (
        <span className="font-mono text-xs truncate">{shortHex(uid)}</span>
      )}
      {att && att.attester !== zeroAddress ? (
        <span className="flex items-center gap-1 text-[10px] text-base-content/45">
          <span className="badge badge-ghost badge-xs font-mono">{shortHex(att.schema)}</span>
          {anchorName && <span className="font-mono opacity-50">{shortHex(uid)}</span>}
          {revoked && <span className="text-error">revoked</span>}
        </span>
      ) : (
        <span className="text-[10px] text-base-content/30">not found on this chain</span>
      )}
    </div>
  );
};

// ── Main ──────────────────────────────────────────────────────────────────────

export const ListPreviewPane = ({ uid, name, attester: listAttester, onClose, connectedAddress }: Props) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: listReaderInfo } = useDeployedContractInfo({ contractName: "ListReader" as any });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listReaderAddress = (listReaderInfo as any)?.address as `0x${string}` | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: easInfo } = useDeployedContractInfo({ contractName: "EAS" as any });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const easAddress = (easInfo as any)?.address as `0x${string}` | undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: listEntryResolverInfo } = useDeployedContractInfo({ contractName: "ListEntryResolver" as any });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listEntryResolverAddress = (listEntryResolverInfo as any)?.address as `0x${string}` | undefined;

  // Entry-scoped order/label PROPERTYs (ADR-0046) are placed & read through the
  // EFSIndexer (key-anchor resolution, schema UIDs) and EdgeResolver (active PIN
  // target lookup) — the same sources CreateItemModal's contentType flow uses.
  const { data: indexerInfo } = useDeployedContractInfo({ contractName: "Indexer" });
  const indexerAddress = indexerInfo?.address as `0x${string}` | undefined;
  const { data: edgeResolverInfo } = useDeployedContractInfo({ contractName: "EdgeResolver" });
  const edgeResolverAddress = edgeResolverInfo?.address as `0x${string}` | undefined;

  const { targetNetwork } = useTargetNetwork();

  const { data: propertySchemaUID } = useReadContract({
    chainId: targetNetwork.id,
    address: indexerAddress,
    abi: INDEXER_PROPERTY_ABI,
    functionName: "PROPERTY_SCHEMA_UID",
    query: { enabled: !!indexerAddress },
  });
  const { data: anchorSchemaUID } = useReadContract({
    chainId: targetNetwork.id,
    address: indexerAddress,
    abi: INDEXER_PROPERTY_ABI,
    functionName: "ANCHOR_SCHEMA_UID",
    query: { enabled: !!indexerAddress },
  });
  const { data: pinSchemaUID } = useReadContract({
    chainId: targetNetwork.id,
    address: indexerAddress,
    abi: INDEXER_PROPERTY_ABI,
    functionName: "PIN_SCHEMA_UID",
    query: { enabled: !!indexerAddress },
  });

  const publicClient = usePublicClient({ chainId: targetNetwork.id });
  const ops = useBackgroundOps();
  const { writeContractAsync } = useWriteContract();

  const listUID = uid as `0x${string}`;

  const { data: mode } = useReadContract({
    chainId: targetNetwork.id,
    address: listReaderAddress,
    abi: LIST_READER_ABI,
    functionName: "getMode",
    args: [listUID],
    query: { enabled: !!listReaderAddress },
  });

  // ── Editions / lenses ───────────────────────────────────────────────────────
  // A list is per-attester: each contributor ("lens"/"edition") has their own entries.
  // Viewing defaults to the curator's edition (so you see the list they made); you edit
  // only your own. Contributors are discovered from the on-chain attester index (see below).
  const curator = (mode?.exists ? mode.curator : (listAttester as `0x${string}`)) as `0x${string}`;
  // Default the VIEWING lens to the attester that surfaced/opened this card — `listAttester`
  // is the lens whose placement `openList` resolved through the ?lenses= waterfall. Without
  // this, a card opened from ?lenses=bob would default to `mode.curator` (Alice) and show her
  // often-empty edition instead of Bob's, which is what made the card visible. Falls back to
  // the curator when no specific lens opened it.
  const defaultLens = ((listAttester as `0x${string}`) || curator) as `0x${string}`;
  const [lens, setLens] = useState<`0x${string}` | undefined>(undefined);
  const effectiveLens = (lens ?? defaultLens ?? connectedAddress ?? zeroAddress) as `0x${string}`;
  useEffect(() => {
    setLens(undefined); // reset to the default lens when the list changes
  }, [uid]);

  // Contributors come from the on-chain attester index (consensus state, not event logs —
  // so smart contracts read it the same way). Append-only; we keep all of them as edition chips.
  // First 100 contributors is ample for the edition picker; paginate further if ever needed.
  const { data: rawAttesters } = useReadContract({
    chainId: targetNetwork.id,
    address: listEntryResolverAddress,
    abi: LIST_ENTRY_RESOLVER_ABI,
    functionName: "getListAttesters",
    args: [listUID, 0n, 100n],
    query: { enabled: !!listEntryResolverAddress },
  });
  const contributors = useMemo(
    () => ((rawAttesters as readonly `0x${string}`[] | undefined) ?? []).map(a => a.toLowerCase() as `0x${string}`),
    [rawAttesters],
  );

  // The lens chips: curator first, then you, then any other contributors — deduped.
  const lensChips = useMemo(() => {
    const out: `0x${string}`[] = [];
    const seen = new Set<string>();
    const push = (a?: `0x${string}`) => {
      if (!a || a === zeroAddress) return;
      const k = a.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      out.push(a);
    };
    push(defaultLens); // the lens that opened this card — the default edition
    push(curator);
    push(connectedAddress);
    contributors.forEach(c => push(c));
    return out;
  }, [defaultLens, curator, connectedAddress, contributors]);

  // Read ALL entries for this lens, paginated. A list can be uncapped (maxEntries == 0) or
  // capped above one page, so a single 100-entry read would hide later entries and make
  // nextOrder() derive duplicate ranks off a truncated tail. Loop the reader cursor until a
  // short page, with a safety cap for the debug UI.
  const [rawEntries, setRawEntries] = useState<RawEntry[] | undefined>(undefined);
  // Generation guard: each refetch invocation claims the next generation; only the latest may
  // commit. Clearing rawEntries on lens change cancels the stale ENRICH, but not an already
  // in-flight refetchEntries() for the OLD lens — if a Bob→Alice switch lands while Bob's
  // `entries(listUID, Bob, …)` read is pending, that read would otherwise resolve afterward and
  // setRawEntries(Bob's UIDs) under the Alice lens, re-opening the cross-lens write hazard. The
  // gen check below discards any fetch that a newer one has superseded.
  const fetchGenRef = useRef(0);
  const refetchEntries = useCallback(async () => {
    if (!publicClient || !listReaderAddress) return;
    const myGen = ++fetchGenRef.current;
    const PAGE = 200n;
    const SAFETY = 10000; // far beyond any hand-curated list; bounds a runaway read
    const all: RawEntry[] = [];
    try {
      for (let start = 0n; ; start += PAGE) {
        const page = (await publicClient.readContract({
          address: listReaderAddress,
          abi: LIST_READER_ABI,
          functionName: "entries",
          args: [listUID, effectiveLens, start, PAGE],
        })) as unknown as RawEntry[];
        all.push(...page);
        if (BigInt(page.length) < PAGE || all.length >= SAFETY) break;
      }
      if (myGen !== fetchGenRef.current) return; // a newer refetch (e.g. lens switch) superseded us
      setRawEntries(all);
    } catch (e) {
      console.error("[lists] failed to read entries", e);
    }
  }, [publicClient, listReaderAddress, listUID, effectiveLens]);
  useEffect(() => {
    // Clear stale rows on chain/list/lens identity change (refetchEntries is memoized on
    // publicClient/listUID/effectiveLens) so a network switch can't leave the old chain's entries —
    // and their Remove buttons — rendered while the new chain's read is in flight. (Codex P2 analog.)
    setRawEntries([]);
    void refetchEntries();
  }, [refetchEntries]);
  const { data: entrySchemaUID } = useReadContract({
    chainId: targetNetwork.id,
    address: listReaderAddress,
    abi: LIST_READER_ABI,
    functionName: "LIST_ENTRY_SCHEMA_UID",
    query: { enabled: !!listReaderAddress },
  });

  const targetType = mode ? Number(mode.targetType) : MODE.ANY;
  const meta = MODE_META[targetType] ?? MODE_META[0];
  // You can only edit your OWN edition — viewing another lens is read-only.
  const viewingOwn = !!connectedAddress && effectiveLens.toLowerCase() === connectedAddress.toLowerCase();
  // append-only blocks ONLY entry revocation (removal). Adding entries and changing
  // order/label PROPERTYs (which re-PIN, never revoke the entry) are still allowed —
  // so an append-only list (incl. an empty one) can still be populated and reordered.
  const canEdit = viewingOwn; // add / reorder / edit-label
  // `mode?.exists` gates Remove on the current chain's mode being loaded — otherwise a network switch
  // would briefly expose Remove (revoke) while `mode` is undefined, acting on a stale-chain entry UID.
  const canRemove = viewingOwn && !!mode?.exists && !mode.appendOnly; // entry revocation only

  // ── Entry-scoped order/label PROPERTY reads (ADR-0046, lens-scoped) ──────────
  // The order ("weight") and label ("name") that ADR-0044 stored inline now live as
  // PIN-bound PROPERTYs on the stable entry UID, scoped to the viewing attester.
  // We enrich the bare membership tuples by reading both properties per entry,
  // scoped to `effectiveLens`, then sort by the parsed order value ascending.

  /** Read one PIN-bound PROPERTY value (string) on a container, scoped to `attester`. */
  // Returns the property value, or null when it is genuinely ABSENT (no key anchor,
  // no active PIN, revoked, or malformed value). RPC/network errors are NOT swallowed
  // — they propagate so the caller can tell "read failed" from "no value set" (ADR-0046
  // F1: a transient blip must never masquerade as missing data and silently reorder).
  const readEntryProperty = useCallback(
    async (container: `0x${string}`, keyName: string, attester: `0x${string}`): Promise<string | null> => {
      if (!publicClient || !indexerAddress || !edgeResolverAddress || !propertySchemaUID || !easAddress) return null;
      const keyAnchorUID = (await publicClient.readContract({
        address: indexerAddress,
        abi: INDEXER_PROPERTY_ABI,
        functionName: "resolveAnchor",
        args: [container, keyName, propertySchemaUID as `0x${string}`],
      })) as `0x${string}`;
      if (!keyAnchorUID || keyAnchorUID === zeroHash) return null;

      const propertyUID = (await publicClient.readContract({
        address: edgeResolverAddress,
        abi: EDGE_RESOLVER_ABI,
        functionName: "getActivePinTarget",
        args: [keyAnchorUID, getAddress(attester), propertySchemaUID as `0x${string}`],
      })) as `0x${string}`;
      if (!propertyUID || propertyUID === zeroHash) return null;

      const att = (await publicClient.readContract({
        address: easAddress,
        abi: EAS_ABI,
        functionName: "getAttestation",
        args: [propertyUID],
      })) as { uid: `0x${string}`; revocationTime: bigint; data: `0x${string}` };
      if (!att || att.uid === zeroHash || toBig(att.revocationTime) !== 0n) return null;
      if (!att.data || att.data === "0x") return null;
      try {
        const [value] = decodeAbiParameters([{ type: "string" }], att.data) as [string];
        return value && value.length > 0 ? value : null; // malformed/empty value = absent
      } catch {
        return null;
      }
    },
    [publicClient, indexerAddress, edgeResolverAddress, propertySchemaUID, easAddress],
  );

  // ── List description (ADR-0046 pattern, lens-scoped) ─────────────────────────
  // The list's own "description" PROPERTY on the stable list UID, scoped to the
  // viewing lens. `null` falls back to MODE_META[targetType].blurb at render.
  const [listDescription, setListDescription] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!listReaderAddress) return;
    readEntryProperty(listUID, DESC_KEY, effectiveLens)
      .then(v => {
        if (!cancelled) setListDescription(v);
      })
      .catch(() => {
        if (!cancelled) setListDescription(null);
      });
    return () => {
      cancelled = true;
    };
  }, [listUID, effectiveLens, readEntryProperty, listReaderAddress]);

  // Display order — synced from chain (sorted by order property asc), mutated optimistically.
  const [items, setItems] = useState<Entry[]>([]);
  // Latest items, readable inside the enrich effect without making it a dependency —
  // used to retain last-known order/label when a read transiently fails (F1).
  const itemsRef = useRef<Entry[]>([]);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  // Clear immediately when the list or the viewed lens changes (entries refetch on arg change).
  // Also drop the prior lens's membership: the enrich effect below keys on `effectiveLens` and
  // would otherwise re-render the OLD `rawEntries` (still present until the async refetch lands)
  // under the NEW lens — briefly showing e.g. Bob's entry UIDs as Alice's editable edition, so
  // an edit/reorder in that window writes Alice-scoped PROPERTYs onto Bob's entry UIDs. Clearing
  // rawEntries here forces an empty enrich and cancels any in-flight stale enrich (the `cancelled`
  // guard) until `refetchEntries()` reloads for the new lens.
  useEffect(() => {
    setItems([]);
    setRawEntries(undefined);
  }, [uid, effectiveLens]);

  useEffect(() => {
    let cancelled = false;
    async function enrich() {
      const raw = (rawEntries as unknown as RawEntry[] | undefined) ?? [];
      if (raw.length === 0) {
        if (!cancelled) setItems([]);
        return;
      }
      const prevByUID = new Map(itemsRef.current.map(it => [it.entryUID, it]));
      // Read both properties for every entry in parallel (Promise.all of readContract;
      // the codebase has no multicall helper here, and readEntryProperty already
      // sequences the 3 dependent reads per property). Scoped to the viewing lens.
      const enriched = await Promise.all(
        raw.map(async e => {
          try {
            const [orderStr, label] = await Promise.all([
              readEntryProperty(e.entryUID, ORDER_KEY, effectiveLens),
              readEntryProperty(e.entryUID, NAME_KEY, effectiveLens),
            ]);
            let order: bigint | null = null;
            if (orderStr !== null) {
              try {
                order = BigInt(orderStr.trim());
              } catch {
                order = null;
              }
            }
            return { ...e, order, label } as Entry;
          } catch (err) {
            // F1: a transient RPC failure must NOT look like "no order/label" — that would
            // silently drop the entry to the bottom and blank its label. Retain the
            // last-known values for this entry and log loudly instead of swallowing.
            const prev = prevByUID.get(e.entryUID);
            console.error(`[lists] order/label read failed for ${e.entryUID}; keeping last-known`, err);
            return { ...e, order: prev?.order ?? null, label: prev?.label ?? null } as Entry;
          }
        }),
      );
      if (cancelled) return;
      // Sort by order asc; entries with no order property sort last, tie-broken by entryUID.
      enriched.sort((a, b) => {
        if (a.order === null && b.order === null) return a.entryUID < b.entryUID ? -1 : 1;
        if (a.order === null) return 1;
        if (b.order === null) return -1;
        if (a.order !== b.order) return a.order < b.order ? -1 : 1;
        return a.entryUID < b.entryUID ? -1 : 1;
      });
      setItems(enriched);
    }
    enrich();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawEntries, effectiveLens, readEntryProperty]);

  const [busy, setBusy] = useState(false);

  // ── On-chain primitives ─────────────────────────────────────────────────────

  // ADR-0046: LIST_ENTRY is pure membership identity — 2 fields, no weight.
  const encodeEntry = (target: `0x${string}`) =>
    encodeAbiParameters(
      [
        { name: "listUID", type: "bytes32" },
        { name: "target", type: "bytes32" },
      ],
      [listUID, target],
    );

  const extractUIDFromReceipt = (receipt: { logs: readonly { data: `0x${string}`; topics: `0x${string}`[] }[] }) => {
    for (const log of receipt.logs) {
      try {
        const event = decodeEventLog({
          abi: [
            parseAbiItem(
              "event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)",
            ),
          ],
          data: log.data,
          topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
        });
        return (event.args as { uid: `0x${string}` }).uid;
      } catch {
        // not our event
      }
    }
    return undefined;
  };

  /**
   * Attest a membership entry (ADR-0046) and return its UID. The UID is stable —
   * order/label PROPERTYs hang off it and survive reorder.
   */
  const attestEntry = async (recipient: `0x${string}`, target: `0x${string}`): Promise<`0x${string}`> => {
    const hash = await writeContractAsync({
      // Guard: reads follow targetNetwork, so pin writes to it too — wagmi throws
      // ChainMismatchError if the wallet is on a different chain (no cross-chain write).
      chainId: targetNetwork.id,
      address: easAddress!,
      abi: EAS_ABI,
      functionName: "attest",
      args: [
        {
          schema: entrySchemaUID as `0x${string}`,
          data: {
            recipient,
            expirationTime: 0n,
            revocable: true,
            refUID: zeroHash,
            data: encodeEntry(target),
            value: 0n,
          },
        },
      ],
    });
    const receipt = await publicClient!.waitForTransactionReceipt({ hash });
    const entryUID = extractUIDFromReceipt(receipt);
    if (!entryUID) throw new Error("Could not extract LIST_ENTRY UID");
    return entryUID;
  };

  /**
   * Place (or re-place) a PIN-bound PROPERTY on `container` (ADR-0046 / ADR-0035
   * pattern, copied from CreateItemModal's contentType flow): resolve-or-create the
   * key anchor, attest a free-floating PROPERTY value, then PIN it (cardinality 1 →
   * re-PIN supersedes in O(1)). Used for the entry's "weight" (order) and "name"
   * (label) properties on the stable entry UID.
   */
  const placeEntryProperty = async (
    container: `0x${string}`,
    keyName: string,
    value: string,
    opLog?: (msg: string) => void,
  ) => {
    if (!indexerAddress || !propertySchemaUID || !anchorSchemaUID || !pinSchemaUID || !easAddress || !publicClient) {
      throw new Error("Property placement not ready (missing schema UIDs).");
    }
    // (a) resolve the key anchor under the container; create it if missing.
    opLog?.(`Resolving “${keyName}” key anchor…`);
    let keyAnchorUID = (await publicClient.readContract({
      address: indexerAddress,
      abi: INDEXER_PROPERTY_ABI,
      functionName: "resolveAnchor",
      args: [container, keyName, propertySchemaUID as `0x${string}`],
    })) as `0x${string}`;
    if (!keyAnchorUID || keyAnchorUID === zeroHash) {
      opLog?.(`Creating “${keyName}” key anchor…`);
      const encodedKey = encodeAbiParameters(
        [
          { name: "name", type: "string" },
          { name: "schema", type: "bytes32" },
        ],
        [keyName, propertySchemaUID as `0x${string}`],
      );
      const keyHash = await writeContractAsync({
        chainId: targetNetwork.id,
        address: easAddress,
        abi: EAS_ABI,
        functionName: "attest",
        args: [
          {
            schema: anchorSchemaUID as `0x${string}`,
            data: {
              recipient: zeroAddress,
              expirationTime: 0n,
              revocable: false,
              refUID: container,
              data: encodedKey,
              value: 0n,
            },
          },
        ],
      });
      const keyReceipt = await publicClient.waitForTransactionReceipt({ hash: keyHash });
      const created = extractUIDFromReceipt(keyReceipt);
      if (!created) throw new Error(`Could not extract “${keyName}” key anchor UID`);
      keyAnchorUID = created;
    }

    // (b) free-floating PROPERTY value.
    opLog?.(`Writing “${keyName}” value…`);
    const encodedProperty = encodeAbiParameters([{ name: "value", type: "string" }], [value]);
    const propHash = await writeContractAsync({
      chainId: targetNetwork.id,
      address: easAddress,
      abi: EAS_ABI,
      functionName: "attest",
      args: [
        {
          schema: propertySchemaUID as `0x${string}`,
          data: {
            recipient: zeroAddress,
            expirationTime: 0n,
            revocable: false,
            refUID: zeroHash,
            data: encodedProperty,
            value: 0n,
          },
        },
      ],
    });
    const propReceipt = await publicClient.waitForTransactionReceipt({ hash: propHash });
    const propertyUID = extractUIDFromReceipt(propReceipt);
    if (!propertyUID) throw new Error(`Could not extract “${keyName}” PROPERTY UID`);

    // (c) PIN binding (cardinality 1; re-PIN supersedes the prior value in O(1)).
    opLog?.(`Binding “${keyName}”…`);
    const encodedPin = encodeAbiParameters([{ name: "definition", type: "bytes32" }], [keyAnchorUID]);
    const pinHash = await writeContractAsync({
      chainId: targetNetwork.id,
      address: easAddress,
      abi: EAS_ABI,
      functionName: "attest",
      args: [
        {
          schema: pinSchemaUID as `0x${string}`,
          data: {
            recipient: zeroAddress,
            expirationTime: 0n,
            revocable: true,
            refUID: propertyUID,
            data: encodedPin,
            value: 0n,
          },
        },
      ],
    });
    await publicClient.waitForTransactionReceipt({ hash: pinHash });
  };

  const revokeEntry = async (e: Entry) => {
    const hash = await writeContractAsync({
      chainId: targetNetwork.id,
      address: easAddress!,
      abi: EAS_ABI,
      functionName: "revoke",
      args: [{ schema: entrySchemaUID as `0x${string}`, data: { uid: e.entryUID, value: 0n } }],
    });
    await publicClient!.waitForTransactionReceipt({ hash });
    return hash;
  };

  // `ready` covers the entry write. Property placement additionally needs the
  // indexer + schema UIDs (checked inside placeEntryProperty); a failure there is
  // surfaced to the op log and notification rather than silently skipped.
  const ready =
    !!easAddress &&
    !!entrySchemaUID &&
    !!publicClient &&
    !!indexerAddress &&
    !!edgeResolverAddress &&
    !!propertySchemaUID &&
    !!anchorSchemaUID &&
    !!pinSchemaUID;

  // ── Add ───────────────────────────────────────────────────────────────────

  const [draft, setDraft] = useState("");
  // ADR-0046: ANY free-text labels are no longer length-capped — the human text
  // lives in a `name` PROPERTY, not packed into bytes32. No byte-count UI needed.

  // SCHEMA mode: validate the pasted attestation UID against the list's required schema
  // BEFORE the user pays gas. Saves a guaranteed-to-revert transaction.
  const schemaDraftIsUID = targetType === MODE.SCHEMA && draft.trim().startsWith("0x") && draft.trim().length === 66;
  const { data: draftAtt } = useReadContract({
    chainId: targetNetwork.id,
    address: easAddress,
    abi: EAS_ABI,
    functionName: "getAttestation",
    args: [draft.trim() as `0x${string}`],
    query: { enabled: schemaDraftIsUID && !!easAddress },
  });
  const draftAttExists = !!draftAtt && draftAtt.attester !== zeroAddress;
  const requiredSchema = mode?.targetSchema;
  const draftSchemaMatches =
    draftAttExists &&
    (!requiredSchema || requiredSchema === zeroHash || draftAtt.schema.toLowerCase() === requiredSchema.toLowerCase());
  // Block the Add button while the pre-flight is still loading too — otherwise a fast click
  // submits a tx the resolver will revert (the spinner shows but the button stayed enabled).
  const draftAttLoading = targetType === MODE.SCHEMA && schemaDraftIsUID && draftAtt === undefined;
  const schemaAddBlocked = targetType === MODE.SCHEMA && schemaDraftIsUID && (draftAttLoading || !draftSchemaMatches);

  // Next order rank = last item's order + step (the old nextWeight() logic, now
  // sourced from the order PROPERTY). Items with no order yet are ignored.
  const nextOrder = () => {
    const lastWithOrder = [...items].reverse().find(e => e.order !== null);
    return lastWithOrder?.order != null ? lastWithOrder.order + RANK_STEP : RANK_STEP;
  };

  const handleAdd = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!ready || !draft.trim() || busy) return;
    let recipient = zeroAddress as `0x${string}`;
    let target = zeroHash as `0x${string}`;
    // For ANY GENUINE free-text items the typed text becomes BOTH the opaque member
    // key (keccak, for dedup) and the `name` label PROPERTY (the human-readable
    // value). ANY mode also accepts a bare address or a 32-byte UID (attestation /
    // schema) — those are encoded as `target` directly with NO name property, so they
    // render as an address / attestation reference. `freeText` is set only for the
    // genuine-text case so the name PROPERTY is placed only then.
    let freeText = "";
    try {
      if (targetType === MODE.ADDR) {
        const v = draft.trim();
        if (!v.startsWith("0x") || v.length !== 42) return notification.error("Enter a resolved 0x address");
        recipient = v as `0x${string}`;
      } else if (targetType === MODE.SCHEMA) {
        const v = draft.trim();
        if (!v.startsWith("0x") || v.length !== 66) return notification.error("Enter an attestation UID (0x + 64 hex)");
        target = v as `0x${string}`;
      } else {
        // ANY (heterogeneous): auto-detect the input kind.
        const v = draft.trim();
        if (/^0x[0-9a-fA-F]{40}$/.test(v)) {
          // Bare address → bytes32(uint160(addr)) (left-padded; addrFromKey reverses it).
          target = ("0x" + v.slice(2).toLowerCase().padStart(64, "0")) as `0x${string}`;
        } else if (/^0x[0-9a-fA-F]{64}$/.test(v)) {
          // A 0x + 64-hex UID (attestation or schema) → use it directly.
          target = v as `0x${string}`;
        } else {
          // Genuine free text → keccak member key + a `name` label PROPERTY.
          freeText = v;
          target = memberKeyForText(freeText);
        }
      }
    } catch (err: any) {
      return notification.error(err?.message ?? "Invalid item");
    }

    const opId = ops.start(`Add ${meta.singular} to “${name}”`);
    setBusy(true);
    // Track the membership UID separately: add is multi-tx (entry → order → label),
    // and if a later tx fails the entry has already landed (F2).
    let createdEntryUID: `0x${string}` | undefined;
    try {
      ops.log(opId, "Attesting membership…");
      createdEntryUID = await attestEntry(recipient, target);
      // Label PROPERTY FIRST for ANY free-text: it's the only on-chain copy of the typed
      // text, and append-only entries can't be rolled back — so land the label before the
      // (less critical, recoverable-via-drag) order. For ADDR/SCHEMA the reference is the
      // entity itself; labels are an optional override added via edit later.
      if (targetType === MODE.ANY && freeText) {
        await placeEntryProperty(createdEntryUID, NAME_KEY, freeText, msg => ops.log(opId, msg));
      }
      // Order PROPERTY on the (stable) entry UID.
      await placeEntryProperty(createdEntryUID, ORDER_KEY, nextOrder().toString(), msg => ops.log(opId, msg));
      ops.complete(opId, "Added");
      setDraft("");
      await refetchEntries();
    } catch (err: any) {
      const msg = err?.shortMessage ?? err?.message ?? "Failed to add";
      if (createdEntryUID && mode?.appendOnly) {
        // Append-only lists reject entry revokes, so we CANNOT roll back the membership tx
        // (calling revokeEntry here would itself revert). The entry is permanent but
        // completable: order/label are PROPERTYs on the stable entry UID, so the user
        // finishes it via the row's ✎ (label, written label-first above) + drag (order).
        notification.error(
          "Entry added, but its label/order didn't finish saving. This list is append-only " +
            "(entries can't be removed) — use the ✎ on the row to set its label and drag to reorder.",
        );
      } else if (createdEntryUID) {
        // F2 (non-append-only): the entry landed but a follow-up PROPERTY write failed. An
        // ANY item's typed text is recoverable only from the label PROPERTY, so best-effort
        // revoke the half-written entry rather than orphan an unreadable keccak row.
        ops.log(opId, "Rolling back incomplete entry…");
        try {
          await revokeEntry({ entryUID: createdEntryUID } as Entry);
        } catch (rbErr) {
          console.error("[lists] failed to roll back orphaned entry", createdEntryUID, rbErr);
        }
        notification.error(/DuplicateIdentity/.test(msg) ? "That item is already in the list" : msg);
      } else {
        // The membership attest itself failed — nothing landed.
        notification.error(/DuplicateIdentity/.test(msg) ? "That item is already in the list" : msg);
      }
      ops.fail(opId, msg);
      await refetchEntries();
    } finally {
      setBusy(false);
    }
  };

  // ── Remove ──────────────────────────────────────────────────────────────────

  const handleRemove = async (entry: Entry) => {
    if (!ready || busy) return;
    const opId = ops.start(`Remove from “${name}”`);
    setBusy(true);
    setItems(prev => prev.filter(e => e.entryUID !== entry.entryUID)); // optimistic
    try {
      await revokeEntry(entry);
      ops.complete(opId, "Removed");
      await refetchEntries();
    } catch (err: any) {
      ops.fail(opId, err?.shortMessage ?? err?.message ?? "Failed to remove");
      await refetchEntries();
    } finally {
      setBusy(false);
    }
  };

  // ── Edit (ANY text — change the `name` label PROPERTY; entry UID is stable) ───
  // ADR-0046: the label lives in a per-entry `name` PROPERTY on the stable entry
  // UID. Editing re-attests + re-PINs that PROPERTY (cardinality 1 → O(1) supersede)
  // WITHOUT touching the entry, so the membership and order survive. The keccak
  // member key (identityKey) stays fixed — it's an opaque fingerprint of the
  // original text, not the display value — so the no-duplicates revoke/re-attest
  // data-loss footgun is gone entirely.

  const [editingUID, setEditingUID] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const startEdit = (e: Entry, current: string) => {
    setEditingUID(e.entryUID);
    setEditValue(current);
  };
  const cancelEdit = () => {
    setEditingUID(null);
    setEditValue("");
  };

  /** Current display label for an entry: name PROPERTY, else legacy unpacked text. */
  const entryLabel = (e: Entry): string => e.label ?? unpackText(e.identityKey) ?? "";

  const handleEditSave = async (entry: Entry) => {
    if (!ready || busy) return;
    const next = editValue.trim();
    const current = entryLabel(entry);
    if (!next || next === current) return cancelEdit();

    const opId = ops.start(`Edit item in “${name}”`);
    setBusy(true);
    cancelEdit();
    const snapshot = items; // F3: deterministic rollback target
    // optimistic label update
    setItems(prev => prev.map(e => (e.entryUID === entry.entryUID ? { ...e, label: next } : e)));
    try {
      await placeEntryProperty(entry.entryUID, NAME_KEY, next, msg => ops.log(opId, msg));
      ops.complete(opId, "Saved");
      await refetchEntries();
    } catch (err: any) {
      ops.fail(opId, err?.shortMessage ?? err?.message ?? "Failed to edit");
      setItems(snapshot); // restore known-good state first, independent of the refetch read
      await refetchEntries();
    } finally {
      setBusy(false);
    }
  };

  // ── Edit list description (owner-only; PIN-bound "description" PROPERTY) ──────
  // ADR-0046 pattern: the description lives in a per-list `description` PROPERTY on
  // the stable list UID, scoped to the viewing lens. Editing re-attests + re-PINs
  // that PROPERTY (cardinality 1 → O(1) supersede). Only the owner (viewingOwn) can
  // edit their own edition's description.

  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState("");
  const startEditDesc = () => {
    setDescDraft(listDescription ?? "");
    setEditingDesc(true);
  };
  const cancelEditDesc = () => {
    setEditingDesc(false);
    setDescDraft("");
  };

  const handleSaveDescription = async (text: string) => {
    const next = text.trim();
    if (busy) return;
    setEditingDesc(false);
    const opId = ops.start(`Edit description of “${name}”`);
    setBusy(true);
    setListDescription(next || null); // optimistic
    try {
      await placeEntryProperty(listUID, DESC_KEY, next, msg => ops.log(opId, msg));
      ops.complete(opId, "Saved");
    } catch (err: any) {
      ops.fail(opId, err?.shortMessage ?? err?.message ?? "Failed");
      setListDescription(await readEntryProperty(listUID, DESC_KEY, effectiveLens).catch(() => null));
    } finally {
      setBusy(false);
    }
  };

  // ── Reorder (drag → re-PIN the moved entry's order PROPERTY; entry UID stable) ─

  const dragSrc = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const handleDrop = async (destIndex: number) => {
    const src = dragSrc.current;
    dragSrc.current = null;
    setDragOver(null);
    if (src === null || src === destIndex || !ready || busy) return;

    // The drop indicator is a line at the TOP of the hovered row → "insert above row destIndex".
    // After removing src, every index above destIndex shifts down by one, so when dragging
    // downward (src < destIndex) the insertion point is destIndex - 1.
    const insertAt = src < destIndex ? destIndex - 1 : destIndex;
    const reordered = [...items];
    const [moved] = reordered.splice(src, 1);
    reordered.splice(insertAt, 0, moved);

    // computeInsertWeight (unit-tested) returns a midpoint rank, or { collision }
    // when adjacent ranks leave no integer room. The collision check happens BEFORE
    // any write, so a no-room drop is purely a no-op (the entry is never touched).
    const slot = computeInsertWeight(
      reordered[insertAt - 1]?.order ?? undefined,
      reordered[insertAt + 1]?.order ?? undefined,
    );
    if ("collision" in slot) {
      notification.error("No room to drop the item exactly here — move it a different way.");
      return; // keep current order; nothing optimistic applied
    }
    const newOrder = slot.weight;
    const snapshot = items; // F3: pre-reorder state, deterministic rollback target
    // optimistic: apply the new order + reordered view
    setItems(reordered.map(e => (e.entryUID === moved.entryUID ? { ...e, order: newOrder } : e)));

    const opId = ops.start(`Reorder “${name}”`);
    setBusy(true);
    try {
      // Re-PIN the order PROPERTY on the (stable) entry UID — supersedes in O(1).
      // The entry itself, its label, and its membership are untouched.
      await placeEntryProperty(moved.entryUID, ORDER_KEY, newOrder.toString(), msg => ops.log(opId, msg));
      ops.complete(opId, "Reordered");
      await refetchEntries();
    } catch (err: any) {
      const msg = err?.shortMessage ?? err?.message ?? "Failed to reorder";
      ops.fail(opId, msg);
      notification.error("Reorder failed — the item's position was not changed.");
      setItems(snapshot); // restore the true prior order first, independent of the refetch read
      await refetchEntries();
    } finally {
      setBusy(false);
    }
  };

  // ── Render helpers ────────────────────────────────────────────────────────

  const renderContent = (e: Entry) => {
    // Editing the label works for ANY row (text OR a referenced address/attestation):
    // the `name` PROPERTY is an override that takes precedence over the entity display.
    if (editingUID === e.entryUID) {
      return (
        <input
          autoFocus
          className="input input-xs w-full bg-base-100 border-primary/40"
          placeholder="Label (overrides the reference)…"
          value={editValue}
          onChange={ev => setEditValue(ev.target.value)}
          onKeyDown={ev => {
            if (ev.key === "Enter") handleEditSave(e);
            if (ev.key === "Escape") cancelEdit();
          }}
          onBlur={() => handleEditSave(e)}
        />
      );
    }
    // Reference rows (ADDR/SCHEMA): a `name` label override (if set) wins over the
    // entity's own display; otherwise show the address / attestation summary.
    if (e.targetType === MODE.ADDR) {
      return e.label ? (
        <span className="text-sm leading-snug break-words">{e.label}</span>
      ) : (
        <Address address={addrFromKey(e.identityKey)} size="sm" onlyEnsOrAddress />
      );
    }
    if (e.targetType === MODE.SCHEMA) {
      return e.label ? (
        <span className="text-sm leading-snug break-words">{e.label}</span>
      ) : (
        <AttestationLabel uid={e.identityKey} easAddress={easAddress} />
      );
    }
    // ANY (heterogeneous): an explicit `name` label always wins, then we auto-detect
    // the identityKey shape — left-padded address, full 32-byte UID, else opaque key.
    // 1. Explicit label (free text or override) → show it.
    const text = e.label ?? unpackText(e.identityKey);
    if (text !== null) {
      return <span className="text-sm leading-snug break-words">{text}</span>;
    }
    // 2. Address-shaped key (high 12 bytes zero, low 20 bytes nonzero) → Address.
    if (/^0x0{24}[0-9a-f]{40}$/i.test(e.identityKey) && e.identityKey !== zeroHash) {
      return <Address address={addrFromKey(e.identityKey)} size="sm" onlyEnsOrAddress disableAddressLink />;
    }
    // 3. Any other full 32-byte value → treat as a UID (attestation / schema).
    if (e.identityKey !== zeroHash) {
      return <AttestationLabel uid={e.identityKey} easAddress={easAddress} />;
    }
    // 4. Fallback → opaque key.
    return (
      <span className="font-mono text-xs text-base-content/50" title="Opaque key (not text)">
        {shortHex(e.identityKey)}
      </span>
    );
  };

  // ── Render ────────────────────────────────────────────────────────────────

  // Add bar — rendered at the TOP of the list (above the items scroll area).
  const addBar = canEdit && mode?.exists && (
    <form onSubmit={handleAdd} className="shrink-0 border-b border-base-300 p-3 bg-base-100/60">
      {targetType === MODE.ADDR ? (
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <AddressInput value={draft} onChange={setDraft} placeholder={meta.placeholder} disabled={busy} />
          </div>
          <button
            type="submit"
            className="btn btn-sm btn-primary btn-square flex-shrink-0"
            disabled={busy || !draft.trim()}
          >
            {busy ? <span className="loading loading-spinner loading-xs" /> : <PlusIcon className="w-4 h-4" />}
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <input
              className={`input input-sm w-full bg-base-200 border-transparent focus:bg-base-100 focus:border-base-300 ${targetType === MODE.SCHEMA ? "font-mono text-xs" : ""}`}
              placeholder={meta.placeholder}
              value={draft}
              onChange={ev => setDraft(ev.target.value)}
              disabled={busy}
              autoComplete="off"
            />
          </div>
          <button
            type="submit"
            className="btn btn-sm btn-primary btn-square flex-shrink-0"
            disabled={busy || !draft.trim() || schemaAddBlocked}
          >
            {busy ? <span className="loading loading-spinner loading-xs" /> : <PlusIcon className="w-4 h-4" />}
          </button>
        </div>
      )}
      {targetType === MODE.SCHEMA && schemaDraftIsUID && (
        <p className="text-[10px] mt-1.5 flex items-center gap-1">
          {draftAtt === undefined ? (
            <span className="text-base-content/40">Checking attestation…</span>
          ) : !draftAttExists ? (
            <span className="text-error">No attestation with that UID on this chain.</span>
          ) : !draftSchemaMatches ? (
            <span className="text-error">
              Wrong schema — this list only accepts {shortHex(requiredSchema ?? zeroHash)}.
            </span>
          ) : (
            <span className="text-success flex items-center gap-1">
              <CheckIcon className="w-3 h-3" /> Matches the list schema.
            </span>
          )}
        </p>
      )}
    </form>
  );

  return (
    <div className="preview-pane absolute inset-0 z-10 max-lg:bg-base-200 lg:static lg:w-[380px] lg:flex-shrink-0 flex flex-col overflow-hidden border-l border-base-300 bg-gradient-to-b from-base-100 to-base-200/40">
      {/* Header */}
      <div className="shrink-0 px-4 pt-4 pb-3 border-b border-base-300">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2.5 min-w-0">
            <div className="mt-0.5 w-8 h-8 rounded-lg bg-purple-500/15 flex items-center justify-center flex-shrink-0">
              <QueueListIcon className="w-4.5 h-4.5 text-purple-400" />
            </div>
            <div className="min-w-0 group/desc">
              <h3 className="font-semibold text-base leading-tight truncate tracking-tight">{name}</h3>
              {/* Description: the list's own "description" PROPERTY (lens-scoped),
                  falling back to the mode blurb. Owners can edit their own edition's. */}
              {editingDesc ? (
                <input
                  autoFocus
                  className="input input-xs w-full mt-0.5 bg-base-100 border-primary/40"
                  value={descDraft}
                  placeholder={meta.blurb}
                  onChange={ev => setDescDraft(ev.target.value)}
                  onKeyDown={ev => {
                    if (ev.key === "Enter") handleSaveDescription(descDraft);
                    if (ev.key === "Escape") cancelEditDesc();
                  }}
                  onBlur={() => handleSaveDescription(descDraft)}
                />
              ) : (
                <p className="text-[11px] text-base-content/45 leading-tight mt-0.5 flex items-center gap-1">
                  <span className="truncate">{listDescription ?? meta.blurb}</span>
                  {viewingOwn && (
                    <button
                      className="opacity-0 group-hover/desc:opacity-100 transition-opacity text-base-content/40 hover:text-primary flex-shrink-0"
                      disabled={busy}
                      onClick={startEditDesc}
                      title="Edit description"
                    >
                      <PencilSquareIcon className="w-3 h-3" />
                    </button>
                  )}
                </p>
              )}
            </div>
          </div>
          <button className="btn btn-ghost btn-xs btn-circle -mr-1 -mt-1" onClick={onClose}>
            <XMarkIcon className="w-4 h-4" />
          </button>
        </div>
        <div className="flex items-center gap-2 mt-2.5 text-[11px] text-base-content/40">
          <span className="font-medium text-base-content/60">{items.length}</span>
          <span>{meta.noun}</span>
          {mode?.maxEntries ? <span>· cap {mode.maxEntries.toString()}</span> : null}
          {mode?.appendOnly ? <span className="text-amber-500/80">· 🔒 append-only</span> : null}
          {curator && (
            <span className="ml-auto flex items-center gap-1">
              by <Address address={curator} size="xs" onlyEnsOrAddress disableAddressLink />
            </span>
          )}
        </div>
      </div>

      {/* Editions / lens picker — each contributor has their own edition of the list */}
      {mode?.exists && lensChips.length > 1 && (
        <div className="shrink-0 px-3 py-2 border-b border-base-300 flex items-center gap-1.5 overflow-x-auto">
          <span className="text-[10px] uppercase tracking-wide text-base-content/35 flex-shrink-0 mr-0.5">Edition</span>
          {lensChips.map(a => {
            const selected = effectiveLens.toLowerCase() === a.toLowerCase();
            const isYou = !!connectedAddress && a.toLowerCase() === connectedAddress.toLowerCase();
            const isCurator = !!curator && a.toLowerCase() === curator.toLowerCase();
            return (
              <button
                key={a}
                onClick={() => setLens(a)}
                title={a}
                className={`flex items-center gap-1 rounded-full px-2 py-0.5 flex-shrink-0 border transition-colors ${
                  selected
                    ? "border-purple-500/60 bg-purple-500/10"
                    : "border-base-300 opacity-60 hover:opacity-100 hover:bg-base-200"
                }`}
              >
                <Address address={a} size="xs" onlyEnsOrAddress disableAddressLink />
                {isYou ? (
                  <span className="text-[9px] text-purple-400">you</span>
                ) : isCurator ? (
                  <span className="text-[9px] text-base-content/40">curator</span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}

      {/* Read-only banner when viewing someone else's edition */}
      {mode?.exists && !viewingOwn && (
        <div className="shrink-0 px-4 py-1.5 text-[11px] text-base-content/45 border-b border-base-300 flex items-center gap-1.5">
          <span>👁 Viewing another edition (read-only).</span>
          {connectedAddress && (
            <button className="text-purple-400 hover:underline" onClick={() => setLens(connectedAddress)}>
              Switch to yours
            </button>
          )}
        </div>
      )}

      {/* Add bar — at the top of the list, above the items scroll area */}
      {addBar}

      {/* Items */}
      <div className="flex-1 overflow-y-auto">
        {mode && !mode.exists && (
          <div className="px-4 py-6 text-sm text-warning">List not found — wrong UID or schema.</div>
        )}

        {mode?.exists && items.length === 0 && (
          <div className="flex flex-col items-center justify-center h-40 gap-3 text-base-content/25 px-6 text-center">
            <QueueListIcon className="w-10 h-10" />
            <span className="text-sm">
              {canEdit ? `Empty — add your first ${meta.singular} above` : "No items yet"}
            </span>
          </div>
        )}

        <ul className="py-1">
          {items.map((e, i) => {
            const top3 = i < 3;
            return (
              <li
                key={e.entryUID}
                draggable={canEdit && editingUID !== e.entryUID}
                onDragStart={() => (dragSrc.current = i)}
                onDragOver={ev => {
                  ev.preventDefault();
                  setDragOver(i);
                }}
                onDragLeave={() => setDragOver(d => (d === i ? null : d))}
                onDrop={() => handleDrop(i)}
                onDragEnd={() => {
                  dragSrc.current = null;
                  setDragOver(null);
                }}
                className={[
                  "group flex items-center gap-2.5 pl-3 pr-2 py-2 transition-colors",
                  dragOver === i ? "shadow-[inset_0_2px_0_0_theme(colors.purple.500)]" : "",
                  "hover:bg-base-content/[0.04]",
                  dragSrc.current === i ? "opacity-40" : "",
                ].join(" ")}
              >
                {/* Rank + drag handle (handle overlays rank on hover) */}
                <div className="relative w-6 flex-shrink-0 flex items-center justify-center">
                  <span
                    className={`tabular-nums text-xs font-medium transition-opacity ${canEdit ? "group-hover:opacity-0" : ""} ${top3 ? "text-purple-400" : "text-base-content/35"}`}
                  >
                    {i + 1}
                  </span>
                  {canEdit && (
                    <span
                      className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 text-base-content/30 cursor-grab active:cursor-grabbing"
                      title="Drag to reorder (writes on-chain)"
                    >
                      <DragDots />
                    </span>
                  )}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">{renderContent(e)}</div>

                {/* Row actions */}
                {canEdit && editingUID !== e.entryUID && (
                  <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                    <button
                      className="btn btn-ghost btn-xs btn-square text-base-content/40 hover:text-primary"
                      disabled={busy}
                      onClick={() => startEdit(e, entryLabel(e))}
                      title={e.targetType === MODE.ANY ? "Edit / label" : "Label"}
                    >
                      <PencilSquareIcon className="w-3.5 h-3.5" />
                    </button>
                    {e.targetType === MODE.SCHEMA && (
                      <a
                        className="btn btn-ghost btn-xs btn-square text-base-content/40 hover:text-primary"
                        href={`/easexplorer?uid=${e.identityKey}`}
                        target="_blank"
                        rel="noreferrer"
                        title="View attestation"
                      >
                        <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" />
                      </a>
                    )}
                    {/* Removal is the only thing append-only blocks. */}
                    {canRemove && (
                      <button
                        className="btn btn-ghost btn-xs btn-square text-base-content/40 hover:text-error"
                        disabled={busy}
                        onClick={() => handleRemove(e)}
                        title="Remove"
                      >
                        <XMarkIcon className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                )}

                {editingUID === e.entryUID && (
                  <button
                    className="btn btn-ghost btn-xs btn-square text-success flex-shrink-0"
                    onMouseDown={ev => ev.preventDefault()}
                    onClick={() => handleEditSave(e)}
                    title="Save"
                  >
                    <CheckIcon className="w-4 h-4" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {!connectedAddress && (
        <div className="shrink-0 border-t border-base-300 px-4 py-3 text-xs text-base-content/40">
          Connect a wallet to edit this list.
        </div>
      )}
    </div>
  );
};
