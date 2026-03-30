import type { JSX } from "solid-js";
import { render as solidRender } from "solid-js/web";

const BASE_CSS = `
:root {
  --line-height: 1.4em;
  --font-family: 'IBM Plex Mono', ui-monospace, monospace;
  --font-size: 13px;
}

body, #root {
  font-family: var(--font-family);
  font-size: var(--font-size);
  line-height: var(--line-height);
  background: rgb(19, 16, 16);
  color: rgb(232, 228, 228);
  margin: 0;
  padding: 0;
  -webkit-font-smoothing: antialiased;
}

* {
  box-sizing: border-box;
}

div {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

span {
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
}

input {
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
}

::-webkit-scrollbar {
  width: 8px;
}

::-webkit-scrollbar-track {
  background: rgb(25, 25, 35);
}

::-webkit-scrollbar-thumb {
  background: rgb(60, 60, 80);
  border-radius: 4px;
}

::-webkit-scrollbar-thumb:hover {
  background: rgb(80, 80, 100);
}
`;

let stylesInjected = false;

function injectBaseStyles(): void {
  if (stylesInjected) return;
  const style = document.createElement("style");
  style.textContent = BASE_CSS;
  document.head.appendChild(style);
  stylesInjected = true;
}

export function render(component: () => JSX.Element, _options?: unknown): void {
  injectBaseStyles();
  const root = document.getElementById("root") ?? document.body;
  solidRender(component, root);
}
