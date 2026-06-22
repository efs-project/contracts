export interface FileWriteCancellationState {
  readonly cancelled: boolean;
  readonly completedLayer: number;
  readonly mintsFileAnchor: boolean;
  readonly fileAnchorLayer: number;
}

export function shouldCancelLayeredFileWrite({
  cancelled,
  completedLayer,
  mintsFileAnchor,
  fileAnchorLayer,
}: FileWriteCancellationState): boolean {
  if (!cancelled) return false;
  if (mintsFileAnchor && completedLayer >= fileAnchorLayer) return false;
  return true;
}
