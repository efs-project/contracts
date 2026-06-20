import { expect } from "chai";
import { ethers } from "hardhat";
import { setCode } from "@nomicfoundation/hardhat-network-helpers";

/**
 * EFSBytesStore — production on-chain byte store (ADR-0057).
 *
 * Exercises BOTH read surfaces of the dual-interface store over the same
 * underlying SSTORE2 chunks:
 *
 *   1. Chunk interface (`chunkCount` / `chunkAddress`) — the EFSRouter's
 *      efficient extcodecopy path.
 *   2. ERC-5219 resource (`resolveMode` / `request`) — the standalone path a
 *      generic web3:// client uses against a bare `web3://<store>` URL, with
 *      EIP-7617 chunk pagination (`request` returns one chunk per call + a
 *      `web3-next-chunk` header; the client walks the chain).
 *
 * Chunks are planted with `setCode` as raw SSTORE2 runtimes (`0x00 || data`,
 * the STOP-opcode convention the store skips when reading a chunk).
 */
describe("EFSBytesStore", function () {
  // Deterministic chunk-contract addresses (arbitrary; code is planted via setCode).
  const CHUNK_ADDRS = [
    "0x0000000000000000000000000000000000000100",
    "0x0000000000000000000000000000000000000101",
    "0x0000000000000000000000000000000000000102",
  ];

  /** Plant `data` as an SSTORE2 chunk runtime (`0x00 || data`) at `addr`. */
  const plantChunk = async (addr: string, data: Uint8Array) => {
    await setCode(addr, "0x00" + Buffer.from(data).toString("hex"));
  };

  const deployStore = async (chunkAddrs: string[], contentType: string) => {
    const factory = await ethers.getContractFactory("EFSBytesStore");
    const store = await factory.deploy(chunkAddrs, contentType);
    await store.waitForDeployment();
    return store;
  };

  const header = (headers: readonly (readonly [string, string])[], name: string) =>
    headers.find(h => h[0] === name)?.[1];

  /**
   * Reassemble a file by following the EIP-7617 `web3-next-chunk` chain exactly as
   * a standard client (`web3protocol-js`) does: start at the bare URL (`request([], [])`),
   * concatenate each chunk body, and follow `web3-next-chunk: /?chunk=<n>` until it
   * is absent. Returns the full bytes + the Content-Type taken from the first response.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fetchViaPagination = async (store: any) => {
    const bodies: Buffer[] = [];
    let params: { key: string; value: string }[] = [];
    let contentType: string | undefined;
    // Bound the loop defensively so a buggy contract can't hang the test.
    for (let guard = 0; guard < 1000; guard++) {
      const [statusCode, body, headers] = await store.request([], params);
      expect(statusCode).to.equal(200);
      bodies.push(Buffer.from(ethers.getBytes(body)));
      if (contentType === undefined) contentType = header(headers, "Content-Type");
      const next = header(headers, "web3-next-chunk");
      if (!next) return { bytes: Buffer.concat(bodies), contentType };
      const m = next.match(/chunk=(\d+)/);
      expect(m, `next-chunk value must contain chunk=<n>, got ${next}`).to.not.equal(null);
      params = [{ key: "chunk", value: m![1] }];
    }
    throw new Error("pagination did not terminate");
  };

  describe("chunk interface (router extcodecopy path)", function () {
    it("reports chunk count and addresses from the constructor", async function () {
      const store = await deployStore(CHUNK_ADDRS, "application/octet-stream");
      expect(await store.chunkCount()).to.equal(BigInt(CHUNK_ADDRS.length));
      for (let i = 0; i < CHUNK_ADDRS.length; i++) {
        expect((await store.chunkAddress(i)).toLowerCase()).to.equal(CHUNK_ADDRS[i].toLowerCase());
      }
    });

    it("reverts on an out-of-bounds chunk index", async function () {
      const store = await deployStore([CHUNK_ADDRS[0]], "text/plain");
      await expect(store.chunkAddress(1)).to.be.reverted;
    });
  });

  describe("ERC-5219 resource (generic web3:// client path)", function () {
    it("advertises manual resolve mode 5219", async function () {
      const store = await deployStore([CHUNK_ADDRS[0]], "text/plain");
      expect(await store.resolveMode()).to.equal(ethers.encodeBytes32String("5219"));
    });

    it("single-chunk store returns the whole file in one call with no next-chunk header", async function () {
      const data = Buffer.from("hello, web3://", "utf8");
      await plantChunk(CHUNK_ADDRS[0], data);
      const store = await deployStore([CHUNK_ADDRS[0]], "text/plain");

      const [statusCode, body, headers] = await store.request([], []);
      expect(statusCode).to.equal(200);
      expect(Buffer.from(ethers.getBytes(body))).to.deep.equal(data);
      expect(headers.length).to.equal(1);
      expect(headers[0][0]).to.equal("Content-Type");
      expect(headers[0][1]).to.equal("text/plain");
      expect(header(headers, "web3-next-chunk")).to.equal(undefined);
    });

    it("first call (no params) returns chunk 0 plus a web3-next-chunk header for a multi-chunk store", async function () {
      const parts = [Buffer.from("AAAA"), Buffer.from("BBBBBB"), Buffer.from("CC")];
      for (let i = 0; i < parts.length; i++) await plantChunk(CHUNK_ADDRS[i], parts[i]);
      const store = await deployStore(CHUNK_ADDRS, "application/octet-stream");

      const [statusCode, body, headers] = await store.request([], []);
      expect(statusCode).to.equal(200);
      expect(Buffer.from(ethers.getBytes(body))).to.deep.equal(parts[0]); // chunk 0 ONLY, not the whole file
      expect(header(headers, "Content-Type")).to.equal("application/octet-stream");
      // LEADING SLASH is required for web3protocol-js to rewrite it into a fetchable URL.
      expect(header(headers, "web3-next-chunk")).to.equal("/?chunk=1");
    });

    it("following the web3-next-chunk chain reassembles the full file in order", async function () {
      const parts = [Buffer.from("AAAA"), Buffer.from("BBBBBB"), Buffer.from("CC")];
      for (let i = 0; i < parts.length; i++) await plantChunk(CHUNK_ADDRS[i], parts[i]);
      const store = await deployStore(CHUNK_ADDRS, "text/markdown");

      const { bytes, contentType } = await fetchViaPagination(store);
      expect(bytes).to.deep.equal(Buffer.concat(parts));
      expect(contentType).to.equal("text/markdown");
    });

    it("serves a requested mid chunk with the correct next-chunk header", async function () {
      const parts = [Buffer.from("AAAA"), Buffer.from("BBBBBB"), Buffer.from("CC")];
      for (let i = 0; i < parts.length; i++) await plantChunk(CHUNK_ADDRS[i], parts[i]);
      const store = await deployStore(CHUNK_ADDRS, "text/plain");

      const [statusCode, body, headers] = await store.request([], [{ key: "chunk", value: "1" }]);
      expect(statusCode).to.equal(200);
      expect(Buffer.from(ethers.getBytes(body))).to.deep.equal(parts[1]);
      expect(header(headers, "web3-next-chunk")).to.equal("/?chunk=2");
    });

    it("last chunk has no web3-next-chunk header", async function () {
      const parts = [Buffer.from("AAAA"), Buffer.from("BBBBBB"), Buffer.from("CC")];
      for (let i = 0; i < parts.length; i++) await plantChunk(CHUNK_ADDRS[i], parts[i]);
      const store = await deployStore(CHUNK_ADDRS, "text/plain");

      const [statusCode, body, headers] = await store.request([], [{ key: "chunk", value: "2" }]);
      expect(statusCode).to.equal(200);
      expect(Buffer.from(ethers.getBytes(body))).to.deep.equal(parts[2]);
      expect(headers.length).to.equal(1);
      expect(header(headers, "web3-next-chunk")).to.equal(undefined);
    });

    it("reassembles a zero-payload (STOP-only) chunk in the middle via the chain", async function () {
      // ["AB", STOP-only, "CD"] → "ABCD"; the empty middle chunk is its own page.
      await plantChunk(CHUNK_ADDRS[0], Buffer.from("AB"));
      await setCode(CHUNK_ADDRS[1], "0x00"); // STOP byte only → zero payload
      await plantChunk(CHUNK_ADDRS[2], Buffer.from("CD"));
      const store = await deployStore(CHUNK_ADDRS, "text/plain");

      const { bytes } = await fetchViaPagination(store);
      expect(bytes.toString()).to.equal("ABCD");
    });

    it("is binary-safe — a chunk body preserves non-UTF-8 bytes including embedded 0x00", async function () {
      // Non-UTF-8 with an embedded 0x00, proving the body is raw `bytes` not a mangled `string`.
      const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff, 0x01, 0x80]);
      await plantChunk(CHUNK_ADDRS[0], data);
      const store = await deployStore([CHUNK_ADDRS[0]], "image/png");

      const [statusCode, body, headers] = await store.request([], []);
      expect(statusCode).to.equal(200);
      expect(ethers.getBytes(body)).to.deep.equal(data);
      expect(header(headers, "Content-Type")).to.equal("image/png");
    });

    it("defaults an empty content type to application/octet-stream (ADR-0018) on every page", async function () {
      await plantChunk(CHUNK_ADDRS[0], Buffer.from("aa"));
      await plantChunk(CHUNK_ADDRS[1], Buffer.from("bb"));
      const store = await deployStore([CHUNK_ADDRS[0], CHUNK_ADDRS[1]], "");

      expect(await store.contentType()).to.equal("");
      const [, , h0] = await store.request([], []);
      expect(header(h0, "Content-Type")).to.equal("application/octet-stream");
      expect(header(h0, "web3-next-chunk")).to.equal("/?chunk=1");
      const [, , h1] = await store.request([], [{ key: "chunk", value: "1" }]);
      expect(header(h1, "Content-Type")).to.equal("application/octet-stream");
    });

    it("ignores the resource path — paginates on the chunk param only", async function () {
      const parts = [Buffer.from("AAAA"), Buffer.from("BBBBBB")];
      for (let i = 0; i < parts.length; i++) await plantChunk(CHUNK_ADDRS[i], parts[i]);
      const store = await deployStore([CHUNK_ADDRS[0], CHUNK_ADDRS[1]], "text/plain");

      // A path AND an unrelated param are ignored; the `chunk` param still selects chunk 1.
      const [, body] = await store.request(
        ["any", "sub", "path"],
        [
          { key: "chunk", value: "1" },
          { key: "q", value: "x" },
        ],
      );
      expect(Buffer.from(ethers.getBytes(body))).to.deep.equal(parts[1]);
    });

    it("absent/empty/garbage chunk param resolves to chunk 0", async function () {
      const parts = [Buffer.from("ZERO"), Buffer.from("ONE!")];
      for (let i = 0; i < parts.length; i++) await plantChunk(CHUNK_ADDRS[i], parts[i]);
      const store = await deployStore([CHUNK_ADDRS[0], CHUNK_ADDRS[1]], "text/plain");

      for (const params of [[], [{ key: "chunk", value: "" }], [{ key: "chunk", value: "abc" }]]) {
        const [statusCode, body] = await store.request([], params);
        expect(statusCode).to.equal(200);
        expect(Buffer.from(ethers.getBytes(body))).to.deep.equal(parts[0]);
      }
    });

    it("returns a 200 empty body for a store with no chunks", async function () {
      const store = await deployStore([], "text/plain");
      const [statusCode, body, headers] = await store.request([], []);
      expect(statusCode).to.equal(200);
      expect(ethers.getBytes(body).length).to.equal(0);
      expect(header(headers, "web3-next-chunk")).to.equal(undefined);
    });

    it("returns 404 for an explicitly out-of-bounds chunk index", async function () {
      await plantChunk(CHUNK_ADDRS[0], Buffer.from("a"));
      await plantChunk(CHUNK_ADDRS[1], Buffer.from("b"));
      const store = await deployStore([CHUNK_ADDRS[0], CHUNK_ADDRS[1]], "text/plain");

      const [statusCode, body] = await store.request([], [{ key: "chunk", value: "5" }]);
      expect(statusCode).to.equal(404);
      expect(Buffer.from(ethers.getBytes(body)).toString()).to.equal("Chunk out of bounds");
    });

    it("a client following the chain into a no-code chunk gets a clean 500 (no next-chunk loop)", async function () {
      // chunk 0 has code and advertises /?chunk=1; chunk 1 is a pristine no-code
      // address. A conformant client follows the advertised link and must hit a
      // loud 500 with NO further next-chunk header (so it stops, never loops).
      await plantChunk(CHUNK_ADDRS[0], Buffer.from("a"));
      const noCodeAddr = "0x0000000000000000000000000000000000000200";
      const store = await deployStore([CHUNK_ADDRS[0], noCodeAddr], "text/plain");

      const [s0, , h0] = await store.request([], []);
      expect(s0).to.equal(200);
      expect(header(h0, "web3-next-chunk")).to.equal("/?chunk=1"); // chain points at the bad chunk

      const [statusCode, body, headers] = await store.request([], [{ key: "chunk", value: "1" }]);
      expect(statusCode).to.equal(500);
      expect(Buffer.from(ethers.getBytes(body)).toString()).to.equal("Chunk contract has no code");
      expect(headers.length).to.equal(0); // no next-chunk header on an error → client stops
    });

    it("returns 500 for a no-code chunk 0 (default request)", async function () {
      const noCodeAddr = "0x0000000000000000000000000000000000000201";
      const store = await deployStore([noCodeAddr], "text/plain");
      const [statusCode, body] = await store.request([], []);
      expect(statusCode).to.equal(500);
      expect(Buffer.from(ethers.getBytes(body)).toString()).to.equal("Chunk contract has no code");
    });
  });

  describe("cross-path equivalence", function () {
    it("the bytes the router reassembles (per-chunk extcodecopy) equal request()'s paginated reassembly", async function () {
      const parts = [Buffer.from("router-"), Buffer.from("vs-"), Buffer.from("request")];
      for (let i = 0; i < parts.length; i++) await plantChunk(CHUNK_ADDRS[i], parts[i]);
      const store = await deployStore(CHUNK_ADDRS, "text/plain");

      // Router side: read each chunk's address, getCode, drop the leading STOP byte, concat.
      const routerSide: Buffer[] = [];
      const count = Number(await store.chunkCount());
      for (let i = 0; i < count; i++) {
        const addr = await store.chunkAddress(i);
        const code = await ethers.provider.getCode(addr);
        routerSide.push(Buffer.from(ethers.getBytes(code)).subarray(1)); // drop STOP byte
      }

      // Standard side: follow the web3-next-chunk pagination chain.
      const { bytes } = await fetchViaPagination(store);
      expect(Buffer.concat(routerSide)).to.deep.equal(bytes);
    });
  });
});
