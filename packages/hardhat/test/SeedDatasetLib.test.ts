import { expect } from "chai";
import {
  assertSafeAnchorPath,
  assertSafeManifestPath,
  buildIpfsAddUrl,
  contentTypeForEntry,
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

  it("keeps dry-run as the default", function () {
    const args = parseSeedDatasetArgs(["--manifest", "../datasets/web-games/manifest.json"]);

    expect(args.execute).to.equal(false);
    expect(args.pin).to.equal(false);
    expect(args.force).to.equal(false);
    expect(args.ipfsApiUrl).to.equal("http://127.0.0.1:5001/api/v0");
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
});
