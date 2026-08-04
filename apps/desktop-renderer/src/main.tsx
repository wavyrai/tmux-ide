import { render } from "solid-js/web";
import { config } from "zod";

// Zod's optional object-schema JIT uses Function construction before falling
// back under CSP. Disable it before loading application contracts so the
// renderer emits no blocked script evaluations under `script-src 'self'`.
config({ jitless: true });

// Development-only, opt-in, loopback-only: publishes `window.tmuxIdeHost` when
// no Electron preload did and the developer explicitly asked for it. The
// `import.meta.env.DEV` guard is a build-time constant, so the whole host is
// eliminated from every production bundle rather than merely disabled in it.
// See runtime/dev-web-host-config.ts for the activation policy.
if (import.meta.env.DEV) {
  const { installDevWebHost } = await import("./runtime/install-dev-web-host.ts");
  installDevWebHost();
}

const { App } = await import("./App.tsx");

const root = document.getElementById("root");
if (!root) throw new Error("desktop renderer root is missing");

render(() => <App />, root);
