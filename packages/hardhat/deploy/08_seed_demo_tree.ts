import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { seedDemoTree } from "../scripts/seed-impl";

/**
 * Run the `/docs`, `/images`, `/shared` demo seed as a hardhat-deploy step so
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
// Must run after the root anchor, transports, schema aliases, and persona
// names are all in place — the seed emits anchors + TAGs under /transports
// and uses the persona names for lens demos.
seedDemoTreeStep.dependencies = ["Indexer", "Mirrors", "SchemaAliases", "PersonaNames"];
