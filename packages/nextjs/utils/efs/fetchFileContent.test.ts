import assert from "node:assert/strict";
import { test } from "node:test";

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

const { fetchFileContent } = await import("./fetchFileContent.ts");

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
