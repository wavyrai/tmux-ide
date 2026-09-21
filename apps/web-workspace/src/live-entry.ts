import { config } from "zod";
import { installDevWebHost } from "../../desktop-renderer/src/runtime/install-dev-web-host";
import { installProductionWebHost } from "../../desktop-renderer/src/runtime/install-production-web-host";
config({ jitless: true });
if (import.meta.env.DEV) {
  await import("@vitejs/plugin-react/preamble");
  installDevWebHost();
} else if (import.meta.env.VITE_TMUX_IDE_PRODUCTION_WEB === "1") installProductionWebHost();
await import("./main");
