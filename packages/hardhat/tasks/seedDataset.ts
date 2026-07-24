import { task } from "hardhat/config";
import { seedDataset } from "../scripts/seed-dataset";

task("seed:dataset", "Pin a dataset to IPFS and seed EFS DATA/MIRROR/PIN/TAG attestations")
  .addParam("manifest", "Path to the dataset manifest JSON")
  .addFlag("execute", "Actually pin files and write attestations. Default is dry-run.")
  .addFlag("pin", "Pin local files to IPFS and use ipfs:// mirrors.")
  .addFlag("force", "Re-seed even if this attester already has an active placement PIN.")
  .addOptionalParam("ipfsApiUrl", "Kubo API base URL, e.g. https://host/api/v0", process.env.IPFS_API_URL)
  .addOptionalParam("only", "Comma-separated manifest paths to seed")
  .setAction(async (args, hre) => {
    const only =
      typeof args.only === "string" && args.only.length > 0
        ? args.only
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean)
        : [];
    await seedDataset(
      {
        manifest: args.manifest,
        execute: Boolean(args.execute),
        pin: Boolean(args.pin),
        force: Boolean(args.force),
        ipfsApiUrl: args.ipfsApiUrl ?? process.env.IPFS_API_URL ?? "http://127.0.0.1:5001/api/v0",
        only,
      },
      hre.ethers,
    );
  });
