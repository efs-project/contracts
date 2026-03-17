"use client";

import { useEffect, useState } from "react";
import { hardhat } from "viem/chains";
import { useConnect, useConnectors, useDisconnect } from "wagmi";
import { ClipboardDocumentCheckIcon, ClipboardDocumentIcon } from "@heroicons/react/24/outline";
import { useTargetNetwork } from "~~/hooks/scaffold-eth";

// Deterministic Hardhat Accounts
const HARDHAT_ACCOUNTS = [
  {
    name: "Account 0",
    address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    pk: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  },
  {
    name: "Account 1",
    address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    pk: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  },
  {
    name: "Account 2",
    address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    pk: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  },
  {
    name: "Account 3",
    address: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    pk: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  },
  {
    name: "Account 4",
    address: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
    pk: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  },
  {
    name: "Account 5",
    address: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
    pk: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  },
  {
    name: "Account 6",
    address: "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
    pk: "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  },
  {
    name: "Account 7",
    address: "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",
    pk: "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  },
  {
    name: "Account 8",
    address: "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f",
    pk: "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  },
  {
    name: "Account 9",
    address: "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720",
    pk: "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
  },
  {
    name: "Account 10",
    address: "0xBcd4042DE499D14e55001CcbB24a551F3b954096",
    pk: "0xf214f2b2cd398c806f84e317254e0f0b801d0643303237d97a22a48e01628897",
  },
  {
    name: "Account 11",
    address: "0x71bE63f3384f5fb98995898A86B02Fb2426c5788",
    pk: "0x701b615bbdfb9de65240bc28bd21bbc0d996645a3dd57e7b12bc2bdf6f192c82",
  },
  {
    name: "Account 12",
    address: "0xFABB0ac9d68B0B445fB7357272Ff202C5651694a",
    pk: "0xa267530f49f8280200edf313ee7af6b827f2a8bce2897751d06a843f644967b1",
  },
  {
    name: "Account 13",
    address: "0x1CBd3b2770909D4e10f157cABC84C7264073C9Ec",
    pk: "0x47c99abed3324a2707c28affff1267e45918ec8c3f20b8aa892e8b065d2942dd",
  },
  {
    name: "Account 14",
    address: "0xdF3e18d64BC6A983f673Ab319CCaE4f1a57C7097",
    pk: "0xc526ee95bf44d8fc405a158bb884d9d1238d99f0612e9f33d006bb0789009aaa",
  },
  {
    name: "Account 15",
    address: "0xcd3B766CCDd6AE721141F452C550Ca635964ce71",
    pk: "0x8166f546bab6da521a8369cab06c5d2b9e46670292d85c875ee9ec20e84ffb61",
  },
  {
    name: "Account 16",
    address: "0x2546BcD3c84621e976D8185a91A922aE77ECEc30",
    pk: "0xea6c44ac03bff858b476bba40716402b03e41b8e97e276d1baec7c37d42484a0",
  },
  {
    name: "Account 17",
    address: "0xbDA5747bFD65F08deb54cb465eB87D40e51B197E",
    pk: "0x689af8efa8c651a91ad287602527f3af2fe9f6501a7ac4b061667b5a93e037fd",
  },
  {
    name: "Account 18",
    address: "0xdD2FD4581271e230360230F9337D5c0430Bf44C0",
    pk: "0xde9be858da4a475276426320d5e9262ecfc3ba460bfac56360bfa6c4c28b4ee0",
  },
  {
    name: "Account 19",
    address: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199",
    pk: "0xdf57089febbacf7ba0bc227dafbffa9fc08a93fdc68e1e42411a14efcf23656e",
  },
];

export const DevWalletSwitcher = () => {
  const { targetNetwork } = useTargetNetwork();
  const [mounted, setMounted] = useState(false);
  const [activeAddress, setActiveAddress] = useState<string | null>(null);
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const { disconnect } = useDisconnect();
  const { connect } = useConnect();
  const connectors = useConnectors();

  useEffect(() => {
    setMounted(true);
    // Find active address from local storage PK
    if (typeof window !== "undefined") {
      const storedPk = window.localStorage.getItem("burnerWallet.pk")?.replaceAll('"', "") ?? "0x";
      const account = HARDHAT_ACCOUNTS.find(acc => acc.pk === storedPk);
      if (account) {
        setActiveAddress(account.address);
      }
    }
  }, []);

  if (!mounted || targetNetwork.id !== hardhat.id) {
    return null;
  }

  const copyAddress = (address: string) => {
    navigator.clipboard.writeText(address).then(() => {
      setCopiedAddress(address);
      setTimeout(() => setCopiedAddress(null), 1500);
    });
  };

  const switchAccount = (pk: string) => {
    if (typeof window === "undefined") return;
    const account = HARDHAT_ACCOUNTS.find(acc => acc.pk === pk);
    window.localStorage.setItem("burnerWallet.pk", pk);
    setActiveAddress(account?.address ?? null);
    // Reconnect burner connector so wagmi picks up the new PK from localStorage
    const burnerConnector = connectors.find(c => c.id === "burnerWallet");
    if (burnerConnector) {
      disconnect(undefined, {
        onSettled: () => connect({ connector: burnerConnector }),
      });
    }
  };

  return (
    <div className="dropdown dropdown-end">
      <label tabIndex={0} className="btn btn-secondary btn-sm shadow-md rounded-full px-4 ml-2 max-w-xs">
        {activeAddress ? `Dev: ${HARDHAT_ACCOUNTS.find(a => a.address === activeAddress)?.name}` : "Dev Wallets"}
      </label>
      <ul
        tabIndex={0}
        className="dropdown-content menu p-2 mt-2 shadow-center shadow-accent bg-base-200 rounded-box w-56 z-[100]"
      >
        <li className="menu-title px-4 py-2 text-sm">Switch Burner Wallet</li>
        {HARDHAT_ACCOUNTS.map(account => (
          <li key={account.address}>
            <div
              className={`flex items-center justify-between gap-1 px-2 py-1 rounded-lg cursor-pointer text-sm ${
                activeAddress === account.address ? "bg-secondary" : "hover:bg-base-300"
              }`}
            >
              <span className="flex-1 min-w-0" onClick={() => switchAccount(account.pk)}>
                <span className="block">{account.name}</span>
                <span className="text-xs opacity-50">
                  {account.address.slice(0, 6)}...{account.address.slice(-4)}
                </span>
              </span>
              <button
                className="btn btn-ghost btn-xs p-0.5 opacity-50 hover:opacity-100 flex-shrink-0"
                onClick={e => {
                  e.stopPropagation();
                  copyAddress(account.address);
                }}
                title="Copy address"
              >
                {copiedAddress === account.address ? (
                  <ClipboardDocumentCheckIcon className="w-4 h-4 text-success" />
                ) : (
                  <ClipboardDocumentIcon className="w-4 h-4" />
                )}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
};
