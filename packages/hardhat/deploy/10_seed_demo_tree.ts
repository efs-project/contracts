import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { seedDemoTree } from "../scripts/seed-impl";

/**
 * Run the `/docs`, `/images`, `/shared`, `/tags/system` demo seed as a
 * hardhat-deploy step so
 * **any** path into deploy auto-seeds — not just the root-level `yarn deploy`
 * that happens to chain `&& yarn hardhat:seed` after workspace deploy.
 *
 * Why this exists: the devnet VPS's operator script calls
 * `yarn workspace @se-2/hardhat deploy --network localhost` directly,
 * bypassing the root chain, which meant post-deploy the Explorer always
 * showed "Topic is empty". The assumption in 4a45b0d — "no infra-script
 * change needed on the devnet side, they keep calling yarn deploy" — turned
 * out to be wrong. Putting seed *inside* the deploy flow makes it impossible
 * to skip by accident, at the cost of a small coupling: the deploy can't
 * finish until seed finishes. Seed is idempotent + fail-soft so the cost on
 * re-runs is ~3 read calls (one `resolveAnchor` per top-level subtree).
 *
 * Localhost/hardhat only. On mainnet / real Sepolia we never want to seed
 * demo data into production — the gate matches the one in 07_persona_names.
 */
const seedDemoTreeStep: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  if (hre.network.name !== "localhost" && hre.network.name !== "hardhat") {
    console.log(`Skipping demo tree seed on network "${hre.network.name}" (localhost/hardhat only).`);
    return;
  }
  await seedDemoTree();
};

export default seedDemoTreeStep;
seedDemoTreeStep.tags = ["SeedDemoTree"];
// Must run LAST — after EVERY contract-deploying step. The seed's transactions
// consume deployer nonces, so running before any contract deploy would shift that
// contract's CREATE address; addresses must be deterministic for the committed pin
// independent of demo-data content (ADR-0037). Enumerate ALL contract-deploying
// tags explicitly — the previous list omitted EFSFileView/EFSRouter/SortFunctions
// (nothing else depends on them, so they weren't pulled in transitively), which
// let a `--tags SeedDemoTree` run seed before they deployed (Codex P2). Full-deploy
// order (filename 01→10) is unchanged, so the pin is unaffected.
seedDemoTreeStep.dependencies = [
  "Indexer",
  "EFSFileView",
  "EFSRouter",
  "SortOverlay",
  "Mirrors",
  "SortFunctions",
  "SchemaAliases",
  "PersonaNames",
  "Lists",
];
