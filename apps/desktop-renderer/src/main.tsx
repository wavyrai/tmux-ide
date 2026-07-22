import { render } from "solid-js/web";
import { config } from "zod";

// Zod's optional object-schema JIT uses Function construction before falling
// back under CSP. Disable it before loading application contracts so the
// renderer emits no blocked script evaluations under `script-src 'self'`.
config({ jitless: true });

const { App } = await import("./App.tsx");

const root = document.getElementById("root");
if (!root) throw new Error("desktop renderer root is missing");

render(() => <App />, root);
