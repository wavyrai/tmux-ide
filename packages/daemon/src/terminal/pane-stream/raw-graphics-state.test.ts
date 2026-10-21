import { describe, expect, it } from "vitest";
import { rawGraphicsState } from "./pane-stream-websocket.ts";

describe("graphics state for renderers without zlib support", () => {
  it("announces raw formats and sizes, dropping images beyond their limit", () => {
    const image = (digest: string, width: number, height: number) => ({
      imageId: 1,
      digest,
      format: "rgba-zlib" as const,
      width,
      height,
      bytes: 100,
      placeholder: null,
    });
    const small = "a".repeat(32);
    const huge = "b".repeat(32);
    const state = rawGraphicsState({
      revision: 3,
      images: [image(small, 10, 10), image(huge, 4000, 3000)],
      placements: [
        {
          digest: huge,
          row: 0,
          column: 0,
          rows: 1,
          columns: 1,
          sourceRow: 0,
          sourceColumn: 0,
          totalRows: 1,
          totalColumns: 1,
        },
      ],
    });
    expect(state.images).toEqual([
      expect.objectContaining({ digest: small, format: "rgba", bytes: 400 }),
    ]);
    expect(state.placements).toEqual([]);
  });
});
