# Agent Context

## Documentation Paths
- **Scaffold-ETH2 Docs**: `/contracts/scaffold-docs.txt` - Use for UI elements and project structure.
- **EAS General Docs**: `/contracts/eas-docs.txt` - High-level concepts.
- **EAS SDK Docs**: `/contracts/eas-sdk-docs.txt` - Official interaction with attestations.

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
1. **Start Frontend**:
   ```bash
   # From /contracts/ (will run packages/nextjs dev)
   yarn start
   ```
   *Note the local URL provided in the output (typically `http://localhost:3000`).*

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
