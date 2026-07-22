import { describe, expect, it } from "vitest";

import { APP_WINDOW_TIMESTAMP_MAX_LENGTH, AppWindowTimestampSchemaZ } from "../app-window-state.ts";

describe("app window timestamps", () => {
  it("accepts app-generated and reasonable persisted UTC representations", () => {
    const values = [
      new Date("2026-07-22T10:00:00.123Z").toISOString(),
      "2026-07-22T10:00:00Z",
      "2026-07-22T10:00:00.1Z",
      "2026-07-22T10:00:00.123456Z",
      "2026-07-22T10:00:00.123456789Z",
    ];

    for (const value of values) {
      expect(AppWindowTimestampSchemaZ.parse(value)).toBe(value);
    }
    expect(values.at(-1)).toHaveLength(APP_WINDOW_TIMESTAMP_MAX_LENGTH);
  });

  it("rejects excessive fractional precision and unbounded timestamp text", () => {
    expect(AppWindowTimestampSchemaZ.safeParse("2026-07-22T10:00:00.1234567890Z").success).toBe(
      false,
    );
    expect(
      AppWindowTimestampSchemaZ.safeParse(`2026-07-22T10:00:00.${"1".repeat(16 * 1024)}Z`).success,
    ).toBe(false);
  });

  it("retains strict UTC and calendar validation", () => {
    expect(AppWindowTimestampSchemaZ.safeParse("2026-07-22T10:00:00+00:00").success).toBe(false);
    expect(AppWindowTimestampSchemaZ.safeParse("2026-02-30T10:00:00.000Z").success).toBe(false);
  });
});
