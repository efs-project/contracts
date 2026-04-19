# Devnet Sample Media Corpus

Small, browseable sample files for EFS devnet and UI testing.

Goals:
- Cover common image, video, audio, text, archive, and binary formats.
- Keep files small enough for fast local testing.
- Track upstream source and license confidence where files were downloaded.
- Include the Ethereum whitepaper PDF for PDF rendering and download tests.
- Bias the corpus toward Ethereum, EFS, and cypherpunk themes.

Notes:
- Several files in `images/`, `video/`, and `audio/` are derived locally from permissive upstream sources or repo-owned assets to keep the set on-theme while still covering multiple containers.
- Ethereum logos may still raise trademark questions even where the image itself is public domain, CC0, or below copyright threshold. Treat those as fine for internal devnet/demo use, but not as a blanket trademark clearance.

The canonical inventory for this corpus is `sample-media-manifest.json`.

## Seeding Into EFS

The optional localhost/devnet deploy step for this corpus lives in
`packages/hardhat/deploy/08_user_browsing_demo.ts`.

It seeds the files under James Carnley's address container:

- `0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199`

Run it manually after the normal deploy:

```bash
cd packages/hardhat
npx hardhat deploy --tags UserBrowsingDemo --network localhost
```

The seeder is idempotent and skips files already present for that attester.

## Adding Or Updating Demo Files

1. Add, remove, or replace files inside this folder.
2. Update `sample-media-manifest.json` so it matches the final curated set.
3. Prefer keeping the corpus small and browseable; avoid making the default dev loop heavier than necessary.
4. Re-run the optional seeder to place the files in James's address container.

Current implementation note:
- The optional seeder currently creates HTTPS MIRRORs to the checked-in assets.
- This is the fast-path launch version; see `docs/FUTURE_WORK.md` for the follow-up plan to support mixed transport seeding and reusable on-chain upload helpers.
