import { render } from "solid-js/web";
import { config } from "zod";
import { installCard5ProbeBootstrap } from "./runtime/card5-probe-bootstrap.ts";

// Zod's optional object-schema JIT uses Function construction before falling
// back under CSP. Disable it before loading application contracts so the
// renderer emits no blocked script evaluations under `script-src 'self'`.
config({ jitless: true });

// Card5's exact loopback URL installs diagnostics before App and terminal
// modules are evaluated, so Electron uses its one production navigation.
installCard5ProbeBootstrap(window.location.href);

// Electron publishes `window.tmuxIdeHost` through preload. A plain browser gets
// the same renderer contract from either the opt-in development gateway or the
// capability-bearing packaged loopback server. An arbitrary production page
// has neither bridge nor capability and remains preview-only.
if (import.meta.env.DEV) {
  const { installDevWebHost } = await import("./runtime/install-dev-web-host.ts");
  installDevWebHost();
} else if (import.meta.env.VITE_TMUX_IDE_PRODUCTION_WEB === "1") {
  const { installProductionWebHost } = await import("./runtime/install-production-web-host.ts");
  installProductionWebHost();
}

const { App } = await import("./App.tsx");

const root = document.getElementById("root");
if (!root) throw new Error("desktop renderer root is missing");

render(() => <App />, root);
