import { inferNetworkFlavor } from "./networkLabel";

export function shouldShowDevnetBanner({
  chainId,
  dismissed,
  message,
}: {
  chainId: number | undefined;
  dismissed: boolean;
  message: string | undefined;
}): boolean {
  return Boolean(message) && !dismissed && inferNetworkFlavor(chainId) === "devnet";
}
