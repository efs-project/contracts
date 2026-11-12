/**
 * Static drift check for the Sepolia (chainId 11155111) address records.
 *
 * Sepolia addresses live in three places that must agree:
 *   1. packages/hardhat/deployments/sepolia/*.json   — hardhat-deploy records (`address`)
 *   2. packages/nextjs/contracts/deployedContracts.ts — the `11155111` block the apps consume
 *   3. docs/CHAINS.md                                — the human registry ("## Sepolia — chainId 11155111")
 *
 * For every deployment JSON, the same address (case-insensitive) must appear for that contract in (2)
 * and (3). Contracts present in (2) or in a CHAINS.md `| Contract | Address |` table with no deployment
 * JSON are flagged too. Exits 1 on any mismatch. No RPC, no compile — runs on the committed files only.
 * Guards against efs-project/contracts#43 (deployedContracts.ts kept stale view addresses for months).
 *
 * Usage: yarn check:deployments
 *   Optional overrides (for testing against scratch copies):
 *     --deployments <dir> --deployed-contracts <file> --chains <file>
 */

import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";

const CHAIN_ID = "11155111";
const CHAINS_SECTION_HEADING = /^##\s+Sepolia\s+—\s+chainId\s+11155111\s*$/;

// CHAINS.md uses human names; map the ones that differ from the artifact name after the trailing
// parenthetical is stripped ("EdgeResolver (PIN/TAG)" → "EdgeResolver" needs no entry).
const CHAINS_NAME_ALIASES: Record<string, string> = {
  EFSIndexer: "Indexer",
};

const REPO_ROOT = path.resolve(__dirname, "../../..");

function argValue(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  if (!v) throw new Error(`${flag} requires a value`);
  return path.resolve(v);
}

const DEPLOYMENTS_DIR = argValue("--deployments", path.join(REPO_ROOT, "packages/hardhat/deployments/sepolia"));
const DEPLOYED_CONTRACTS = argValue(
  "--deployed-contracts",
  path.join(REPO_ROOT, "packages/nextjs/contracts/deployedContracts.ts"),
);
const CHAINS_MD = argValue("--chains", path.join(REPO_ROOT, "docs/CHAINS.md"));

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const errors: string[] = [];

function rel(p: string): string {
  return path.relative(REPO_ROOT, p) || p;
}

/** contract name → address from deployments/sepolia/*.json. */
function readDeploymentJsons(): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of fs.readdirSync(DEPLOYMENTS_DIR).sort()) {
    if (!file.endsWith(".json")) continue;
    const name = file.slice(0, -".json".length);
    const { address } = JSON.parse(fs.readFileSync(path.join(DEPLOYMENTS_DIR, file), "utf8"));
    if (typeof address !== "string" || !ADDRESS_RE.test(address)) {
      errors.push(`${name}: ${rel(DEPLOYMENTS_DIR)}/${file} has no valid \`address\` (got ${JSON.stringify(address)})`);
      continue;
    }
    out.set(name, address);
  }
  return out;
}

/**
 * contract name → address from the 11155111 block of deployedContracts.ts. Same extraction as
 * generateTsAbis.ts `getExistingChains` (object literal between `const deployedContracts =` and
 * `as const`), evaluated in an empty vm context; the file is this repo's own generated source.
 */
function readDeployedContracts(): Map<string, string> {
  const src = fs.readFileSync(DEPLOYED_CONTRACTS, "utf8");
  const match = src.match(/const\s+deployedContracts\s*=\s*(\{[\s\S]*\})\s*as const/);
  if (!match) throw new Error(`could not locate the deployedContracts object in ${rel(DEPLOYED_CONTRACTS)}`);
  const all = vm.runInNewContext(`(${match[1]})`, {}) as Record<string, Record<string, { address?: string }>>;
  const block = all[CHAIN_ID];
  if (!block) throw new Error(`${rel(DEPLOYED_CONTRACTS)} has no ${CHAIN_ID} block`);
  const out = new Map<string, string>();
  for (const [name, entry] of Object.entries(block)) out.set(name, String(entry?.address));
  return out;
}

