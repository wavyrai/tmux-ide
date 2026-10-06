import { STOCK_CAPTURE_TAB_UNAVAILABLE } from "@tmux-ide/contracts";

export class StockCaptureTabUnavailableError extends Error {
  constructor() {
    super(STOCK_CAPTURE_TAB_UNAVAILABLE);
    this.name = "StockCaptureTabUnavailableError";
  }
}

/** ANSI capture drops stored tab widths. Live HT is cursor motion, not capture paint. */
export function assertStockCaptureRepresentable(chunks: readonly Uint8Array[]): void {
  if (chunks.some((chunk) => chunk.includes(9))) throw new StockCaptureTabUnavailableError();
}
