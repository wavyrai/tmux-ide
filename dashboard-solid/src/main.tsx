/* @refresh reload */
import { render } from "solid-js/web";
import { Router, Route } from "@solidjs/router";
import { App } from "./App";
import { WidgetsRoute } from "./routes/v2/widgets";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found in index.html");

render(
  () => (
    <Router root={App}>
      {/* Bare-minimum routes for G16-P1. /v2/project/[name] lands in G16-P2. */}
      <Route path="/" component={WidgetsRoute} />
      <Route path="/v2" component={WidgetsRoute} />
      <Route path="/v2/widgets" component={WidgetsRoute} />
    </Router>
  ),
  root,
);
