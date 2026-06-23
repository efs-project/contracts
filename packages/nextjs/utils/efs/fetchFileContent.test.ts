import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

type ResolveHookContext = { parentURL?: string };
type ResolveHookResult = { url: string; shortCircuit?: boolean };
type NextResolve = (specifier: string, context: ResolveHookContext) => ResolveHookResult;
type ModuleWithRegisterHooks = {
  registerHooks(hooks: {
    resolve: (specifier: string, context: ResolveHookContext, nextResolve: NextResolve) => ResolveHookResult;
  }): void;
};

const { registerHooks } = (await import("node:module")) as unknown as ModuleWithRegisterHooks;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("~~/")) {
      return { url: new URL(`../../${specifier.slice(3)}.ts`, import.meta.url).href, shortCircuit: true };
    }
    try {
      return nextResolve(specifier, context);
    } catch (e) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
        return { url: new URL(`${specifier}.ts`, context.parentURL).href, shortCircuit: true };
      }
      throw e;
    }
  },
});

const fetchFileContentModule = await import("./fetchFileContent.ts");
const { fetchFileContent } = fetchFileContentModule;
const clearFetchFileContentCache =
  "clearFetchFileContentCache" in fetchFileContentModule
    ? (fetchFileContentModule.clearFetchFileContentCache as () => void)
    : () => {};

beforeEach(() => {
  clearFetchFileContentCache();
});

test("fetchFileContent treats inline data mirrors as editable on-chain content", async () => {
  const body = "Hello Overview";
  const dataUri = `data:text/markdown;base64,${Buffer.from(body, "utf8").toString("base64")}`;
  const publicClient = {
    readContract: async () => [
      200n,
      "0x",
      [
        {
          key: "Content-Type",
          value: `message/external-body; access-type=URL; URL="${dataUri}"; content-type="text/markdown"`,
        },
      ],
    ],
  };

  const fetched = await fetchFileContent({
    routerAddress: `0x${"1".repeat(40)}`,
    routerAbi: [],
    publicClient: publicClient as any,
    lensAddresses: [`0x${"a".repeat(40)}`],
    resourcePath: ["README.md"],
  });

  assert.equal(new TextDecoder().decode(fetched.bytes), body);
  assert.equal(fetched.contentType, "text/markdown");
  assert.equal(fetched.transport, "data");
  assert.equal(fetched.source, "onchain");
});

test("fetchFileContent keeps external-body IPFS mirrors non-editable", async () => {
  const body = "Pinned elsewhere";
  const ipfsUri = "ipfs://bafybeigdyrzt/example";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
    assert.equal(String(url), "https://dweb.link/ipfs/bafybeigdyrzt/example");
    return {
      ok: true,
      headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/plain" : null) },
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    };
  }) as any;

  try {
    const publicClient = {
      readContract: async () => [
        200n,
        "0x",
        [
          {
            key: "Content-Type",
            value: `message/external-body; access-type=URL; URL="${ipfsUri}"; content-type="text/markdown"`,
          },
        ],
      ],
    };

    const fetched = await fetchFileContent({
      routerAddress: `0x${"1".repeat(40)}`,
      routerAbi: [],
      publicClient: publicClient as any,
      lensAddresses: [`0x${"a".repeat(40)}`],
      resourcePath: ["README.md"],
    });

    assert.equal(new TextDecoder().decode(fetched.bytes), body);
    assert.equal(fetched.contentType, "text/markdown");
    assert.equal(fetched.transport, "ipfs");
    assert.equal(fetched.source, "mirror");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchFileContent caches repeat mirror reads by route identity", async () => {
  const body = "cached pinned bytes";
  const ipfsUri = "ipfs://bafycache/example.png";
  let fetchCount = 0;
  let readCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
    fetchCount += 1;
    assert.equal(String(url), "https://dweb.link/ipfs/bafycache/example.png");
    return {
      ok: true,
      headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "image/png" : null) },
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    };
  }) as any;

  try {
    const publicClient = {
      chain: { id: 31337 },
      readContract: async () => {
        readCount += 1;
        return [
          200n,
          "0x",
          [
            {
              key: "Content-Type",
              value: `message/external-body; access-type=URL; URL="${ipfsUri}"; content-type="image/png"`,
            },
          ],
        ];
      },
    };
    const args = {
      routerAddress: `0x${"1".repeat(40)}` as `0x${string}`,
      routerAbi: [],
      publicClient: publicClient as any,
      lensAddresses: [`0x${"a".repeat(40)}`],
      resourcePath: ["images", "photo.png"],
    };

    const first = await fetchFileContent(args);
    first.bytes[0] = 0;
    const second = await fetchFileContent(args);

    assert.equal(readCount, 1);
    assert.equal(fetchCount, 1);
    assert.equal(new TextDecoder().decode(second.bytes), body);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchFileContent caches repeat on-chain body reads by route identity", async () => {
  const body = "cached on-chain bytes";
  let readCount = 0;
  const publicClient = {
    chain: { id: 31337 },
    readContract: async () => {
      readCount += 1;
      return [
        200n,
        `0x${Buffer.from(body, "utf8").toString("hex")}`,
        [{ key: "Content-Type", value: "text/plain" }],
      ];
    },
  };
  const args = {
    routerAddress: `0x${"1".repeat(40)}` as `0x${string}`,
    routerAbi: [],
    publicClient: publicClient as any,
    lensAddresses: [`0x${"a".repeat(40)}`],
    resourcePath: ["docs", "onchain.txt"],
  };

  const first = await fetchFileContent(args);
  const second = await fetchFileContent(args);

  assert.equal(new TextDecoder().decode(first.bytes), body);
  assert.equal(new TextDecoder().decode(second.bytes), body);
  assert.equal(readCount, 1);
});

