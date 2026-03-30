import { createServer, type Server } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { createApp, type CreateAppOptions } from "./server.ts";
import { AuthService } from "../lib/auth/auth-service.ts";
import type { AuthConfig } from "../lib/auth/types.ts";

export interface CommandCenterOptions {
  port?: number;
  hostname?: string;
  authService?: AuthService;
  authConfig?: AuthConfig;
}

export async function startCommandCenter(options: CommandCenterOptions = {}): Promise<Server> {
  const port = options.port ?? 4000;
  const hostname = options.hostname ?? "0.0.0.0";
  const appOpts: CreateAppOptions = {};
  if (options.authService) appOpts.authService = options.authService;
  if (options.authConfig) appOpts.authConfig = options.authConfig;
  const app = createApp(appOpts);

  const listener = getRequestListener(app.fetch);
  const server = createServer(listener);

  return new Promise((resolve) => {
    server.listen(port, hostname, () => {
      console.log(`Command Center API on http://${hostname}:${port}`);
      resolve(server);
    });
  });
}
