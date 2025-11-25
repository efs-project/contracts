# Ethereum File System Contracts

This project is in early development and takes some technical skill to set up and use.

## Getting Started

### 1. Install Dependencies
```bash
yarn install
```

### 2. Start Local Chain (Terminal 1)
```bash
yarn fork
```

### 3. Deploy Contracts (Terminal 2)
```bash
yarn deploy
```

> [!IMPORTANT]
> **FOR AI AGENTS AND HUMANS:**
> Do NOT use direct `npx hardhat` commands (like `npx hardhat node` or `npx hardhat deploy`).
> ALWAYS use the defined `yarn` scripts (`yarn fork`, `yarn deploy`) to ensure environment variables and workspaces are handled correctly.

### 4. Optional: Start Scaffold UI (Terminal 3)
For debugging and easily using the contracts:
```bash
yarn start
```



---

## About Scaffold-ETH 2
This project uses [Scaffold-ETH 2](https://scaffoldeth.io) as a base.
- [Documentation](https://docs.scaffoldeth.io)
- [Website](https://scaffoldeth.io)

