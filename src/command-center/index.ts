import { createServer, type Server } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { createApp } from "./server.ts";

export interface CommandCenterOptions {
  port?: number;
  hostname?: string;
}

export async function startCommandCenter(options: CommandCenterOptions = {}): Promise<Server> {
  const port = options.port ?? 4000;
  const hostname = options.hostname ?? "0.0.0.0";
  const app = createApp();

  const listener = getRequestListener(app.fetch);
  const server = createServer(listener);

  return new Promise((resolve) => {
    server.listen(port, hostname, () => {
      console.log(`Command Center API on http://${hostname}:${port}`);
      resolve(server);
    });
  });
}
