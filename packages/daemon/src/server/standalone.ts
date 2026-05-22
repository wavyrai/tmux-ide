import { parseArgs } from "node:util";
import { start } from "./index.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string" },
  },
});

const running = await start(values.port ? Number.parseInt(values.port, 10) : undefined);

const shutdown = async () => {
  await running.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
