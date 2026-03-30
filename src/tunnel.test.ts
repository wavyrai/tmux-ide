import { describe, it, expect } from "bun:test";
import { tunnelConfigSchema } from "./lib/tunnels/types.ts";

describe("tunnel CLI", () => {
  describe("TunnelConfigSchema from types.ts", () => {
    it("validates tailscale config", () => {
      const result = tunnelConfigSchema.safeParse({
        provider: "tailscale",
        port: 4000,
      });
      expect(result.success).toBe(true);
    });

    it("validates ngrok config with all options", () => {
      const result = tunnelConfigSchema.safeParse({
        provider: "ngrok",
        port: 4000,
        authToken: "tok_123",
        domain: "my.ngrok.io",
        region: "us",
      });
      expect(result.success).toBe(true);
    });

    it("validates cloudflare config", () => {
      const result = tunnelConfigSchema.safeParse({
        provider: "cloudflare",
        port: 4000,
      });
      expect(result.success).toBe(true);
    });

    it("rejects unknown provider", () => {
      const result = tunnelConfigSchema.safeParse({
        provider: "unknown",
        port: 4000,
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing port", () => {
      const result = tunnelConfigSchema.safeParse({
        provider: "ngrok",
      });
      expect(result.success).toBe(false);
    });

    it("rejects negative port", () => {
      const result = tunnelConfigSchema.safeParse({
        provider: "ngrok",
        port: -1,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("TunnelConfigSchema in ide-config", () => {
    it("accepts tunnel field in IdeConfig", async () => {
      const { IdeConfigSchema } = await import("./schemas/ide-config.ts");
      const result = IdeConfigSchema.safeParse({
        rows: [{ panes: [{ title: "Shell" }] }],
        tunnel: {
          provider: "ngrok",
          auto_start: true,
          port: 4000,
          authtoken: "tok_abc",
        },
      });
      expect(result.success).toBe(true);
    });

    it("allows omitting tunnel", async () => {
      const { IdeConfigSchema } = await import("./schemas/ide-config.ts");
      const result = IdeConfigSchema.safeParse({
        rows: [{ panes: [{ title: "Shell" }] }],
      });
      expect(result.success).toBe(true);
    });
  });
});
