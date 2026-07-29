# Walk-Away Proof v0 Evidence

Evidence captured 2026-07-29. This is a feasibility demonstrator, not a claim
that the proposed maintained tool or EFS v2 is complete.

## Published identity

- Artifact: `efs-sepolia-deployment-reference-v0.tar.gz`
- Bytes: `63,245`
- SHA-256: `9c5bbda410deea8714a37b5ab82d3e22982cee79d1d1320cd43a91d562f34d39`
- IPFS CID: `bafkreie4lo62ieg65kdrji33lk4c2prctawo46or2ezazvb2shkwf42nhe`
- Arweave ID: `-34W1UeEynCbiM_wSU-v2vCw_M7SUeBnUF2xPco0M1k`
- Manifest digest: `0x70cb68e93f76076cca7cd530e15cf98d7318d562e57ce05f39812ffdeeeed52b`
- Signer: `0xaCf4C2950107eF9b1C37faA1F9a866C8F0da88b9`
- EFS DATA UID: `0xcb848af3a9508e4cf9bac6948d2221a0a8ef2c74887a637260ee10ffe83f8e49`

Sepolia transactions:

- Artifact values: `0xb718f21d58fee081c73128b6af721cfa97fb87b93105d8731381c9b75300a933`
- Paths and mirrors: `0x72619bc19e4b822815ae9741a00781a0a1f4d73796d810d5b7778e545f3f1a16`
- Graph pins: `0x5f6fce39b8efc2463f007a61012fe41a089ee320b721053700aaa0ca7cc3a701`

## Verification record

| Check | Result |
|---|---|
| Deterministic rebuild | Same 63,245 bytes, SHA-256, and raw CID on repeated builds |
| Node portability | Same bytes under Node.js 20.20.0, 24.11.0, and 26.0.0 |
| IPFS retrieval | `VERIFIED`; 63,245 bytes and expected SHA-256 |
| Arweave retrieval | `VERIFIED`; 63,245 bytes and expected SHA-256 |
| Changed artifact bytes | `INVALID` |
| Changed manifest | `INVALID` |
| Changed signature | `INVALID` |
| Substituted carrier locator | `INVALID` |
| Wrong EFS DATA UID | `INVALID` |
| Unreachable selected carrier | `UNAVAILABLE` |
| Clean Sepolia fork simulation | All three zero-ETH EAS calls succeeded and produced 14 attestations |

The live verifier also checks the expected signer; Sepolia chain and contract
addresses; all DATA, PROPERTY, ANCHOR, MIRROR, and PIN records; active PIN
targets; transaction senders, targets, values, receipts, and claimed UIDs; and
the bytes retrieved from the selected carrier.

## Reproduce

From the repository root:

```sh
corepack enable
yarn install --immutable
yarn workspace @efs/walk-away-proof artifact
yarn workspace @efs/walk-away-proof artifact:assert
yarn workspace @efs/walk-away-proof test
yarn workspace @efs/walk-away-proof verify --manifest proof/manifest.json --proof proof/proof.json --carrier ipfs
yarn workspace @efs/walk-away-proof verify --manifest proof/manifest.json --proof proof/proof.json --carrier arweave
```

The public workflow repeats deterministic builds on Ubuntu and macOS with
Node.js 22 and 26, then verifies the committed publication through both
carriers from a fresh runner.

## Current boundary

The v0 records use revocable EFS PIN and MIRROR attestations, and the verifier
rejects records that are already revoked. The demonstrator does not yet define
a single coherent manifest-level supersession or revocation flow. Threat
modeling that behavior, implementing it, and comparing it with a
signed-manifest-only baseline are part of the proposed grant work.
