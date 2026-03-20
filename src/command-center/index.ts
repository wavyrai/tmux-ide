import { serve } from "@hono/node-server";
import { createApp } from "./server.ts";

export interface CommandCenterOptions {
  port?: number;
}

export async function startCommandCenter(options: CommandCenterOptions = {}): Promise<void> {
  const port = options.port ?? 4000;
  const app = createApp();

  console.log(`Command Center starting on http://localhost:${port}`);

  serve({ fetch: app.fetch, port });
}
