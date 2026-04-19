/**
 * EFS Seed — CLI wrapper for `yarn hardhat:seed`.
 *
 * The real logic lives in `./seed-impl.ts` (exported as `seedDemoTree`) so
 * it can be imported with no side effects from the deploy step
 * (`deploy/08_seed_demo_tree.ts`) without double-running when this file is
 * invoked via `hardhat run`. This file just invokes the function and maps
 * failures to a non-zero exit code so CI notices.
 *
 * Run: npx hardhat run scripts/seed.ts --network localhost
 *      (or: yarn hardhat:seed)
 *
 * Fresh deploys auto-seed — `deploy/08_seed_demo_tree.ts` runs `seedDemoTree`
 * as part of `hardhat deploy`. Run this script manually only to re-seed
 * after a chain wipe without a full redeploy.
 */

import { seedDemoTree } from "./seed-impl";

seedDemoTree().catch(err => {
  console.error(err);
  process.exit(1);
});
