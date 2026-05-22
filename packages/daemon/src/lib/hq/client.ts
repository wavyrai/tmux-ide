// Based on VibeTunnel (MIT) — github.com/amantus-ai/vibetunnel
import * as crypto from "node:crypto";
import { logger } from "../log.ts";
import type { RegistrationPayload } from "./types.ts";

const LOG = "hq-client";

export interface HQClientConfig {
  hqUrl: string;
  secret: string;
  machineName: string;
  remoteUrl: string;
  bearerToken?: string;
  heartbeatInterval?: number;
}

export class HQClient {
  private readonly hqUrl: string;
  private readonly remoteId: string;
  private readonly machineName: string;
  private readonly secret: string;
  private readonly remoteUrl: string;
  private readonly bearerToken: string;
  private readonly heartbeatInterval: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private backoffMs = 1000;
  private destroyed = false;

  constructor(config: HQClientConfig) {
    this.hqUrl = config.hqUrl;
    this.remoteId = crypto.randomUUID();
    this.machineName = config.machineName;
    this.secret = config.secret;
    this.remoteUrl = config.remoteUrl;
    this.bearerToken = config.bearerToken ?? crypto.randomBytes(32).toString("hex");
    this.heartbeatInterval = config.heartbeatInterval ?? 15_000;

    logger.debug(LOG, "HQ client initialized", {
      hqUrl: this.hqUrl,
      machineName: this.machineName,
      remoteId: this.remoteId,
    });
  }

  private basicAuth(): string {
    return `Basic ${Buffer.from(this.secret).toString("base64")}`;
  }

  async register(): Promise<void> {
    logger.info(LOG, `Registering with HQ at ${this.hqUrl}`);

    const payload: RegistrationPayload = {
      id: this.remoteId,
      name: this.machineName,
      url: this.remoteUrl,
      token: this.bearerToken,
    };

    const response = await fetch(`${this.hqUrl}/api/hq/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.basicAuth(),
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Registration failed (${response.status}): ${text}`);
    }

    logger.info(LOG, `Registered: ${this.machineName} (${this.remoteId})`);
    this.backoffMs = 1000;
    this.startHeartbeat();
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(), this.heartbeatInterval);
  }

  private async sendHeartbeat(): Promise<void> {
    if (this.destroyed) return;
    try {
      const res = await fetch(`${this.hqUrl}/api/hq/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.basicAuth(),
        },
        body: JSON.stringify({
          id: this.remoteId,
          name: this.machineName,
          url: this.remoteUrl,
          token: this.bearerToken,
        }),
      });
      if (res.ok) {
        this.backoffMs = 1000;
        logger.debug(LOG, "Heartbeat OK");
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      logger.warn(LOG, `Heartbeat failed, backoff ${this.backoffMs}ms`, {
        error: String(err),
      });
      this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    logger.info(LOG, `Deregistering from HQ: ${this.machineName} (${this.remoteId})`);
    try {
      await fetch(`${this.hqUrl}/api/hq/machines/${this.remoteId}`, {
        method: "DELETE",
        headers: { Authorization: this.basicAuth() },
      });
    } catch {
      // Best-effort during shutdown
    }
  }

  getRemoteId(): string {
    return this.remoteId;
  }

  getToken(): string {
    return this.bearerToken;
  }

  getName(): string {
    return this.machineName;
  }
}
