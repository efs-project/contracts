import { TransactionPageClient } from "./TransactionPageClient";
import type { NextPage } from "next";

export function generateStaticParams() {
  // Workaround to enable static exports in Next.js, generating a single dummy
  // page. The real txHash is read at runtime by `TransactionPageClient` via
  // `useParams()`, so this shell serves every `/blockexplorer/transaction/*`
  // URL after `public/_redirects` rewrites deep links to it.
  return [{ txHash: "0x0000000000000000000000000000000000000000" }];
}

const TransactionPage: NextPage = () => {
  return <TransactionPageClient />;
};

export default TransactionPage;
