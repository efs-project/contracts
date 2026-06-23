import { expect } from "chai";
import fs from "fs";
import path from "path";
import { SCAFFOLDING } from "../deploy-lib/safePlan";

describe("transport scaffolding", function () {
  it("seeds every default transport anchor, including inline data", function () {
    const transportsIndex = SCAFFOLDING.findIndex(a => a.name === "transports");
    const children = SCAFFOLDING.filter(a => a.parentIndex === transportsIndex).map(a => a.name);

    expect(children).to.have.members([
      "onchain",
      "data",
      "ipfs",
      "arweave",
      "magnet",
      "https",
      "ftp",
      "s3",
      "gs",
      "dat",
      "rsync",
      "bittorrent",
    ]);
    expect(new Set(children).size).to.equal(children.length);
  });

  it("keeps the legacy hardhat-deploy mirror seed in sync with inline data", function () {
    const deployScript = fs.readFileSync(path.join(__dirname, "../deploy/05_mirrors.ts"), "utf8");

    expect(deployScript).to.contain('"data"');
  });
});
