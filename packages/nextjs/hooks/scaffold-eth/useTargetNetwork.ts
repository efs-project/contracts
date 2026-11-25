import { useEffect, useMemo } from "react";
import { useAccount } from "wagmi";
import scaffoldConfig from "~~/scaffold.config";
import { useGlobalState } from "~~/services/store/store";
import {
  ChainWithAttributes,
  NETWORKS_EXTRA_DATA,
  targetNetworkStorage,
  writeStoredTargetNetworkId,
} from "~~/utils/scaffold-eth";

/**
 * Retrieves the connected wallet's network from scaffold.config or defaults to the 0th network in the list if the wallet is not connected.
 */
export function useTargetNetwork(): { targetNetwork: ChainWithAttributes } {
  const { chain } = useAccount();
  const targetNetwork = useGlobalState(({ targetNetwork }) => targetNetwork);
  const setTargetNetwork = useGlobalState(({ setTargetNetwork }) => setTargetNetwork);
  const routeChainId = useGlobalState(({ routeChainId }) => routeChainId);

  useEffect(() => {
    const newSelectedNetwork = scaffoldConfig.targetNetworks.find(targetNetwork => targetNetwork.id === chain?.id);
    if (newSelectedNetwork && newSelectedNetwork.id !== targetNetwork.id) {
      setTargetNetwork(newSelectedNetwork);
      // While an explorer link names a chain (`#sep/…`), chain changes are for
      // that view only: never saved as the preference. That includes a wallet
      // that connects on another chain while the link's chain is being applied.
      if (routeChainId === null) writeStoredTargetNetworkId(targetNetworkStorage(), newSelectedNetwork.id);
    }
  }, [chain?.id, setTargetNetwork, targetNetwork.id, routeChainId]);

  return useMemo(
    () => ({
      targetNetwork: {
        ...targetNetwork,
        ...NETWORKS_EXTRA_DATA[targetNetwork.id],
      },
    }),
    [targetNetwork],
  );
}
