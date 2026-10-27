import { task } from "hardhat/config";
import { seedDataset } from "../scripts/seed-dataset";
import { parseAttester } from "../scripts/seed-dataset-lib";

task("seed:dataset", "Pin a dataset to IPFS and seed EFS DATA/MIRROR/PIN/TAG attestations")
  .addOptionalParam("manifest", "Path to the dataset manifest JSON. Default: all sibling dataset manifests.", "")
  .addFlag("execute", "Actually pin files and write attestations. Default is dry-run.")
  .addFlag("plan", "Read chain state and print skip/write actions without pinning/writing.")
  .addFlag("pin", "Pin local files to IPFS and use ipfs:// mirrors.")
  .addFlag("force", "Re-seed even if the active contentHash already matches.")
  .addOptionalParam("ipfsApiUrl", "Kubo API base URL, e.g. https://host/api/v0", process.env.IPFS_API_URL)
  .addOptionalParam("only", "Comma-separated manifest paths to seed")
  .addOptionalParam(
    "attester",
    "The lens to publish under. --plan reads as it (no key needed); --execute refuses unless the loaded key matches.",
  )
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
        plan: Boolean(args.plan),
        pin: Boolean(args.pin),
        force: Boolean(args.force),
        ipfsApiUrl: args.ipfsApiUrl ?? process.env.IPFS_API_URL ?? "http://127.0.0.1:5001/api/v0",
        only,
        ...(typeof args.attester === "string" && args.attester.length > 0
          ? { attester: parseAttester(args.attester) }
          : {}),
      },
      hre.ethers,
    );
  });
