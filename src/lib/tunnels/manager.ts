// Based on VibeTunnel (MIT) — github.com/amantus-ai/vibetunnel
import { execFileSync } from "node:child_process";
import type { TunnelService, TunnelStatus, TunnelConfig } from "./types.ts";
import { TailscaleServeServiceImpl } from "./tailscale.ts";
import { NgrokService } from "./ngrok.ts";
import { CloudflareService } from "./cloudflare.ts";
import { appendEvent } from "../event-log.ts";

export class TunnelManager {
  private service: TunnelService | null = null;
  private provider: TunnelConfig["provider"] | null = null;
  private session: string | null;
  private dir: string;

  constructor(opts: { session?: string; dir: string }) {
    this.session = opts.session ?? null;
    this.dir = opts.dir;
  }

  async start(config: TunnelConfig): Promise<TunnelStatus> {
    if (this.service) {
      const current = await this.service.status();
      if (current.running) {
        return current;
      }
    }

    this.provider = config.provider;
    this.service = this.createService(config);

    try {
      await this.service.start();
      const status = await this.service.status();

      if (status.publicUrl) {
        this.setTmuxVar(status.publicUrl);
      }

      this.emitEvent("info", `Tunnel started via ${config.provider}`, status.publicUrl);
      return status;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emitEvent("error", `Tunnel start failed: ${msg}`, null);
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.service) return;

    try {
      await this.service.stop();
      this.clearTmuxVar();
      this.emitEvent("info", `Tunnel stopped (${this.provider})`, null);
    } finally {
      this.service = null;
      this.provider = null;
    }
  }

  async status(): Promise<TunnelStatus & { provider: string | null }> {
    if (!this.service) {
      return { running: false, provider: null };
    }
    const s = await this.service.status();
    return { ...s, provider: this.provider };
  }

  async url(): Promise<string | null> {
    if (!this.service) return null;
    const s = await this.service.status();
    return s.publicUrl ?? null;
  }

  private createService(config: TunnelConfig): TunnelService {
    switch (config.provider) {
      case "tailscale":
        return new TailscaleServeServiceImpl();
      case "ngrok":
        return new NgrokService({
          port: config.port,
          authToken: config.authToken,
          domain: config.domain,
          region: config.region,
          startupTimeoutMs: config.startupTimeoutMs,
        });
      case "cloudflare":
        return new CloudflareService(config.port, {
          startupTimeoutMs: config.startupTimeoutMs,
        });
    }
  }

  private setTmuxVar(url: string): void {
    if (!this.session) return;
    try {
      execFileSync("tmux", ["set-option", "-t", this.session, "@tunnel_url", url], {
        stdio: "ignore",
      });
    } catch {
      // tmux not available or session gone
    }
  }

  private clearTmuxVar(): void {
    if (!this.session) return;
    try {
      execFileSync("tmux", ["set-option", "-t", this.session, "-u", "@tunnel_url"], {
        stdio: "ignore",
      });
    } catch {
      // tmux not available or session gone
    }
  }

  private emitEvent(
    level: "info" | "error",
    message: string,
    url: string | null | undefined,
  ): void {
    try {
      appendEvent(this.dir, {
        timestamp: new Date().toISOString(),
        type: level === "error" ? "error" : ("notify" as const),
        target: "tunnel",
        message: url ? `${message} — ${url}` : message,
      });
    } catch {
      // event log unavailable
    }
  }
}
