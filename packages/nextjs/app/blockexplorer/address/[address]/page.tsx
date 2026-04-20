import { AddressPageClient } from "./AddressPageClient";

export function generateStaticParams() {
  // Workaround to enable static exports in Next.js, generating a single dummy
  // page. The real address is read at runtime by `AddressPageClient` via
  // `useParams()`, so this shell serves every `/blockexplorer/address/*` URL
  // after `public/_redirects` rewrites deep links to it.
  return [{ address: "0x0000000000000000000000000000000000000000" }];
}

const AddressPage = () => {
  return <AddressPageClient />;
};

export default AddressPage;
