export interface FleetPreviewWindow {
  id: string;
  index: number;
  name: string;
  active: boolean;
  /** Omitted when the bounded membership snapshot is unavailable. */
  paneIds?: readonly string[];
}
export interface FleetPreviewSnapshot {
  windows: FleetPreviewWindow[];
  selectedWindowId: string | null;
  text: string;
}
