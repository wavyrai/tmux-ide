import { parseArgs } from "node:util";

import { loadAppConfig, type AppConfig } from "../../../lib/app-config.ts";
import type { OpenTuiApplicationShellConnection } from "../application-shell-daemon-connection.ts";
import { tuiPerfMark } from "./application-performance-log.ts";

export interface ApplicationArgs {
  readonly target: string | null;
}

export interface ApplicationConfig {
  readonly app: AppConfig;
  readonly target: string | null;
}

export interface StartApplicationRootOptions {
  readonly initialPreparation?: {
    readonly sessionName: string;
    readonly preparedConnection: Promise<OpenTuiApplicationShellConnection | null>;
    readonly diagnosticHandoff?: {
      readonly attach: (
        sink: (phase: string, details: Readonly<Record<string, unknown>>) => void,
      ) => void;
      readonly retire: () => void;
    } | null;
  };
}

export const parseApplicationArgs = (argv: readonly string[]): ApplicationArgs => {
  const parsed = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: false,
    options: { target: { type: "string" } },
  });
  const positional = parsed.positionals.find((value) => value !== "app") ?? null;
  const target = typeof parsed.values.target === "string" ? parsed.values.target : positional;
  return Object.freeze({ target: target && target !== "home" ? target : null });
};

export async function loadApplicationConfig(args: ApplicationArgs): Promise<ApplicationConfig> {
  tuiPerfMark("config-load-start", { requestedTarget: args.target });
  // Home discovery is daemon-authoritative and remains live after mount. The
  // immutable bootstrap config only carries an explicit user target.
  tuiPerfMark("config-load-end", { target: args.target });
  return Object.freeze({ app: loadAppConfig(), target: args.target });
}
