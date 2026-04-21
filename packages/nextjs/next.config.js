// @ts-check

const { execSync } = require("node:child_process");

/**
 * Build-time constants baked into `process.env` for client-side consumption.
 *
 * Static export → `NEXT_PUBLIC_*` are inlined at build time, so any "what
 * commit is this?" / "what fork block is this?" info the UI shows must be
 * captured here. Runtime lookup isn't available (no server, no file reads).
 *
 * `NEXT_PUBLIC_GIT_SHA`: commit SHA at build time. Lets users paste a precise
 * pointer into bug reports. Respect an externally-provided value (CI often
 * sets it) before shelling out to git — git may not be available in some
 * hermetic build envs.
 *
 * `NEXT_PUBLIC_FORK_BLOCK`: pinned Sepolia block number the devnet chain forks
 * from (ADR-0037). Surfaced in the NetworkChip so operators can verify the
 * devnet VPS and local hardhat are on the same pin — mismatch here is the
 * #1 cause of "my local looks broken but CI is fine" confusion.
 */
const gitSha = (() => {
  if (process.env.NEXT_PUBLIC_GIT_SHA) return process.env.NEXT_PUBLIC_GIT_SHA;
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
})();
process.env.NEXT_PUBLIC_GIT_SHA = gitSha;
process.env.NEXT_PUBLIC_FORK_BLOCK = process.env.NEXT_PUBLIC_FORK_BLOCK ?? process.env.FORK_BLOCK ?? "10691000";

/**
 * Next.js config.
 *
 * `output: "export"` turns `next build` into a **pure static export** (writes to
 * `out/`) — no server, no edge runtime, no ISR. The goal is to ship the same
 * bundle to IPFS + eth.limo / eth.link (`app.efs.eth.limo`) and to the devnet
 * VPS as a plain file tree. Everything the app does at runtime is already
 * client-side (wagmi RPC calls, EAS reads, `web3://` gateway lookups) —
 * there are no server components that fetch at request time.
 *
 * Trade-offs bought with `output: "export"`:
 *   - Dynamic catch-alls (`/explorer/[[...path]]`, `/blockexplorer/**`) must
 *     expose `generateStaticParams`. We ship a single shell page per route and
 *     the hosting layer serves it for any deeper URL via a `_redirects` file
 *     (see `public/_redirects`). The pages are pure client components, so the
 *     shell reads the real path from `useParams()` at runtime and renders.
 *   - `next/image` optimization is server-side, so `images.unoptimized = true`
 *     is mandatory for export. The logo in Header.tsx is the only consumer.
 *   - `trailingSlash: true` makes every page a directory + `index.html`
 *     (`/explorer/` → `/explorer/index.html`). This matches how IPFS gateways
 *     serve directories and avoids a redirect hop on first load.
 *
 * Service URLs (RPC, IPFS/Arweave gateways, WS, canonical origin) are all
 * read from `NEXT_PUBLIC_*` env vars at build time — see `.env.example`.
 * For the app.efs.eth.limo build those MUST be absolute VPS URLs; relative
 * paths would resolve against the eth.limo origin and 404.
 */

// `output: "export"` is a build-only flag. In `next dev` it forces every
// dynamic route — including our `[[...path]]` catch-alls — to resolve against
// `generateStaticParams()`, which only returns the root shell. Hard-refreshing
// a deep URL like `/explorer/memes/cat.jpg` then throws
//   "Error: Page ... is missing param ... in generateStaticParams()".
// In production `public/_redirects` serves the static shell for all deeper
// URLs (see file comments), so the constraint only matters at build time.
// Turn the flag off for dev; the runtime behavior is identical either way
// because every page is a client component with no server-side data fetching.
const isProdBuild = process.env.NODE_ENV === "production";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  ...(isProdBuild ? { output: "export" } : {}),
  trailingSlash: true,
  images: { unoptimized: true },
  typescript: {
    ignoreBuildErrors: process.env.NEXT_PUBLIC_IGNORE_BUILD_ERROR === "true",
  },
  eslint: {
    ignoreDuringBuilds: process.env.NEXT_PUBLIC_IGNORE_BUILD_ERROR === "true",
  },
  webpack: config => {
    config.resolve.fallback = { fs: false, net: false, tls: false };
    config.externals.push("pino-pretty", "lokijs", "encoding");
    config.experiments = { ...config.experiments, topLevelAwait: true };
    return config;
  },
};

module.exports = nextConfig;
