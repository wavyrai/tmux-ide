import { describe, it, expect } from "bun:test";
import { HQConfigSchema, RegistrationPayloadSchema } from "./lib/hq/types.ts";

describe("remote CLI contracts", () => {
  describe("HQConfigSchema", () => {
    it("accepts valid HQ config", () => {
      const result = HQConfigSchema.safeParse({
        enabled: true,
        role: "hq",
      });
      expect(result.success).toBe(true);
    });

    it("accepts valid remote config", () => {
      const result = HQConfigSchema.safeParse({
        enabled: true,
        role: "remote",
        hq_url: "https://hq.example.com",
        secret: "s3cr3t",
        heartbeat_interval: 10000,
        machine_name: "dev-1",
      });
      expect(result.success).toBe(true);
    });

    it("rejects invalid role", () => {
      const result = HQConfigSchema.safeParse({
        enabled: true,
        role: "invalid",
      });
      expect(result.success).toBe(false);
    });

    it("rejects heartbeat_interval below 1000", () => {
      const result = HQConfigSchema.safeParse({
        enabled: true,
        role: "hq",
        heartbeat_interval: 500,
      });
      expect(result.success).toBe(false);
    });

    it("defaults heartbeat_interval to 15000", () => {
      const result = HQConfigSchema.parse({
        enabled: true,
        role: "hq",
      });
      expect(result.heartbeat_interval).toBe(15000);
    });

    it("defaults enabled to false", () => {
      const result = HQConfigSchema.parse({
        role: "remote",
      });
      expect(result.enabled).toBe(false);
    });
  });

  describe("RegistrationPayloadSchema", () => {
    it("accepts valid registration payload", () => {
      const result = RegistrationPayloadSchema.safeParse({
        id: "abc-123",
        name: "dev-box",
        url: "https://dev.example.com",
        token: "tok-xyz",
      });
      expect(result.success).toBe(true);
    });

    it("rejects empty id", () => {
      const result = RegistrationPayloadSchema.safeParse({
        id: "",
        name: "dev",
        url: "https://dev.example.com",
        token: "tok",
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid URL", () => {
      const result = RegistrationPayloadSchema.safeParse({
        id: "m1",
        name: "dev",
        url: "not-a-url",
        token: "tok",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("IdeConfigSchema with hq field", () => {
    it("accepts hq config in ide.yml schema", async () => {
      const { IdeConfigSchema } = await import("./schemas/ide-config.ts");
      const result = IdeConfigSchema.safeParse({
        rows: [{ panes: [{ title: "Shell" }] }],
        hq: {
          enabled: true,
          role: "remote",
          hq_url: "https://hq.example.com",
          secret: "mykey",
          machine_name: "laptop",
        },
      });
      expect(result.success).toBe(true);
    });

    it("allows omitting hq", async () => {
      const { IdeConfigSchema } = await import("./schemas/ide-config.ts");
      const result = IdeConfigSchema.safeParse({
        rows: [{ panes: [{ title: "Shell" }] }],
      });
      expect(result.success).toBe(true);
    });
  });
});
