import { createRoot } from "react-dom/client";

import "./global.css";

if (import.meta.env.DEV) {
  import("virtual:stylex:runtime");
}
// Decode the terminal font before measuring cells; interface text uses system fonts.
await Promise.allSettled([document.fonts.load('17px "Geist Mono Variable"')]);
const root = document.getElementById("root");
if (!root) {
  throw new Error("Workspace mount element is missing.");
}
const { default: App } = new URLSearchParams(location.search).has("design")
  ? await import("./design-workbench/design-workbench")
  : await import("./app");
createRoot(root).render(<App />);
