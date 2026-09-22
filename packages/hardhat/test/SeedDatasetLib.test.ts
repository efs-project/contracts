import { expect } from "chai";
import {
  assertSafeAnchorPath,
  assertSafeManifestPath,
  buildIpfsAddUrl,
  canonicalContentHash,
  contentTypeForEntry,
  decideSeedFileAction,
  legacyKeccakContentHash,
  parseKuboAddResponse,
  parseSeedDatasetArgs,
} from "../scripts/seed-dataset-lib";

describe("seed-dataset helpers", function () {
  it("parses guarded CLI defaults and explicit execute/pin flags", function () {
    const args = parseSeedDatasetArgs([
      "--manifest",
      "../datasets/web-games/manifest.json",
      "--execute",
      "--pin",
      "--ipfs-api-url",
      "https://178.104.79.94.nip.io/api/v0",
      "--only",
      "snake.html",
      "--force",
    ]);

    expect(args.manifest).to.equal("../datasets/web-games/manifest.json");
    expect(args.execute).to.equal(true);
    expect(args.pin).to.equal(true);
    expect(args.ipfsApiUrl).to.equal("https://178.104.79.94.nip.io/api/v0");
    expect(args.only).to.deep.equal(["snake.html"]);
    expect(args.force).to.equal(true);
  });

  it("parses chain-aware plan mode", function () {
    const args = parseSeedDatasetArgs(["--manifest", "../datasets/web-games/manifest.json", "--plan"]);

    expect(args.execute).to.equal(false);
    expect(args.pin).to.equal(false);
    expect(args.plan).to.equal(true);
  });

  it("keeps dry-run as the default", function () {
    const args = parseSeedDatasetArgs(["--manifest", "../datasets/web-games/manifest.json"]);

    expect(args.execute).to.equal(false);
    expect(args.pin).to.equal(false);
    expect(args.force).to.equal(false);
    expect(args.ipfsApiUrl).to.equal("http://127.0.0.1:5001/api/v0");
  });

  it("allows no-argument safe default mode", function () {
    const args = parseSeedDatasetArgs([]);

    expect(args.manifest).to.equal("");
    expect(args.execute).to.equal(false);
    expect(args.plan).to.equal(false);
    expect(args.pin).to.equal(false);
  });

  it("rejects unsafe manifest file paths", function () {
    expect(() => assertSafeManifestPath("snake.html")).to.not.throw();
    expect(() => assertSafeManifestPath("nested/readme.md")).to.not.throw();
    expect(() => assertSafeManifestPath("bad%20space/readme.md")).to.not.throw();

    expect(() => assertSafeManifestPath("")).to.throw(/must not be empty/);
    expect(() => assertSafeManifestPath("/tmp/snake.html")).to.throw(/relative/);
    expect(() => assertSafeManifestPath("../secret.txt")).to.throw(/must not be/);
    expect(() => assertSafeManifestPath("nested/../../secret.txt")).to.throw(/must not be/);
    expect(() => assertSafeManifestPath("bad space/readme.md")).to.throw(/unescaped reserved/);
    expect(() => assertSafeManifestPath("bad%2fspace/readme.md")).to.throw(/malformed percent/);
  });

  it("rejects unsafe manifest anchor paths", function () {
    expect(() => assertSafeAnchorPath("/games")).to.not.throw();
    expect(() => assertSafeAnchorPath("/games/arcade")).to.not.throw();
    expect(() => assertSafeAnchorPath("/games%20archive")).to.not.throw();

    expect(() => assertSafeAnchorPath("games")).to.throw(/must start/);
    expect(() => assertSafeAnchorPath("/")).to.throw(/must not be root/);
    expect(() => assertSafeAnchorPath("/games//arcade")).to.throw(/empty segments/);
    expect(() => assertSafeAnchorPath("/../games")).to.throw(/must not be/);
    expect(() => assertSafeAnchorPath("/bad space")).to.throw(/unescaped reserved/);
  });

  it("parses Kubo add JSON and ndjson responses", function () {
    expect(parseKuboAddResponse('{"Name":"snake.html","Hash":"bafyabc","Size":"123"}')).to.equal("bafyabc");
    expect(
      parseKuboAddResponse(
        '{"Name":"part","Hash":"bafychild","Size":"10"}\n{"Name":"root","Hash":"bafyroot","Size":"20"}\n',
      ),
    ).to.equal("bafyroot");
  });

  it("normalizes IPFS add endpoint URLs", function () {
    expect(buildIpfsAddUrl("https://example.test/api/v0").toString()).to.equal(
      "https://example.test/api/v0/add?pin=true&cid-version=1&raw-leaves=true",
    );
    expect(buildIpfsAddUrl("https://example.test/api/v0/add?pin=false").toString()).to.equal(
      "https://example.test/api/v0/add?pin=true&cid-version=1&raw-leaves=true",
    );
  });

  it("uses entry content type before manifest defaults", function () {
    expect(
      contentTypeForEntry({ path: "index.html", contentType: "text/html" }, { contentType: "text/plain" }),
    ).to.equal("text/html");
    expect(contentTypeForEntry({ path: "README.md" }, { contentType: "text/markdown" })).to.equal("text/markdown");
    expect(contentTypeForEntry({ path: "file.bin" }, {})).to.equal("application/octet-stream");
  });

  it("skips only when the active placement content hash matches local bytes", function () {
    expect(
      decideSeedFileAction({
        activePlacement: { dataUID: "0xdata", contentHash: "0xABCDEF" },
        force: false,
        localContentHash: "0xabcdef",
      }),
    ).to.deep.equal({
      action: "skip",
      reason: "matching-content-hash",
    });

    expect(
      decideSeedFileAction({
        activePlacement: null,
        force: false,
        localContentHash: "0x2222",
      }),
    ).to.deep.equal({
      action: "write",
      reason: "missing-placement",
    });

    expect(
      decideSeedFileAction({
        activePlacement: { dataUID: "0xdata", contentHash: "0x1111" },
        force: false,
        localContentHash: "0x2222",
      }),
    ).to.deep.equal({
      action: "write",
      reason: "content-hash-changed",
    });

    expect(
      decideSeedFileAction({
        activePlacement: { dataUID: "0xdata", contentHash: null },
        force: false,
        localContentHash: "0x2222",
      }).reason,
    ).to.equal("missing-content-hash");

    expect(
      decideSeedFileAction({
        activePlacement: { dataUID: "0xdata", contentHash: "0x2222" },
        force: true,
        localContentHash: "0x2222",
      }),
    ).to.deep.equal({
      action: "write",
      reason: "forced",
    });
  });

  it("hashes to the canonical specs/10 multihash, not a bare keccak digest", function () {
    // Vector: sha256("hello") = 2cf24dba…9824
    const bytes = new TextEncoder().encode("hello");
    expect(canonicalContentHash(bytes)).to.equal(
      "f12202cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(canonicalContentHash(bytes)).to.match(/^f1220[0-9a-f]{64}$/);
    // The legacy claim this seeder used to mint for the same bytes — recognised, never written.
    expect(legacyKeccakContentHash(bytes)).to.equal(
      "0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8",
    );
  });

  it("HEALS a legacy keccak claim of the SAME bytes instead of re-seeding the file", function () {
    // Every file seeded before specs/10 carries `0x`+keccak, which never string-equals the
    // local `f1220…`; without this a re-run would re-pin and re-seed the whole dataset.
    const bytes = new TextEncoder().encode("hello");
    const local = canonicalContentHash(bytes);
    const legacy = legacyKeccakContentHash(bytes);
    expect(
      decideSeedFileAction({
        activePlacement: { dataUID: "0xdata", contentHash: legacy },
        force: false,
        localContentHash: local,
        localLegacyContentHash: legacy,
      }),
    ).to.deep.equal({ action: "heal", reason: "legacy-content-hash" });

    // Case-insensitive, like the existing skip comparison.
    expect(
      decideSeedFileAction({
        activePlacement: { dataUID: "0xdata", contentHash: legacy.toUpperCase().replace("0X", "0x") },
        force: false,
        localContentHash: local,
        localLegacyContentHash: legacy,
      }).action,
    ).to.equal("heal");

    // A legacy claim of DIFFERENT bytes is a real content change, not a heal.
    expect(
      decideSeedFileAction({
        activePlacement: { dataUID: "0xdata", contentHash: legacyKeccakContentHash(new TextEncoder().encode("old")) },
        force: false,
        localContentHash: local,
        localLegacyContentHash: legacy,
      }),
    ).to.deep.equal({ action: "write", reason: "content-hash-changed" });

    // Once healed, the canonical claim matches and the file is skipped.
    expect(
      decideSeedFileAction({
        activePlacement: { dataUID: "0xdata", contentHash: local },
        force: false,
        localContentHash: local,
        localLegacyContentHash: legacy,
      }),
    ).to.deep.equal({ action: "skip", reason: "matching-content-hash" });

    // --force still wins.
    expect(
      decideSeedFileAction({
        activePlacement: { dataUID: "0xdata", contentHash: legacy },
        force: true,
        localContentHash: local,
        localLegacyContentHash: legacy,
      }).action,
    ).to.equal("write");
  });
});
