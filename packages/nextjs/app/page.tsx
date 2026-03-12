"use client";

import Link from "next/link";
import type { NextPage } from "next";
import { useAccount } from "wagmi";
import { BugAntIcon, FolderOpenIcon, MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { Address } from "~~/components/scaffold-eth";

const Home: NextPage = () => {
  const { address: connectedAddress } = useAccount();

  return (
    <>
      <div className="flex items-center flex-col flex-grow pt-10">
        <div className="px-5 text-center">
          <h1 className="mb-2">
            <span className="block text-2xl mb-2">Welcome to</span>
            <span className="block text-5xl font-bold">EFS Dev Tools</span>
          </h1>

          <p className="text-base mt-4 max-w-lg mx-auto opacity-70">
            A decentralized file system built on{" "}
            <a href="https://attest.org" target="_blank" rel="noreferrer" className="link">
              EAS
            </a>{" "}
            attestations. Every folder, file, and property lives on-chain — immutable, permissionless, and accessible
            via <code className="bg-base-300 px-1 rounded text-sm">web3://</code> URIs.
          </p>

          <div className="flex justify-center items-center space-x-2 flex-col sm:flex-row mt-4">
            <p className="my-2 font-medium">Connected Address:</p>
            <Address address={connectedAddress} />
          </div>
        </div>

        <div className="flex-grow bg-base-300 w-full mt-16 px-8 py-12">
          <div className="flex justify-center items-center gap-8 flex-col sm:flex-row flex-wrap">
            <div className="flex flex-col bg-base-100 px-10 py-10 text-center items-center max-w-xs rounded-3xl">
              <FolderOpenIcon className="h-8 w-8 fill-secondary" />
              <p className="mt-3 font-semibold">File Explorer</p>
              <p className="mt-1 text-sm opacity-70">
                Browse and manage your on-chain files with the{" "}
                <Link href="/explorer" passHref className="link">
                  EFS Explorer
                </Link>
                .
              </p>
            </div>
            <div className="flex flex-col bg-base-100 px-10 py-10 text-center items-center max-w-xs rounded-3xl">
              <BugAntIcon className="h-8 w-8 fill-secondary" />
              <p className="mt-3 font-semibold">Debug &amp; Dev Tools</p>
              <p className="mt-1 text-sm opacity-70">
                Tinker with contracts on the{" "}
                <Link href="/debug" passHref className="link">
                  Debug
                </Link>{" "}
                page or inspect raw attestations on the{" "}
                <Link href="/debug/schemas" passHref className="link">
                  Schema Debug
                </Link>{" "}
                page.
              </p>
            </div>
            <div className="flex flex-col bg-base-100 px-10 py-10 text-center items-center max-w-xs rounded-3xl">
              <MagnifyingGlassIcon className="h-8 w-8 fill-secondary" />
              <p className="mt-3 font-semibold">Explorers</p>
              <p className="mt-1 text-sm opacity-70">
                Inspect attestations with the{" "}
                <Link href="/easexplorer" passHref className="link">
                  EAS Explorer
                </Link>{" "}
                or browse transactions in the{" "}
                <Link href="/blockexplorer" passHref className="link">
                  Block Explorer
                </Link>
                .
              </p>
            </div>
          </div>
          <p className="text-center text-xs opacity-40 mt-10">
            Built with{" "}
            <a href="https://scaffoldeth.io" target="_blank" rel="noreferrer" className="link">
              Scaffold-ETH 2
            </a>
          </p>
        </div>
      </div>
    </>
  );
};

export default Home;
