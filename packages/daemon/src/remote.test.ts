import { describe, it, expect } from "bun:test";
import { HQConfigSchema, RegistrationPayloadSchema } from "./lib/hq/types.ts";
import {
  buildRemoteServeScript,
  buildSshForwardArgs,
  parseSshConfigHosts,
  shellQuote,
  validateSshAlias,
} from "./ssh-remote.ts";

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

  describe("SSH remotes", () => {
    it("parses concrete SSH config hosts and skips wildcard entries", () => {
      expect(
        parseSshConfigHosts(`
          Host devbox-remote devbox-linux
            User dev

          Host *
            ServerAliveInterval 15

          Host !blocked *.example.com
            User ignored
        `),
      ).toEqual(["devbox-linux", "devbox-remote"]);
    });

    it("rejects SSH aliases with shell metacharacters", () => {
      expect(() => validateSshAlias("devbox-remote")).not.toThrow();
      expect(() => validateSshAlias("devbox-remote;touch /tmp/pwned")).toThrow();
      expect(() => validateSshAlias("-oProxyCommand=evil")).toThrow();
    });

    it("quotes remote paths before passing them to the remote shell", () => {
      expect(shellQuote("/home/dev/project alpha")).toBe("'/home/dev/project alpha'");
      expect(shellQuote("/home/dev/it's-here")).toBe("'/home/dev/it'\\''s-here'");
    });

    it("builds a remote serve script that binds only through localhost tunnel inputs", () => {
      const script = buildRemoteServeScript("/home/dev/project alpha", 6060);
      expect(script).toContain("cd '/home/dev/project alpha'");
      expect(script).toContain("tmux-ide __remote-serve --port 6060");
      expect(script).not.toContain("0.0.0.0");
    });

    it("builds SSH forwarding args without invoking a local shell", () => {
      expect(
        buildSshForwardArgs({ host: "devbox-remote", localPort: 49152, remotePort: 6060 }),
      ).toEqual([
        "-N",
        "-L",
        "127.0.0.1:49152:127.0.0.1:6060",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=15",
        // Dedicated connection: mux hand-off would drop the forward when the
        // -N client exits (ControlMaster + SSM setups).
        "-o",
        "ControlMaster=no",
        "-o",
        "ControlPath=none",
        "devbox-remote",
      ]);
    });
  });
});
