import { expect } from "chai";
import { boolEnv, envOr, oneOfEnvOr, positiveIntEnvOr } from "../env";

describe("environment helpers", function () {
  const originalEnv = { ...process.env };

  afterEach(function () {
    process.env = { ...originalEnv };
  });

  it("envOr treats unset, empty, and whitespace-only values as missing", function () {
    delete process.env.SEPOLIA_FORK_RPC_URL;
    expect(envOr("SEPOLIA_FORK_RPC_URL", "fallback")).to.equal("fallback");

    process.env.SEPOLIA_FORK_RPC_URL = "";
    expect(envOr("SEPOLIA_FORK_RPC_URL", "fallback")).to.equal("fallback");

    process.env.SEPOLIA_FORK_RPC_URL = "   ";
    expect(envOr("SEPOLIA_FORK_RPC_URL", "fallback")).to.equal("fallback");

    process.env.SEPOLIA_FORK_RPC_URL = "https://example.invalid/rpc";
    expect(envOr("SEPOLIA_FORK_RPC_URL", "fallback")).to.equal("https://example.invalid/rpc");
  });

  it("positiveIntEnvOr keeps blank FORK_BLOCK from becoming block zero", function () {
    delete process.env.FORK_BLOCK;
    expect(positiveIntEnvOr("FORK_BLOCK", 10_691_000)).to.equal(10_691_000);

    process.env.FORK_BLOCK = "";
    expect(positiveIntEnvOr("FORK_BLOCK", 10_691_000)).to.equal(10_691_000);

    process.env.FORK_BLOCK = "   ";
    expect(positiveIntEnvOr("FORK_BLOCK", 10_691_000)).to.equal(10_691_000);

    process.env.FORK_BLOCK = "10691001";
    expect(positiveIntEnvOr("FORK_BLOCK", 10_691_000)).to.equal(10_691_001);
  });

  it("positiveIntEnvOr rejects invalid block-number shapes with the env name", function () {
    for (const raw of ["not-a-number", "Infinity", "0", "-1", "1.5", "1e6", "0x10", " 10691001 "]) {
      process.env.FORK_BLOCK = raw;
      expect(() => positiveIntEnvOr("FORK_BLOCK", 10_691_000)).to.throw(
        `FORK_BLOCK must be a positive integer; got ${JSON.stringify(raw)}`,
      );
    }
  });

  it("boolEnv is true only for the exact string true", function () {
    delete process.env.MAINNET_FORKING_ENABLED;
    expect(boolEnv("MAINNET_FORKING_ENABLED")).to.equal(false);

    process.env.MAINNET_FORKING_ENABLED = "";
    expect(boolEnv("MAINNET_FORKING_ENABLED")).to.equal(false);

    process.env.MAINNET_FORKING_ENABLED = "false";
    expect(boolEnv("MAINNET_FORKING_ENABLED")).to.equal(false);

    process.env.MAINNET_FORKING_ENABLED = "TRUE";
    expect(boolEnv("MAINNET_FORKING_ENABLED")).to.equal(false);

    process.env.MAINNET_FORKING_ENABLED = "true";
    expect(boolEnv("MAINNET_FORKING_ENABLED")).to.equal(true);
  });

  it("oneOfEnvOr treats blank values as unset and rejects unknown choices", function () {
    const modes = ["full", "until-freeze-gate", "after-freeze-gate"] as const;

    delete process.env.EFS_DEPLOY_MODE;
    expect(oneOfEnvOr("EFS_DEPLOY_MODE", "full", modes)).to.equal("full");

    process.env.EFS_DEPLOY_MODE = "";
    expect(oneOfEnvOr("EFS_DEPLOY_MODE", "full", modes)).to.equal("full");

    process.env.EFS_DEPLOY_MODE = "until-freeze-gate";
    expect(oneOfEnvOr("EFS_DEPLOY_MODE", "full", modes)).to.equal("until-freeze-gate");

    process.env.EFS_DEPLOY_MODE = "typo";
    expect(() => oneOfEnvOr("EFS_DEPLOY_MODE", "full", modes)).to.throw(
      'EFS_DEPLOY_MODE must be full, until-freeze-gate, after-freeze-gate; got "typo"',
    );
  });
});