test("fetchFileContent uses explicit chainId when the public client has no chain metadata", async () => {
  const ipfsUri = "ipfs://bafychain/example.png";
  let fetchCount = 0;
  let readCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
    fetchCount += 1;
    assert.equal(String(url), "https://dweb.link/ipfs/bafychain/example.png");
    const body = fetchCount === 1 ? "chain one" : "chain two";
    return {
      ok: true,
      headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "image/png" : null) },
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    };
  }) as any;

  try {
    const publicClient = {
      readContract: async () => {
        readCount += 1;
        return [
          200n,
          "0x",
          [
            {
              key: "Content-Type",
              value: `message/external-body; access-type=URL; URL="${ipfsUri}"; content-type="image/png"`,
            },
          ],
        ];
      },
    };
    const baseArgs = {
      routerAddress: `0x${"1".repeat(40)}` as `0x${string}`,
      routerAbi: [],
      publicClient: publicClient as any,
      lensAddresses: [`0x${"a".repeat(40)}`],
      resourcePath: ["images", "photo.png"],
    };

    const first = await fetchFileContent({ ...baseArgs, chainId: 1 });
    const second = await fetchFileContent({ ...baseArgs, chainId: 2 });

    assert.equal(new TextDecoder().decode(first.bytes), "chain one");
    assert.equal(new TextDecoder().decode(second.bytes), "chain two");
    assert.equal(readCount, 2);
    assert.equal(fetchCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchFileContent does not cache when chain identity is unavailable", async () => {
  const ipfsUri = "ipfs://bafynochain/example.png";
  let fetchCount = 0;
  let readCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
    fetchCount += 1;
    assert.equal(String(url), "https://dweb.link/ipfs/bafynochain/example.png");
    const body = fetchCount === 1 ? "first no-chain body" : "second no-chain body";
    return {
      ok: true,
      headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "image/png" : null) },
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    };
  }) as any;

  try {
    const publicClient = {
      readContract: async () => {
        readCount += 1;
        return [
          200n,
          "0x",
          [
            {
              key: "Content-Type",
              value: `message/external-body; access-type=URL; URL="${ipfsUri}"; content-type="image/png"`,
            },
          ],
        ];
      },
    };
    const args = {
      routerAddress: `0x${"1".repeat(40)}` as `0x${string}`,
      routerAbi: [],
      publicClient: publicClient as any,
      lensAddresses: [`0x${"a".repeat(40)}`],
      resourcePath: ["images", "photo.png"],
    };

    const first = await fetchFileContent(args);
    const second = await fetchFileContent(args);

    assert.equal(new TextDecoder().decode(first.bytes), "first no-chain body");
    assert.equal(new TextDecoder().decode(second.bytes), "second no-chain body");
    assert.equal(readCount, 2);
    assert.equal(fetchCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("clearFetchFileContentCache makes a cached route refetch after a write boundary", async () => {
  let readCount = 0;
  const publicClient = {
    chain: { id: 31337 },
    readContract: async () => {
      readCount += 1;
      const body = readCount === 1 ? "before write" : "after write";
      return [
        200n,
        `0x${Buffer.from(body, "utf8").toString("hex")}`,
        [{ key: "Content-Type", value: "text/plain" }],
      ];
    },
  };
  const args = {
    routerAddress: `0x${"1".repeat(40)}` as `0x${string}`,
    routerAbi: [],
    publicClient: publicClient as any,
    lensAddresses: [`0x${"a".repeat(40)}`],
    resourcePath: ["docs", "edited.txt"],
  };

  const first = await fetchFileContent(args);
  clearFetchFileContentCache();
  const second = await fetchFileContent(args);

  assert.equal(new TextDecoder().decode(first.bytes), "before write");
  assert.equal(new TextDecoder().decode(second.bytes), "after write");
  assert.equal(readCount, 2);
});

test("fetchFileContent expires browser-memory cache entries", async () => {
  let readCount = 0;
  const originalDateNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  const publicClient = {
    chain: { id: 31337 },
    readContract: async () => {
      readCount += 1;
      const body = readCount === 1 ? "fresh cache body" : "expired cache body";
      return [
        200n,
        `0x${Buffer.from(body, "utf8").toString("hex")}`,
        [{ key: "Content-Type", value: "text/plain" }],
      ];
    },
  };
  const args = {
    routerAddress: `0x${"1".repeat(40)}` as `0x${string}`,
    routerAbi: [],
    publicClient: publicClient as any,
    lensAddresses: [`0x${"a".repeat(40)}`],
    resourcePath: ["docs", "ttl.txt"],
  };

  try {
    const first = await fetchFileContent(args);
    now += 60_001;
    const second = await fetchFileContent(args);

    assert.equal(new TextDecoder().decode(first.bytes), "fresh cache body");
    assert.equal(new TextDecoder().decode(second.bytes), "expired cache body");
    assert.equal(readCount, 2);
  } finally {
    Date.now = originalDateNow;
  }
});

test("fetchFileContent still applies maxBytes to cached content", async () => {
  const body = "large enough";
  const dataUri = `data:text/plain;base64,${Buffer.from(body, "utf8").toString("base64")}`;
  let readCount = 0;
  const publicClient = {
    chain: { id: 31337 },
    readContract: async () => {
      readCount += 1;
      return [
        200n,
        "0x",
        [
          {
            key: "Content-Type",
            value: `message/external-body; access-type=URL; URL="${dataUri}"; content-type="text/plain"`,
          },
        ],
      ];
    },
  };
  const args = {
    routerAddress: `0x${"1".repeat(40)}` as `0x${string}`,
    routerAbi: [],
    publicClient: publicClient as any,
    lensAddresses: [`0x${"a".repeat(40)}`],
    resourcePath: ["docs", "large.txt"],
  };

  await fetchFileContent(args);

  await assert.rejects(() => fetchFileContent({ ...args, maxBytes: 4 }), {
    name: "FileTooLargeError",
  });
  assert.equal(readCount, 1);
});

test("clearFetchFileContentCache prevents in-flight reads from repopulating stale cache", async () => {
  const ipfsUri = "ipfs://bafyrace/photo.png";
  let fetchCount = 0;
  let readCount = 0;
  let releaseFirstFetch: () => void = () => {};
  const originalFetch = globalThis.fetch;
  const firstFetchStarted = new Promise<void>(resolve => {
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
      fetchCount += 1;
      assert.equal(String(url), "https://dweb.link/ipfs/bafyrace/photo.png");
      if (fetchCount === 1) {
        resolve();
        await new Promise<void>(release => {
          releaseFirstFetch = release;
        });
      }
      const body = fetchCount === 1 ? "old bytes" : "new bytes";
      return {
        ok: true,
        headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "image/png" : null) },
        arrayBuffer: async () => new TextEncoder().encode(body).buffer,
      };
    }) as any;
  });

  const publicClient = {
    chain: { id: 31337 },
    readContract: async () => {
      readCount += 1;
      return [
        200n,
        "0x",
        [
          {
            key: "Content-Type",
            value: `message/external-body; access-type=URL; URL="${ipfsUri}"; content-type="image/png"`,
          },
        ],
      ];
    },
  };
  const args = {
    routerAddress: `0x${"1".repeat(40)}` as `0x${string}`,
    routerAbi: [],
    publicClient: publicClient as any,
    lensAddresses: [`0x${"a".repeat(40)}`],
    resourcePath: ["images", "race.png"],
  };

  try {
    const first = fetchFileContent(args);
    await firstFetchStarted;
    clearFetchFileContentCache();
    releaseFirstFetch();
    assert.equal(new TextDecoder().decode((await first).bytes), "old bytes");

    const second = await fetchFileContent(args);

    assert.equal(new TextDecoder().decode(second.bytes), "new bytes");
    assert.equal(readCount, 2);
    assert.equal(fetchCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
