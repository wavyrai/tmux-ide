// Based on VibeTunnel (MIT) — github.com/amantus-ai/vibetunnel
import { spawn, type ChildProcess } from "node:child_process";
import { hostname } from "node:os";
import { logger } from "../log.ts";

const LOG = "mdns";
const SERVICE_TYPE = "_tmux-ide._tcp";

export class MDNSService {
  private dnsSdProcess: ChildProcess | null = null;
  private advertising = false;

  async startAdvertising(port: number, instanceName?: string): Promise<void> {
    if (this.advertising) {
      logger.warn(LOG, "mDNS already advertising");
      return;
    }

    const name = instanceName ?? hostname() ?? "tmux-ide";

    if (process.platform === "darwin") {
      await this.startDnsSd(name, port);
    } else {
      logger.info(LOG, "mDNS advertisement skipped (not macOS)");
    }
  }

  async stopAdvertising(): Promise<void> {
    if (!this.advertising) return;

    if (this.dnsSdProcess) {
      await new Promise<void>((resolve) => {
        const proc = this.dnsSdProcess!;
        this.dnsSdProcess = null;
        proc.once("exit", () => resolve());
        proc.kill();
        setTimeout(resolve, 1000);
      });
    }

    this.advertising = false;
    logger.info(LOG, "Stopped mDNS advertisement");
  }

  isActive(): boolean {
    return this.advertising;
  }

  private async startDnsSd(name: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const proc = spawn("dns-sd", ["-R", name, SERVICE_TYPE, "local.", String(port)], {
          stdio: ["ignore", "pipe", "pipe"],
        });

        proc.on("error", (err) => {
          logger.warn(LOG, `dns-sd error: ${err.message}`);
          if (!this.advertising) reject(err);
        });

        proc.stdout?.on("data", (data: Buffer) => {
          const msg = data.toString().trim();
          if (msg) logger.debug(LOG, `dns-sd: ${msg}`);
        });

        proc.stderr?.on("data", (data: Buffer) => {
          const msg = data.toString().trim();
          if (msg) logger.warn(LOG, `dns-sd stderr: ${msg}`);
        });

        proc.on("close", () => {
          this.advertising = false;
        });

        this.dnsSdProcess = proc;
        this.advertising = true;
        logger.info(LOG, `mDNS advertising: ${name} on port ${port} (${SERVICE_TYPE})`);

        // dns-sd stays running, resolve immediately
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  }
}

export const mdnsService = new MDNSService();
