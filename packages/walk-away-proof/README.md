# EFS Walk-Away Proof

This package builds and publishes a small deterministic reference artifact from
the public EFS Sepolia deployment. It then records that artifact in the deployed
EFS schemas, signs the publication manifest with the project owner's Ethereum
account, and verifies the complete record from public infrastructure.

The proof is deliberately independent of the EFS web client. A verifier needs
Node.js, an Ethereum RPC endpoint, and either an IPFS or Arweave gateway.

## Publication Identity

The signed publication identity is recorded in `proof/manifest.json` after the
builder revision is committed and the exact artifact is retrieved from both
carriers. The test suite and clean-runner workflow compare rebuild output with
that committed manifest.

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

After `proof.json` exists:

```sh
yarn workspace @efs/walk-away-proof verify \
  --manifest packages/walk-away-proof/proof/manifest.json \
  --proof packages/walk-away-proof/proof/proof.json \
  --carrier ipfs

yarn workspace @efs/walk-away-proof verify \
  --manifest packages/walk-away-proof/proof/manifest.json \
  --proof packages/walk-away-proof/proof/proof.json \
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
