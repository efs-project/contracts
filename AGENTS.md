# Agent Context

## Reference Paths
- **Scaffold-ETH2 Docs**: `/contracts/reference/scaffold-docs.txt` - Use for UI elements and project structure.
- **EAS General Docs**: `/contracts/reference/eas-docs.txt` - High-level concepts.
- **EAS SDK Docs**: `/contracts/reference/eas-sdk-docs.txt` - Official interaction with attestations.
- **EIPs**: `/contracts/reference/EIPs/` - EIPs relevant to this project. Noteable ones are 4804 / 6860 (Main Web3 URI spec), 5219 (Contract Resource Requests), 6944 (ERC-5219 Resolve Mode), 7617 (Chunk support for ERC-5219 mode in Web3 URL), 6821 (Support ENS Name for Web3 URL), 7618 (Content encoding in ERC-5219 mode), and 7774 (Cache invalidation in ERC-5219 mode).
- **Web3Protocol**: `/contracts/reference/web3protocol.md` - JS library to parse and fetch Web3 URLs.
- **Web3Curl**: `/contracts/reference/web3curl.md` - CLI tool to fetch and debug Web3 URLs.

## Project Setup Commands

You need to run a fork of Sepolia so we can use the pre-deployed EAS contracts.

When using the Browser you must also click the money icon in the top right as that's the faucet that adds ETH for gas to your account.

### Blockchain
1. **Start Chain**: 
   ```bash
   # From project root or /contracts/
   yarn run fork
   ```

2. **Deploy Contracts**: 
   ```bash
   # From /contracts/
   yarn run deploy
   ```

### UI Initialization
1. **Start Debug UI / DevTools**:
   ```bash
   # From /contracts/ (will run packages/nextjs schema testing app)
   yarn start
   ```
   *Note the local URL provided in the output (typically `http://localhost:3000`). This is NOT the EFS Web Client.*

2. **Starting the EFS Web Client**:
   If your task involves the actual web explorer, you must switch into the isolated EFS Client repository (a separate codebase). The path varies by machine.
   Once inside the client repo, you must sync your recently deployed local contracts:
   ```bash
   npm run sync-abis
   npm run dev
   ```

2. **Fund Wallet**: 
   - In the top right of the UI, click the **Local Faucet** (cash icon) to send test funds to your burner wallet. Attestations require gas!

## Schema Debug & Verification

### Schema Debug Page
Once the UI is running, navigate to the Schema Debug page at:  
`{BASE_URL}/debug/schemas`  
*(e.g., `http://localhost:3000/debug/schemas`)*

### Test an Attestation
To verify the agent's ability to attest, use the **Tag Schema** form on the debug page:

1.  **Ref UID (Topic)**: Enter a dummy Topic UID (or leave the pre-filled root topic UID if available).
2.  **Definition**: Enter a short string (e.g., `test-tag`).
3.  **Action**: Click **"Attest Tag"**.
4.  **Verification**: 
    - Wait for the "Success! Tx: ..." notification.
    - Scroll down to the **"Attestation Viewer"**.
    - Ensure your new attestation appears under the **"Tags"** list.
