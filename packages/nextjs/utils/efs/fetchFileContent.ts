import { ethers } from "ethers";
import type { Abi, PublicClient } from "viem";
import { type TransportType, detectTransport, resolveGatewayUrl } from "~~/utils/efs/transports";

export interface FetchedFile {
  bytes: Uint8Array;
  contentType: string | null;
  source: "onchain" | "mirror";
  /**
   * Resolved transport for the file. For on-chain SSTORE2 bodies this is
   * `"onchain"`; for external mirrors it is the transport detected from the
   * delegated URI (ipfs / arweave / https / magnet / unknown). The caller uses
   * this to drive its transport badge identically to the prior inline logic.
   */
  transport: TransportType;
}

export interface FetchFileArgs {
  routerAddress: `0x${string}`;
  routerAbi: Abi;
  publicClient: PublicClient;
  lensAddresses: string[];
  /** Full router resource path to the file, e.g. [...currentPathNames, fileName]. */
  resourcePath: string[];
}

/**
 * Pure router-fetch for a single file's bytes. Mirrors the read flow documented
 * in `specs/overview.md` § Read flow:
 *   EFSRouter.request([...path], [{key:"lenses",...}, {key:"chunk",...}]) via the
 *   wagmi publicClient, reassembling on-chain SSTORE2 chunks through EIP-7617
 *   `web3-next-chunk` header pagination, and for external mirrors following the
 *   `message/external-body` Content-Type → resolveGatewayUrl → fetch.
 *
 * Holds ONLY the fetch logic — no React state, no cancellation. The caller owns
 * its own staleness/cancellation guard and maps the returned bytes onto state.
 *
 * Signature is shaped toward the planned SDK `fetch(ref, opts)` (holistic-review
 * DX-2): a parameterized async function returning raw bytes + content metadata.
 */
export async function fetchFileContent(args: FetchFileArgs): Promise<FetchedFile> {
  const { routerAddress, routerAbi, publicClient, lensAddresses, resourcePath } = args;

  const result: number[] = [];
  let contentTypeStr = "text/plain";
  let source: "onchain" | "mirror" = "onchain";
  let transport: TransportType = "onchain";

  let hasMoreChunks = true;
  let currentChunkHeader = "";

  while (hasMoreChunks) {
    const queryParams: any[] = [];
    if (lensAddresses.length > 0) {
      queryParams.push({ key: "lenses", value: lensAddresses.join(",") });
    }

    // Chunk pagination: after the first response, `web3-next-chunk` header
    // carries the next chunk index (format "?chunk=N"); forward it back.
    if (currentChunkHeader) {
      const chunkIndex = currentChunkHeader.split("=")[1];
      if (chunkIndex !== undefined) {
        queryParams.push({ key: "chunk", value: chunkIndex });
      }
    }

    const callArgs: any[] = [[...resourcePath], queryParams];

    const response = (await publicClient.readContract({
      address: routerAddress,
      abi: routerAbi,
      functionName: "request",
      args: callArgs as any,
    })) as any;

    if (response[0] === 200n || response[0] === 200) {
      const outHeaders = response[2] as any[];
      const ctHeaders = outHeaders.filter((h: any) => h.key.toLowerCase() === "content-type");

      // Detect external-body delegation (IPFS, Arweave, HTTPS mirrors)
      const externalHeader = ctHeaders.find((h: any) => h.value.includes("message/external-body"));
      if (externalHeader) {
        // Extract the original URI from: message/external-body; access-type=URL; URL="ipfs://..."
        const urlMatch = externalHeader.value.match(/URL="([^"]+)"/);
        const externalUri = urlMatch?.[1];
        // Extract the actual MIME type from the content-type= parameter in the
        // message/external-body header (router embeds it as a quoted parameter).
        const ctParam = externalHeader.value.match(/content-type="([^"]+)"/);
        if (ctParam?.[1]) contentTypeStr = ctParam[1];

        if (externalUri) {
          source = "mirror";
          transport = detectTransport(externalUri);
          const gatewayUrl = resolveGatewayUrl(externalUri);
          if (gatewayUrl) {
            // Fetch from gateway
            const gatewayResp = await globalThis.fetch(gatewayUrl);
            if (!gatewayResp.ok) throw new Error(`Gateway returned ${gatewayResp.status} for ${gatewayUrl}`);
            const buf = await gatewayResp.arrayBuffer();
            const bytes = new Uint8Array(buf);
            for (let i = 0; i < bytes.length; i++) result.push(bytes[i]);
            // Use gateway content-type as fallback if we didn't get one from the contract
            if (contentTypeStr === "text/plain") {
              const gwCt = gatewayResp.headers.get("content-type");
              if (gwCt) contentTypeStr = gwCt.split(";")[0].trim();
            }
          }
          hasMoreChunks = false;
          break;
        }
      }

      // On-chain body
      const bodyHex = response[1] as `0x${string}`;
      if (bodyHex && bodyHex !== "0x") {
        const bodyBytes = ethers.getBytes(bodyHex);
        for (let i = 0; i < bodyBytes.length; i++) {
          result.push(bodyBytes[i]);
        }
      }
      // Use first content-type header for on-chain responses
      if (ctHeaders.length > 0) contentTypeStr = ctHeaders[0].value;

      // Check for next chunk
      const nextChunkHeader = outHeaders.find((h: any) => h.key.toLowerCase() === "web3-next-chunk");
      if (nextChunkHeader) {
        currentChunkHeader = nextChunkHeader.value;
      } else {
        hasMoreChunks = false;
      }
    } else {
      throw new Error(`Router returned HTTP ${response[0]}`);
    }
  }

  return {
    bytes: new Uint8Array(result),
    contentType: contentTypeStr,
    source,
    transport,
  };
}
