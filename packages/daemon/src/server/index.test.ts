import { describe, expect, it } from "vitest";
import { SERVER_BIND_HOST } from "./index.ts";

describe("legacy standalone server boundary", () => {
  it("is restricted to loopback while it remains available for compatibility", () => {
    expect(SERVER_BIND_HOST).toBe("127.0.0.1");
  });
});
