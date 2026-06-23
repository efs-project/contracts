# EFS chains — deployed addresses

Canonical, human-readable registry of EFS contract addresses + frozen schema UIDs per chain. The
machine-readable source the apps consume is `packages/nextjs/contracts/deployedContracts.ts`; this file
is the at-a-glance reference and the cold-boot record (a reader in 50 years should be able to find the
foundation from here without the rest of the repo). Update it in the same commit as any new deploy.

> Addresses are **Safe-keyed CREATE3** — the EFS.eth Safe is the CreateX caller, so the proxy addresses
> (and the 9 schema UIDs hashed against them) are keyed to the Safe and identical on any chain the same
> Safe deploys from. The resolver **implementations** are content-addressed CREATE2 behind the proxies,
> in no schema UID, and intentionally not listed here — consumers only ever touch the proxies.

---

## Sepolia — chainId 11155111

**Status:** frozen (9 schemas registered + scaffolding sealed) on **2026-06-19**. Born Safe-owned and
**still upgradeable** by the EFS.eth Safe — the upgrade keys stay until EFS is audited and explicitly
approved for immutability. **There is no burn timeline** (James-gated; the ≥14-day soak in
`docs/SEPOLIA_FREEZE_TABLE.md` is a *minimum precondition*, not a schedule). Read views
(EFSFileView / EFSRouter / ListReader) are deployed separately via `yarn deploy:efs-views` and added below
once run.

### Governance + chain singletons

| Role | Address |
|---|---|
| EFS.eth Safe (owner / upgrade authority / CreateX caller) | `0x1Ad8B0a3F7F6892e9206FcA4c93871FEA3cA11D7` |
| CreateX factory | `0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed` |
| EAS | `0xC2679fBD37d54388Ce493F1DB75320D236e1815e` |
| EAS SchemaRegistry | `0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0` |

### Core contracts (Safe-keyed CREATE3 proxies)

| Contract | Address |
|---|---|
| EFSIndexer (kernel) | `0xc4DeaBB482C2FA74690629eEa662efb166BD658a` |
| EdgeResolver (PIN/TAG) | `0xD6643DB36B20895E3E46aD08cdD4ED4BC1dBB7F1` |
| MirrorResolver (MIRROR) | `0xd4991Ced6D460A3794E9120dC6C19975092982b9` |
| ListResolver (LIST) | `0x678883253e0edA926aC48F23655967e78E7d464C` |
| ListEntryResolver (LIST_ENTRY) | `0x7a14832E355d5937019C3D0b72bd11F2dbD5e513` |
| AliasResolver (REDIRECT) | `0xB07225842d6513239a3519ae052B5bc7EBf18996` |
| SystemAccount (`system` lens) | `0x63DEA7336C4217B7c5433eE3CB21Bb6a6813588d` |

### Read views (stateless, redeployable — in no schema UID)

Redeployed 2026-06-23 (plain EOA deploy, no Safe — these are ownerless and in no UID) to ship the
hardened web3:// router + latest views (ADR-0057/0058/0059). Redeployable at any time; on a redeploy,
off-chain consumers update a config value. (On-chain consumers should bind to the permanent
kernel/resolvers, not these addresses — see `docs/FUTURE_WORK.md`.)

| Contract | Address |
|---|---|
| EFSFileView | `0x76B10909Ff10b53c54387C66B083b1613E2276d3` |
| EFSRouter | `0x44D5F6803127B442218e9aA0481A9931444dc82c` |
| ListReader | `0xCc182611B572b5C162a3D96674E821C61ac658FC` |

### Frozen schema UIDs

| Schema | UID |
|---|---|
| ANCHOR | `0xf818abd74da70345c8acd7087e6ce69fd48eaf4e79c1931e5c6b08fb148c921a` |
| PROPERTY | `0xa1f54f2d395c24077e374d9a2d835a2d2fcb3b4c3e019f63525bee3424f1c246` |
| DATA | `0xa3400cecc384d66d84f502fd91e56dc0321edccde9ef8e49d303ba63cc841b3c` |
| PIN | `0x5aaabaea19accff34c604f6f1b0dd2361a0a9ba64f7746ea6b3ed95d4047d878` |
| TAG | `0x0c41f8ee209fdbea4de3942c488a4098dd5a8bb1afce117857c5493002dd0e87` |
| MIRROR | `0x9573ea8100bda88cc09ba275d8307b309c42ae82cca7f96ccf0e3eef4b5ea58d` |
| LIST | `0x2e2801910184228802919fcc6f20c7e6c9e9c12fb8ae7a1f4e516cd3eeec6a59` |
| LIST_ENTRY | `0x9a22c62bf63ef3a04412c124747df97d9f9e81376fa202d4ed514d0a5e6c9af1` |
| REDIRECT | `0x5dca2fcc2c39c8629616b175a38c5e71d641b3019a3cb4ca790cc8fd32c9b8e0` |

Realized `/transports` anchor UID (scaffolding root for transport definitions):
`0x936fb4c60e82d645bda043b6b7d6a20643c503d4a86450f0d348383e02878cc3`

### Deploy ceremony (Safe MultiSend, MultiSendCallOnly 1.4.1, `operation=1`)

| Batch | Nonce | safeTxHash |
|---|---|---|
| 1 — deploy + wire | 0 | `0x0f631eb9eba02979e1e109a1f7ac056dc27e10b6545972a3a572199fd5f6466a` |
| 2 — register×9 + bootstrap + seal | 1 | `0x12dc7b0d9d3f96e44ac715d4e6e78fca252c02626d68805b35bedbb4e2228647` |
| 3 — setTransportsAnchor | 2 | `0x6f14899051d05a4bd8ba2a7ccc1b91752d724520236a96fa9c463f5deda84a93` |

Full field strings, `revocable` flags, and the human freeze sign-off: `docs/SEPOLIA_FREEZE_TABLE.md`.

---

## Mainnet — chainId 1

Not deployed. The same Safe-native ceremony (`docs/DEPLOYMENT.md` §4) reproduces these addresses/UIDs
identically if deployed from the same EFS.eth Safe (CreateX is cross-chain, salts are frozen).
