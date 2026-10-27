/**
 * Sepolia readback — does live Sepolia run the code on this checkout? READ-ONLY.
 *
 * Compares what is actually deployed on Sepolia (chainId 11155111) against the contracts compiled from
 * this checkout, so drift between `main` and the live chain shows up before anyone writes docs, ships a
 * client, or signs an upgrade. It sends no transactions and needs no key.
 *
 * Checks:
 *   1. Each Safe-owned proxy in deployments/sepolia: the EIP-1967 implementation's runtime code vs the
 *      compiled `deployedBytecode`, and the proxy's ProxyAdmin owner (expected: the EFS.eth Safe).
 *   2. Each stateless view (EFSFileView, EFSRouter, ListReader): runtime code vs compiled.
 *   3. Every schema in deploy-lib/schemas.ts: registered in the SchemaRegistry at the UID derived from
 *      the realized proxy addresses (WHITEOUT: from its Safe-keyed CREATE3 prediction).
 *   4. Feature probes for changes merged after the 2026-06-19 freeze (ADR-0055/0066/0068).
 *
 * Code comparison masks constructor immutables (from the compiler's immutableReferences) and reports:
 *   MATCH       — identical, including the solc metadata hash (built from this exact source)
 *   SAME-LOGIC  — identical once the metadata hash is stripped (only comments/formatting differ)
 *   DIFFERS     — the live code is not this checkout's code
 *
 * Run: yarn readback:sepolia   (RPC: SEPOLIA_RPC_URL, else a public endpoint). Needs no key.
 * Run it before any Sepolia upgrade or redeploy, and after one to confirm it landed.
 * Exit: 0 when Sepolia matches this checkout, 1 when anything differs or a check could not run.
 */

import * as fs from "fs";
import * as path from "path";
import { artifacts, run } from "hardhat";
import { Contract, JsonRpcProvider, getAddress, getBytes, keccak256, solidityPacked, zeroPadValue } from "ethers";
import { CREATEX_ADDRESS, EXPECTED_EFS_SAFE, SCHEMA_REGISTRY_ADDRESS } from "../deploy-lib/addresses";
import { RESOLVER_SALT_ENTROPY } from "../deploy-lib/create3";
import { ResolverName, SCHEMAS, computeSchemaUID } from "../deploy-lib/schemas";

const RPC_URL = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const SEPOLIA_CHAIN_ID = 11155111n;
const DEPLOYMENTS_DIR = path.join(__dirname, "../deployments/sepolia");

const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

// deployments/sepolia record name → compiled contract name.
const PROXIES: Record<string, string> = {
  Indexer: "EFSIndexer",
  EdgeResolver: "EdgeResolver",
  MirrorResolver: "MirrorResolver",
  ListResolver: "ListResolver",
  ListEntryResolver: "ListEntryResolver",
  AliasResolver: "AliasResolver",
  SystemAccount: "SystemAccount",
};
const VIEWS = ["EFSFileView", "EFSRouter", "ListReader"];

type Verdict = "MATCH" | "SAME-LOGIC" | "DIFFERS";
const problems: string[] = [];

function recordAddress(name: string): string {
  const file = path.join(DEPLOYMENTS_DIR, `${name}.json`);
  return getAddress(JSON.parse(fs.readFileSync(file, "utf8")).address);
}

/** Compiled runtime bytecode plus the byte ranges holding constructor immutables. */
async function compiled(contractName: string): Promise<{ code: Uint8Array; immutables: [number, number][] }> {
  const artifact = await artifacts.readArtifact(contractName);
  const fqn = `${artifact.sourceName}:${artifact.contractName}`;
  const buildInfo = await artifacts.getBuildInfo(fqn);
  if (!buildInfo) throw new Error(`no build info for ${fqn} — run hardhat compile`);
  const out = buildInfo.output.contracts[artifact.sourceName][artifact.contractName] as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const refs: Record<string, { start: number; length: number }[]> = out.evm.deployedBytecode.immutableReferences ?? {};
  const immutables = Object.values(refs)
    .flat()
    .map(r => [r.start, r.length] as [number, number]);
  return { code: getBytes(artifact.deployedBytecode), immutables };
}

