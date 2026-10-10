import { z } from "zod";
import { TmuxServerClientError } from "../../../packages/daemon-client/src/tmux-server-client.ts";

const stages = {
  "list-sessions": "list sessions",
  "revalidate-sessions": "revalidate session",
  "open-session": "open session",
  inventory: "read pane inventory",
  "connection-validation": "validate pane connection",
} as const;
type CatalogStage = keyof typeof stages;

/** Public diagnostics contain only fixed labels and a bounded numeric HTTP status. */
export class CatalogStageError extends Error {
  constructor(stage: CatalogStage, error?: unknown, selectionMissing = false) {
    let reason = selectionMissing ? "selection unavailable" : "unclassified failure";
    let status: number | undefined;
    if (error instanceof TmuxServerClientError) {
      reason =
        error.code === "disposed"
          ? "catalog retired"
          : error.code === "scope-mismatch"
            ? "scope mismatch"
            : "request failed";
      if (Number.isInteger(error.status) && error.status! >= 100 && error.status! <= 599)
        status = error.status;
    } else if (error instanceof z.ZodError || error instanceof SyntaxError) {
      reason = "invalid response";
    } else if (error instanceof TypeError) {
      // Fetch transport errors and explicit response-shape checks both use TypeError.
      reason = "transport or response failure";
    } else if (error instanceof DOMException) {
      if (error.name === "TimeoutError") reason = "request timed out";
      else if (error.name === "AbortError") reason = "request aborted";
    }
    super(
      `Catalog unavailable (${Object.hasOwn(stages, stage) ? stages[stage] : "unknown stage"}: ${reason}${status === undefined ? "" : `; HTTP ${status}`}) — refresh the catalog`,
    );
    this.name = "CatalogStageError";
    // Deliberately do not retain raw causes: they may contain private response/config data.
  }
}

export async function catalogStage<T>(
  stage: CatalogStage,
  action: () => T | Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof CatalogStageError) throw error;
    throw new CatalogStageError(stage, error);
  }
}
