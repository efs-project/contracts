# EFS Walk-Away Proof

This package builds and publishes a small deterministic reference artifact from
the public EFS Sepolia deployment. It then records that artifact in the deployed
EFS schemas, signs the publication manifest with the project owner's Ethereum
account, and verifies the complete record from public infrastructure.

The proof is deliberately independent of the EFS web client. A verifier needs
Node.js, an Ethereum RPC endpoint, and either an IPFS or Arweave gateway.

## Publication Identity

The signed publication is live on Sepolia:

- Artifact: `efs-sepolia-deployment-reference-v0.tar.gz`
- Size: `63,245` bytes
- SHA-256: `9c5bbda410deea8714a37b5ab82d3e22982cee79d1d1320cd43a91d562f34d39`
- Manifest digest: `0x70cb68e93f76076cca7cd530e15cf98d7318d562e57ce05f39812ffdeeeed52b`
- Signer: `0xaCf4C2950107eF9b1C37faA1F9a866C8F0da88b9`
- IPFS: [w3s.link](https://w3s.link/ipfs/bafkreie4lo62ieg65kdrji33lk4c2prctawo46or2ezazvb2shkwf42nhe)
- Arweave: [ardrive.net](https://ardrive.net/-34W1UeEynCbiM_wSU-v2vCw_M7SUeBnUF2xPco0M1k)
- Sepolia transactions:
  [artifact values](https://sepolia.etherscan.io/tx/0xb718f21d58fee081c73128b6af721cfa97fb87b93105d8731381c9b75300a933),
  [paths and mirrors](https://sepolia.etherscan.io/tx/0x72619bc19e4b822815ae9741a00781a0a1f4d73796d810d5b7778e545f3f1a16),
  and [graph pins](https://sepolia.etherscan.io/tx/0x5f6fce39b8efc2463f007a61012fe41a089ee320b721053700aaa0ca7cc3a701)

The signed manifest and full onchain receipt are committed as
`proof/manifest.json` and `proof/proof.json`. The test suite and clean-runner
workflow compare rebuilt output with the committed manifest, then verify the
publication through both independent carriers.

## Rebuild

From the repository root:

```sh
corepack enable
yarn install --immutable
yarn workspace @efs/walk-away-proof artifact
yarn workspace @efs/walk-away-proof test
```

The builder reads every source file from the named Git commit, fixes archive
metadata and ordering, rebuilds twice, and fails if the byte strings differ. The
test suite pins the expected byte length, SHA-256 digest, and raw-file IPFS CID.

## Publish To EFS

```sh
yarn workspace @efs/walk-away-proof dev
```

Open the displayed local URL in a browser with MetaMask. The publisher requires
Sepolia and the expected signer. It asks for one EIP-712 signature and three
zero-value calls to the official Sepolia EAS contract:

`0xC2679fBD37d54388Ce493F1DB75320D236e1815e`

The stages create the DATA and PROPERTY records, ANCHOR and MIRROR records, then
the PIN records. Completed transaction results are retained in browser local
storage. Download `proof.json` after the fourth approval and place it at
`packages/walk-away-proof/proof/proof.json`.

## Verify

From the repository root:

```sh
yarn workspace @efs/walk-away-proof verify \
  --manifest proof/manifest.json \
  --proof proof/proof.json \
  --carrier ipfs

yarn workspace @efs/walk-away-proof verify \
  --manifest proof/manifest.json \
  --proof proof/proof.json \
  --carrier arweave
```

The verifier checks the manifest signature; every expected EAS schema, UID,
attester, reference, recipient, payload, and revocation field; all three
transaction senders, targets, values, and receipts; and the retrieved artifact's
byte length and SHA-256 digest.

Outcomes are:

- `VERIFIED`: the onchain graph and retrieved bytes match.
- `INVALID`: cryptographic or onchain evidence does not match.
- `UNAVAILABLE`: the selected carrier could not return bytes.

`UNAVAILABLE` is not silently treated as proof failure because temporary
retrieval outages and invalid content are different claims.

## Carrier Notes

The IPFS CID is computed before upload and re-derived by the verifier from the
retrieved bytes. A local Kubo pin alone is not a permanent hosting commitment;
IPFS availability is reported independently from content validity.

Turbo's sub-100-KiB free tier can use a throwaway Arweave upload key. Project
authorship is established by the separately signed manifest and EFS
attestations, not by a carrier upload key.
