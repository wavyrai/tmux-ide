import { createRoot } from "react-dom/client";
import App from "./app";
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
createRoot(root).render(<App />);