function masked(code: Uint8Array, immutables: [number, number][]): Uint8Array {
  const out = Uint8Array.from(code);
  for (const [start, length] of immutables) out.fill(0, start, start + length);
  return out;
}

/** Drop the trailing CBOR metadata (its length is the final two bytes). */
function withoutMetadata(code: Uint8Array): Uint8Array {
  if (code.length < 2) return code;
  const cborLen = (code[code.length - 2] << 8) | code[code.length - 1];
  return cborLen + 2 <= code.length ? code.slice(0, code.length - cborLen - 2) : code;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

async function compareCode(provider: JsonRpcProvider, address: string, contractName: string): Promise<Verdict> {
  const live = getBytes(await provider.getCode(address));
  if (live.length === 0) return "DIFFERS";
  const { code, immutables } = await compiled(contractName);
  const a = masked(live, immutables);
  const b = masked(code, immutables);
  if (sameBytes(a, b)) return "MATCH";
  if (sameBytes(withoutMetadata(a), withoutMetadata(b))) return "SAME-LOGIC";
  return "DIFFERS";
}

async function readSlotAddress(provider: JsonRpcProvider, at: string, slot: string): Promise<string> {
  return getAddress("0x" + (await provider.getStorage(at, slot)).slice(-40));
}

/** Optional view call; `undefined` when the function does not exist on the live contract. */
async function tryCall<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

function line(cols: string[]) {
  console.log("  " + cols[0].padEnd(22) + cols[1].padEnd(12) + (cols[2] ?? ""));
}

async function main() {
  const provider = new JsonRpcProvider(RPC_URL);
  const { chainId } = await provider.getNetwork();
  if (chainId !== SEPOLIA_CHAIN_ID) throw new Error(`RPC is chain ${chainId}, not Sepolia`);
  const block = await provider.getBlockNumber();
  await run("compile", { quiet: true });

  console.log(`Sepolia readback at block ${block} vs this checkout (${RPC_URL.replace(/\/v2\/.*/, "/v2/…")})\n`);

  // 1. Proxies
  console.log("Proxied contracts (implementation code · ProxyAdmin owner)");
  const proxies: Partial<Record<ResolverName, string>> = {};
  // Implementation code vs this checkout, and ProxyAdmin owner vs the EFS.eth Safe, for one proxy.
  const checkProxy = async (contractName: string, proxy: string) => {
    const impl = await readSlotAddress(provider, proxy, EIP1967_IMPL_SLOT);
    const verdict = await compareCode(provider, impl, contractName);
    const admin = await readSlotAddress(provider, proxy, EIP1967_ADMIN_SLOT);
    const owner = await tryCall(
      () => new Contract(admin, ["function owner() view returns (address)"], provider).owner() as Promise<string>,
    );
    const ownerNote =
      owner === undefined
        ? "owner unreadable"
        : getAddress(owner) === EXPECTED_EFS_SAFE
          ? "owner = EFS.eth Safe"
          : `owner = ${owner}`;
    line([contractName, verdict, `impl ${impl} · ${ownerNote}`]);
    if (verdict === "DIFFERS") problems.push(`${contractName}: live implementation differs from this checkout`);
    if (owner === undefined || getAddress(owner) !== EXPECTED_EFS_SAFE)
      problems.push(`${contractName}: ProxyAdmin owner is not the EFS.eth Safe (${owner ?? "unreadable"})`);
  };
  for (const [record, contractName] of Object.entries(PROXIES)) {
    const proxy = recordAddress(record);
    if (contractName !== "SystemAccount") proxies[contractName as ResolverName] = proxy;
    await checkProxy(contractName, proxy);
  }

  // WhiteoutResolver has no deployment record; derive its Safe-keyed CREATE3 address the way the deploy would.
  const rawSalt = solidityPacked(
    ["address", "bytes1", "bytes11"],
    [EXPECTED_EFS_SAFE, "0x00", RESOLVER_SALT_ENTROPY.WhiteoutResolver],
  );
  const guarded = keccak256(solidityPacked(["bytes32", "bytes32"], [zeroPadValue(EXPECTED_EFS_SAFE, 32), rawSalt]));
  const createx = new Contract(
    CREATEX_ADDRESS,
    ["function computeCreate3Address(bytes32) view returns (address)"],
    provider,
  );
  const whiteout = getAddress(await createx.computeCreate3Address(guarded));
  const whiteoutLive = (await provider.getCode(whiteout)) !== "0x";
  proxies.WhiteoutResolver = whiteout;
  if (whiteoutLive) {
    await checkProxy("WhiteoutResolver", whiteout);
  } else {
    line(["WhiteoutResolver", "ABSENT", `predicted proxy ${whiteout}`]);
    problems.push("WhiteoutResolver: not deployed (ADR-0055)");
  }

  // 2. Views
  console.log("\nStateless views (runtime code)");
  const views: Record<string, string> = {};
  for (const name of VIEWS) {
    views[name] = recordAddress(name);
    const verdict = await compareCode(provider, views[name], name);
    line([name, verdict, views[name]]);
    if (verdict === "DIFFERS") problems.push(`${name}: live view differs from this checkout (redeploy to ship main)`);
  }

  // 3. Schemas
  console.log("\nSchemas (SchemaRegistry)");
  const registry = new Contract(
    SCHEMA_REGISTRY_ADDRESS,
    ["function getSchema(bytes32) view returns ((bytes32 uid, address resolver, bool revocable, string schema))"],
    provider,
  );
  for (const s of SCHEMAS) {
    const uid = computeSchemaUID(s.fieldString, proxies[s.resolver]!, s.revocable);
    const rec = await registry.getSchema(uid);
    const registered = rec.uid === uid;
    line([s.name, registered ? "REGISTERED" : "MISSING", uid]);
    if (!registered) problems.push(`${s.name}: schema not registered at ${uid}`);
  }

  // 4. Feature probes for post-freeze changes
  console.log("\nPost-freeze features");
  const indexer = new Contract(proxies.EFSIndexer!, ["function MAX_ANCHOR_DEPTH() view returns (uint256)"], provider);
  // The constant this checkout compiles in, read from source (a constant has no storage to query).
  const indexerSrc = fs.readFileSync(path.join(__dirname, "../contracts/EFSIndexer.sol"), "utf8");
  const expectedDepth = BigInt(/MAX_ANCHOR_DEPTH\s*=\s*(\d+)/.exec(indexerSrc)![1]);
  const liveDepth = await tryCall(() => indexer.MAX_ANCHOR_DEPTH() as Promise<bigint>);
  const depthOk = liveDepth !== undefined && liveDepth === expectedDepth;
  line([
    "MAX_ANCHOR_DEPTH",
    depthOk ? "MATCH" : "DIFFERS",
    `live ${liveDepth ?? "?"} · this checkout ${expectedDepth} (ADR-0068)`,
  ]);
  if (!depthOk) problems.push(`EFSIndexer.MAX_ANCHOR_DEPTH: live ${liveDepth}, this checkout ${expectedDepth}`);

  for (const name of ["EFSRouter", "EFSFileView"]) {
    const wired = await tryCall(
      () =>
        new Contract(
          views[name],
          ["function whiteoutResolver() view returns (address)"],
          provider,
        ).whiteoutResolver() as Promise<string>,
    );
    const note =
      wired === undefined
        ? "no whiteoutResolver() — predates WHITEOUT wiring (ADR-0055)"
        : getAddress(wired) === whiteout
          ? "wired to the predicted WhiteoutResolver"
          : `points at ${wired}`;
    const correct = wired !== undefined && whiteoutLive && getAddress(wired) === whiteout;
    line([`${name} whiteout`, wired === undefined ? "ABSENT" : correct ? "WIRED" : "WRONG", note]);
    // Code comparison can't see this: the router keeps the address in storage and the file view's
    // immutable is masked, so a view can MATCH while suppression is off or pointed elsewhere.
    if (!correct) problems.push(`${name}: not wired to the live WhiteoutResolver (${note})`);
  }

  console.log("");
  if (problems.length === 0) {
    console.log("✓ Sepolia matches this checkout.");
    return;
  }
  console.log(`${problems.length} difference(s) between Sepolia and this checkout:`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  process.exitCode = 1;
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
