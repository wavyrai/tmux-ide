import { render } from "solid-js/web";

import { App } from "./App.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("desktop renderer root is missing");

render(() => <App />, root);
