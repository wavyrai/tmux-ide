import { resolve } from "node:path";
import { IdeError } from "./lib/errors.ts";
import { HQClient } from "./lib/hq/client.ts";
import { HQConfigSchema } from "./lib/hq/types.ts";

interface RemoteOptions {
  json?: boolean;
  sub?: string;
  args?: string[];
  values?: Record<string, string | boolean | undefined>;
}

async function loadHQConfig(dir: string) {
  try {
    const { readConfig } = await import("./lib/yaml-io.ts");
    const { config } = readConfig(dir);
    if (config.hq) {
      return HQConfigSchema.parse(config.hq);
    }
  } catch {
    // config not readable
  }
  return null;
}

export async function remoteCommand(
  targetDir: string | null | undefined,
  opts: RemoteOptions,
): Promise<void> {
  const dir = resolve(targetDir ?? ".");
  const { json, sub } = opts;

  switch (sub) {
    case "register": {
      const hqConfig = await loadHQConfig(dir);
      if (!hqConfig || hqConfig.role !== "remote") {
        throw new IdeError(
          'HQ config not found or role is not "remote". Add hq section to ide.yml.',
          {
            code: "CONFIG_MISSING",
          },
        );
      }
      if (!hqConfig.hq_url) {
        throw new IdeError("hq_url is required for remote registration", {
          code: "CONFIG_MISSING",
        });
      }

      const client = new HQClient({
        hqUrl: hqConfig.hq_url,
        secret: hqConfig.secret ?? "",
        machineName: hqConfig.machine_name ?? (await import("node:os")).hostname(),
        remoteUrl: (opts.values?.url as string) ?? `http://localhost:4000`,
        heartbeatInterval: hqConfig.heartbeat_interval,
      });

      await client.register();

      if (json) {
        console.log(
          JSON.stringify({
            ok: true,
            remoteId: client.getRemoteId(),
            name: client.getName(),
          }),
        );
      } else {
        console.log(`Registered with HQ as ${client.getName()} (${client.getRemoteId()})`);
      }

      // Keep alive until SIGINT/SIGTERM
      await new Promise<void>((resolve) => {
        const shutdown = async () => {
          await client.destroy();
          resolve();
        };
        process.once("SIGINT", () => void shutdown());
        process.once("SIGTERM", () => void shutdown());
      });
      break;
    }

    case "machines": {
      const hqConfig = await loadHQConfig(dir);
      const hqUrl =
        (opts.values?.["hq-url"] as string) ?? hqConfig?.hq_url ?? "http://localhost:4000";

      try {
        const res = await fetch(`${hqUrl}/api/hq/machines`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        if (json) {
          console.log(JSON.stringify(data));
        } else {
          const machines = (data as { machines: Array<{ id: string; name: string; url: string }> })
            .machines;
          if (machines.length === 0) {
            console.log("No remote machines registered");
          } else {
            for (const m of machines) {
              console.log(`  ${m.name} — ${m.url} (${m.id})`);
            }
          }
        }
      } catch (err) {
        throw new IdeError(
          `Failed to query HQ: ${err instanceof Error ? err.message : String(err)}`,
          {
            code: "HQ_ERROR",
          },
        );
      }
      break;
    }

    case "status": {
      const hqConfig = await loadHQConfig(dir);

      if (json) {
        console.log(
          JSON.stringify({
            configured: !!hqConfig,
            role: hqConfig?.role ?? null,
            hq_url: hqConfig?.hq_url ?? null,
            machine_name: hqConfig?.machine_name ?? null,
          }),
        );
      } else {
        if (!hqConfig) {
          console.log("HQ: not configured");
        } else {
          console.log(`HQ role: ${hqConfig.role}`);
          if (hqConfig.hq_url) console.log(`HQ URL: ${hqConfig.hq_url}`);
          if (hqConfig.machine_name) console.log(`Machine: ${hqConfig.machine_name}`);
        }
      }
      break;
    }

    default:
      throw new IdeError(
        `Unknown remote subcommand: ${sub ?? "(none)"}\nUsage: tmux-ide remote register|machines|status`,
        { code: "USAGE" },
      );
  }
}
