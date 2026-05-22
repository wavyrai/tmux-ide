import { describe, expect, it } from "bun:test";
import { generateAuthToken } from "./auth-token.ts";

describe("generateAuthToken", () => {
  it("generates a 32-byte URL-safe base64url token", () => {
    const token = generateAuthToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("generates unique tokens", () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateAuthToken()));

    expect(tokens.size).toBe(100);
  });
});
