import type { PublicClient } from "viem";
import { getAddress, isAddress, isHex, zeroAddress, zeroHash } from "viem";
import { normalize } from "viem/ens";

export type ContainerKind = "anchor" | "address" | "schema" | "attestation";

export type ClassifiedContainer = {
  kind: ContainerKind;
  /**
   * Canonical on-chain key for the container:
   * - anchor: attestation UID (bytes32)
   * - address: bytes32(uint160(addr)) — upper 12 bytes zero
   * - schema: schema UID (bytes32)
   * - attestation: attestation UID (bytes32)
   */
  uid: `0x${string}`;
  /**
   * Human-friendly label (ENS name when available, short UID, or raw segment).
   */
  displayName: string;
  /**
   * For address containers, the resolved checksummed address.
   */
  address?: `0x${string}`;
  /**
   * Raw URL segment as typed by the user, before resolution.
   */
  rawSegment: string;
};

const SCHEMA_REGISTRY_ABI = [
  {
    inputs: [{ name: "uid", type: "bytes32" }],
    name: "getSchema",
    outputs: [
      {
        components: [
          { name: "uid", type: "bytes32" },
          { name: "resolver", type: "address" },
          { name: "revocable", type: "bool" },
          { name: "schema", type: "string" },
        ],
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

// NOTE: Tuple order MUST match EAS's on-chain `Attestation` struct in
// `Common.sol` exactly: uid, schema, time, expirationTime, revocationTime,
// refUID, recipient, attester, revocable, data. An earlier revision had
// `refUID` before `time` and `revocable` before the two addresses, which
// causes viem to reject `recipient` when decoding it as bool — so every
// valid 64-byte attestation UID hit the `catch` branch and fell through
// to the anchor fallback, breaking ADR-0033 `/0x<attestationUID>/…` URLs.
// Keep field order locked to the Solidity struct.
const EAS_ATTESTATION_ABI = [
  {
    inputs: [{ name: "uid", type: "bytes32" }],
    name: "getAttestation",
    outputs: [
      {
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
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getSchemaRegistry",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

function addressToBytes32(addr: `0x${string}`): `0x${string}` {
  const clean = addr.toLowerCase().replace(/^0x/, "");
  return ("0x" + "0".repeat(24) + clean) as `0x${string}`;
}

function shortHex(hex: string): string {
  if (hex.length <= 10) return hex;
  return `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

function normalizeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return raw.trim();
  }
}

export type ClassifyDeps = {
  /**
   * Target-chain client (hardhat on devnet, per `scaffold.config.ts`). Used for
   * EAS `getAttestation` / SchemaRegistry `getSchema` — those contracts live on
   * the same chain the rest of EFS is deployed on.
   */
  publicClient: PublicClient | undefined;
  /**
   * Mainnet client (wagmi's `usePublicClient({ chainId: 1 })`). Used **only**
   * for ENS `getEnsAddress`. ENS lives on mainnet; calling `getEnsAddress` on
   * the hardhat client throws because hardhat has no ENS registry, and the
   * catch path would silently drop the token. Without this client the ENS
   * branch is skipped and `.eth` segments fall through to the anchor
   * classifier — matching ADR-0033's off-chain-ENS expectation while keeping
   * devnet-without-mainnet-RPC cases functional.
   */
  mainnetPublicClient?: PublicClient | undefined;
  easAddress: `0x${string}` | undefined;
  /** Optional: if known, avoids an extra RPC round-trip for `getSchemaRegistry`. */
  schemaRegistryAddress?: `0x${string}`;
};

/**
 * Classify the top-level URL segment into one of four container flavors.
 *
 * Precedence: address (ENS / 40-hex) → schema UID (64-hex, registered) →
 * attestation UID (64-hex, exists) → anchor (name). See ADR-0033.
 */
export async function classifyTopLevelSegment(raw: string, deps: ClassifyDeps): Promise<ClassifiedContainer> {
  const segment = normalizeSegment(raw);
  const rawSegment = raw;

  if (!segment) {
    return { kind: "anchor", uid: zeroHash as `0x${string}`, displayName: rawSegment, rawSegment };
  }

  // 1. ENS names (*.eth) — resolve to an address on MAINNET. Do not fall back
  // to `deps.publicClient`: on hardhat that throws and the catch would
  // silently treat `/vitalik.eth/…` as an anchor path, breaking the address
  // container contract from ADR-0033. If the mainnet client isn't wired up
  // (e.g. a unit-test context), skip the ENS branch entirely and let the
  // classifier fall through to the raw-hex / UID / anchor branches below.
  //
  // Normalize per ENSIP-15 via viem's `normalize()` before both the
  // `.eth`-suffix check and the resolver call. `segment.toLowerCase()` alone
  // is not sufficient: viem's `getEnsAddress` requires a canonical name and
  // rejects mixed-case inputs, so `/explorer/Vitalik.ETH` previously resolved
  // to null and fell through to the anchor classifier even though the name
  // was valid. `normalize()` also handles non-ASCII edge cases (emoji,
  // punycode) that pure lowercasing would miss. Throws on structurally
  // invalid names — catch and fall through in that case.
  if (deps.mainnetPublicClient) {
    let ensName: string | null = null;
    try {
      const candidate = normalize(segment);
      if (candidate.endsWith(".eth")) ensName = candidate;
    } catch {
      // not a valid ENS label — fall through
    }
    if (ensName) {
      try {
        const resolved = await deps.mainnetPublicClient.getEnsAddress({ name: ensName });
        if (resolved && resolved !== zeroAddress) {
          const checksummed = getAddress(resolved);
          return {
            kind: "address",
            uid: addressToBytes32(checksummed),
            displayName: ensName,
            address: checksummed,
            rawSegment,
          };
        }
      } catch {
        // fall through to other classifiers
      }
    }
  }

  // 2. Raw 40-char hex — Ethereum address.
  //
  // Zero-address poisoning guard: `/0x0000…0000/foo` must fall through to the
  // anchor branch — mirroring EFSRouter._classifyTopLevel (see ADR-0033). The
  // router treats address(0) as "no container" (EAS uses it as the "no
  // recipient" sentinel, not a user), and address containers default their
  // editions to `[connected, viewed]`, which would inject zero into the list
  // if we let it through. Keeping the two classifiers byte-identical avoids a
  // UI/router split that's invisible in local dev but drifts at the edges.
  const hexBody = segment.startsWith("0x") || segment.startsWith("0X") ? segment.slice(2) : segment;
  const looksHex = /^[0-9a-fA-F]+$/.test(hexBody);

  if (looksHex && hexBody.length === 40) {
    const candidate = `0x${hexBody}` as `0x${string}`;
    if (isAddress(candidate)) {
      const checksummed = getAddress(candidate);
      if (checksummed !== zeroAddress) {
        return {
          kind: "address",
          uid: addressToBytes32(checksummed),
          displayName: shortHex(checksummed),
          address: checksummed,
          rawSegment,
        };
      }
      // address(0) → fall through to anchor, matching the router.
    }
  }

  // 3. Raw 64-char hex — schema UID or attestation UID.
  //    bytes32(0) is rejected for the same poisoning reason (the root anchor
  //    UID is 0 before indexer wiring; a classified-zero UID would collide).
  if (looksHex && hexBody.length === 64 && !/^0+$/.test(hexBody)) {
    const uid = `0x${hexBody.toLowerCase()}` as `0x${string}`;
    if (isHex(uid) && deps.publicClient && deps.easAddress) {
      // Try SchemaRegistry first.
      let registryAddr = deps.schemaRegistryAddress;
      if (!registryAddr) {
        try {
          const fetched = (await deps.publicClient.readContract({
            address: deps.easAddress,
            abi: EAS_ATTESTATION_ABI,
            functionName: "getSchemaRegistry",
          })) as `0x${string}`;
          if (fetched && fetched !== zeroAddress) registryAddr = fetched;
        } catch {
          // ignore — fall through to attestation lookup
        }
      }

      if (registryAddr) {
        try {
          const schema = (await deps.publicClient.readContract({
            address: registryAddr,
            abi: SCHEMA_REGISTRY_ABI,
            functionName: "getSchema",
            args: [uid],
          })) as { uid: `0x${string}` };
          if (schema && schema.uid && schema.uid !== zeroHash) {
            return { kind: "schema", uid, displayName: shortHex(uid), rawSegment };
          }
        } catch {
          // fall through to attestation lookup
        }
      }

      // Try EAS attestation lookup.
      try {
        const att = (await deps.publicClient.readContract({
          address: deps.easAddress,
          abi: EAS_ATTESTATION_ABI,
          functionName: "getAttestation",
          args: [uid],
        })) as { uid: `0x${string}` };
        if (att && att.uid && att.uid !== zeroHash) {
          return { kind: "attestation", uid, displayName: shortHex(uid), rawSegment };
        }
      } catch {
        // fall through to anchor fallback
      }
    }
  }

  // 4. Fall through — treat as anchor name. The page walker resolves the actual UID.
  return { kind: "anchor", uid: zeroHash as `0x${string}`, displayName: segment, rawSegment };
}

/**
 * Build the path-segment array consumed by `EFSRouter.request([...])` and
 * `web3://` URLs. The head segment must match what `EFSRouter._classifyTopLevel`
 * accepts — ENS names do not resolve on-chain (ADR-0033: "ENS resolution stays
 * off-chain"), so an address container must present its *resolved* hex address
 * at the head, not the typed ENS label.
 *
 * - Anchor (no container): path names verbatim (root is implicit).
 * - Address: head = resolved checksummed address; router hex-parses it.
 * - Schema / Attestation: head = rawSegment (already a 0x-prefixed 64-hex UID
 *   because the classifier only reached this branch on hex input).
 *
 * The returned array is distinct from the UI path (which keeps `rawSegment` so
 * the displayed breadcrumb says `vitalik.eth`, not `0x8626…1199`).
 */
export function buildRouterPathNames(
  container: ClassifiedContainer | null,
  currentPath: { uid: string; name: string }[],
): string[] {
  const tail = currentPath.slice(1).map(p => p.name);
  if (!container) return tail;
  const head = container.kind === "address" && container.address ? container.address : container.rawSegment;
  return [head, ...tail];
}

/**
 * Devnet bootstrap curator address — included in the default `system` fallback
 * tier so fresh users see seeded content before any web-of-trust is configured.
 * Devnet-only; the mainnet build replaces this with a user-configurable seed
 * list (see ADR-0039 and `docs/FUTURE_WORK.md`).
 */
export const DEVNET_BOOTSTRAP_CURATOR = "0xaCf4C2950107eF9b1C37faA1F9a866C8F0da88b9" as const;

/**
 * Compute the effective editions list for a container. Implements the default
 * editions priority chain from ADR-0039:
 *
 *   explicit ?editions=  →  wholesale override (ADR-0031 / ADR-0033 invariant).
 *   otherwise:            connected → viewed (address container) → webOfTrust → system
 *
 * `explicitEditions` preserves URL shareability — a link with `?editions=…`
 * means exactly what it says to every viewer. The default chain only applies
 * when the URL carries no editions param.
 *
 * The tiers themselves:
 *   - **connected**: the user's own wallet. Their attestations always win
 *     over anyone else's when they're logged in.
 *   - **viewed**: the address in the URL segment when the container is an
 *     address ("Vitalik's memes, with my overrides on top"); empty otherwise.
 *   - **webOfTrust** (future, ADR-0039): attesters the user has explicitly
 *     trusted. Empty until the web-of-trust UX ships.
 *   - **system**: a global tail fallback so unseeded users still see some
 *     content. On devnet: a bootstrap curator address + the EFS deployer.
 *     End-users will eventually be able to configure this tier themselves.
 *
 * Dedupes case-insensitively; drops zero addresses; preserves order so
 * first-attester-wins semantics (ADR-0031) still apply inside the chain.
 */
export function defaultEditionsForContainer(args: {
  container: ClassifiedContainer | null;
  connectedAddress: string | undefined;
  explicitEditions: string[] | null;
  /** Future web-of-trust attesters (user-configured). Empty array until the
   *  WoT UX ships — the param exists so callers don't need plumbing changes
   *  when it does. */
  webOfTrust?: string[];
  /** System tail attesters (devnet: bootstrap curator + deployer). Populated
   *  by the caller because the deployer address is a runtime read from the
   *  indexer. */
  systemEditions?: string[];
}): string[] {
  // `explicitEditions !== null` means the URL carried `?editions=` — preserve
  // that intent as a wholesale override even when the resolved list is empty.
  // An explicit `?editions=alice.eth,bob.eth` whose tokens all fail to resolve
  // (ENS outage, invalid hex, unregistered name) must NOT silently fall back
  // to the default chain — that would change the meaning of a shared link and
  // surface unintended content. Empty explicit = show nothing; the caller's
  // directory hook early-returns on a zero-length list, so the user sees an
  // empty grid until the URL is fixed, not someone else's edition.
  // See ADR-0031 (wholesale override) + P2 review on #9.
  if (args.explicitEditions !== null) return args.explicitEditions;

  const out: string[] = [];
  const push = (addr: string | undefined) => {
    if (!addr) return;
    if (addr === zeroAddress) return;
    if (out.some(a => a.toLowerCase() === addr.toLowerCase())) return;
    out.push(addr);
  };

  push(args.connectedAddress);
  if (args.container?.kind === "address" && args.container.address) {
    push(args.container.address);
  }
  (args.webOfTrust ?? []).forEach(push);
  (args.systemEditions ?? []).forEach(push);
  return out;
}