/**
 * contract name → address from CHAINS.md. Scope: from the "## Sepolia — chainId 11155111" heading to
 * the next "## " heading. Only markdown tables whose header's first cell is "Contract" are read (so the
 * "Role" governance table and "Schema" UID table are skipped). Each row is `| Name | `0x…` |`; the
 * trailing "(…)" is stripped from Name and CHAINS_NAME_ALIASES applied.
 */
function readChainsMd(): Map<string, string> {
  const lines = fs.readFileSync(CHAINS_MD, "utf8").split("\n");
  const start = lines.findIndex(l => CHAINS_SECTION_HEADING.test(l));
  if (start === -1) throw new Error(`${rel(CHAINS_MD)} has no "## Sepolia — chainId ${CHAIN_ID}" section`);
  const out = new Map<string, string>();
  let inContractTable = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^##\s/.test(line)) break;
    if (!line.startsWith("|")) {
      inContractTable = false;
      continue;
    }
    const cells = line
      .split("|")
      .slice(1, -1)
      .map(c => c.trim());
    if (cells.every(c => /^:?-+:?$/.test(c))) continue; // |---|---| separator
    if (!inContractTable && cells[0] === "Contract") {
      inContractTable = true;
      continue;
    }
    if (!inContractTable) continue;
    const rawName = cells[0];
    const addr = (cells[1] ?? "").replace(/`/g, "").trim();
    const base = rawName.replace(/\s*\(.*\)\s*$/, "").trim();
    const name = CHAINS_NAME_ALIASES[base] ?? base;
    if (!ADDRESS_RE.test(addr)) {
      errors.push(`${name}: ${rel(CHAINS_MD)} row "${rawName}" has no valid address (got ${JSON.stringify(cells[1])})`);
      continue;
    }
    if (out.has(name)) errors.push(`${name}: listed more than once in ${rel(CHAINS_MD)} Sepolia section`);
    out.set(name, addr);
  }
  return out;
}

function main() {
  const deployments = readDeploymentJsons();
  const deployed = readDeployedContracts();
  const chains = readChainsMd();
  const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  const show = (v?: string) => v ?? "(missing)";

  for (const [name, addr] of deployments) {
    const d = deployed.get(name);
    const c = chains.get(name);
    if (same(addr, d) && same(addr, c)) continue;
    const rows: [string, string, boolean][] = [
      [`deployments/sepolia/${name}.json`, addr, true],
      [`deployedContracts.ts ${CHAIN_ID}`, show(d), same(addr, d)],
      ["docs/CHAINS.md (Sepolia)", show(c), same(addr, c)],
    ];
    const width = Math.max(...rows.map(([label]) => label.length));
    errors.push(
      [
        `${name}: address mismatch`,
        ...rows.map(([label, v, ok]) => `    ${label.padEnd(width)} : ${v}${ok ? "" : "   <-- differs"}`),
      ].join("\n"),
    );
  }
  for (const [name, addr] of deployed) {
    if (!deployments.has(name)) {
      errors.push(`${name}: in deployedContracts.ts ${CHAIN_ID} (${addr}) but has no deployments/sepolia/${name}.json`);
    }
  }
  for (const [name, addr] of chains) {
    if (!deployments.has(name)) {
      errors.push(
        `${name}: in docs/CHAINS.md Sepolia contract table (${addr}) but has no deployments/sepolia/${name}.json` +
          ` (if the CHAINS.md name differs from the artifact name, add it to CHAINS_NAME_ALIASES)`,
      );
    }
  }

  if (errors.length > 0) {
    console.error(`Sepolia (${CHAIN_ID}) deployment records are out of sync:\n`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    console.error(
      `\n${errors.length} problem(s). deployments/sepolia/*.json, deployedContracts.ts (${CHAIN_ID} block) and` +
        ` docs/CHAINS.md must agree — update all three in the same commit.`,
    );
    process.exit(1);
  }
  console.log(
    `✓ Sepolia (${CHAIN_ID}) records agree for ${deployments.size} contracts across deployments/sepolia,` +
      ` deployedContracts.ts and docs/CHAINS.md.`,
  );
}

try {
  main();
} catch (e) {
  console.error(`check:deployments failed: ${(e as Error).message}`);
  process.exit(1);
}
