import { resolve } from "node:path";
import { IdeError } from "./lib/errors.ts";
import { TunnelManager } from "./lib/tunnels/manager.ts";
import { tunnelConfigSchema } from "./lib/tunnels/types.ts";
import type { TunnelConfig } from "./lib/tunnels/types.ts";

// Singleton per CLI invocation
let manager: TunnelManager | null = null;

function getManager(dir: string, session?: string): TunnelManager {
  if (!manager) {
    manager = new TunnelManager({ session, dir });
  }
  return manager;
}

async function resolveSession(): Promise<string | undefined> {
  try {
    const { readConfig } = await import("./lib/yaml-io.ts");
    const { config } = readConfig(process.cwd());
    return config.name ?? undefined;
  } catch {
    return undefined;
  }
}

async function resolveTunnelConfig(
  dir: string,
  overrides?: Partial<TunnelConfig>,
): Promise<TunnelConfig> {
  try {
    const { readConfig } = await import("./lib/yaml-io.ts");
    const { config } = readConfig(dir);
    if (config.tunnel) {
      const merged = { ...config.tunnel, ...overrides };
      return tunnelConfigSchema.parse(merged);
    }
  } catch {
    // no config
  }
  if (overrides?.provider) {
    return tunnelConfigSchema.parse(overrides);
  }
  throw new IdeError(
    'No tunnel configuration found. Add a "tunnel" section to ide.yml or pass --provider.',
    { code: "CONFIG_MISSING" },
  );
}

interface TunnelOptions {
  json?: boolean;
  sub?: string;
  args?: string[];
  values?: Record<string, string | boolean | undefined>;
}

export async function tunnelCommand(
  targetDir: string | null | undefined,
  opts: TunnelOptions,
): Promise<void> {
  const dir = resolve(targetDir ?? ".");
  const { json, sub } = opts;
  const session = await resolveSession();
  const mgr = getManager(dir, session);

  switch (sub) {
    case "start": {
      const provider = (opts.values?.provider as string) ?? undefined;
      const port = opts.values?.port ? parseInt(opts.values.port as string, 10) : undefined;
      const domain = (opts.values?.domain as string) ?? undefined;
      const authtoken = (opts.values?.authtoken as string) ?? undefined;

      const config = await resolveTunnelConfig(dir, {
        provider: provider as TunnelConfig["provider"],
        port,
        domain,
        authToken: authtoken,
      } as Partial<TunnelConfig>);

      const status = await mgr.start(config);
      if (json) {
        console.log(JSON.stringify(status));
      } else {
        if (status.publicUrl) {
          console.log(`Tunnel running: ${status.publicUrl}`);
        } else {
          console.log("Tunnel started (no public URL yet)");
        }
      }
      break;
    }

    case "stop": {
      await mgr.stop();
      if (json) {
        console.log(JSON.stringify({ ok: true }));
      } else {
        console.log("Tunnel stopped");
      }
      break;
    }

    case "status": {
      const status = await mgr.status();
      if (json) {
        console.log(JSON.stringify(status));
      } else {
        if (status.running) {
          console.log(`Tunnel: ${status.provider} — ${status.publicUrl ?? "starting..."}`);
        } else {
          console.log("Tunnel: not running");
        }
      }
      break;
    }

    case "url": {
      const url = await mgr.url();
      if (json) {
        console.log(JSON.stringify({ url }));
      } else {
        console.log(url ?? "No tunnel running");
      }
      break;
    }

    default:
      throw new IdeError(
        `Unknown tunnel subcommand: ${sub ?? "(none)"}\nUsage: tmux-ide tunnel start|stop|status|url`,
        { code: "USAGE" },
      );
  }
}
