/* @refresh reload */
import { lazy } from "solid-js";
import { render } from "solid-js/web";
import { Router, Route, Navigate } from "@solidjs/router";
import { App } from "./App";
import { WidgetsRoute } from "./routes/widgets";
import ProjectsHomeRoute from "./routes/index";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found in index.html");

// Heavy routes are lazy-loaded — the project shell pulls in chat-solid,
// xterm, v2-solid-widgets, and the widget mirror + standalone terminal
// pull in xterm. Keeping them out of the home-route bundle keeps
// /widgets light.
const ProjectRoute = lazy(() => import("./routes/project/[name]"));
const SetupRoute = lazy(() => import("./routes/setup"));
const SettingsRoute = lazy(() => import("./routes/settings"));
const TerminalRoute = lazy(() => import("./routes/terminal/[id]"));
const WidgetRoute = lazy(() => import("./routes/widget/[name]"));

render(
  () => (
    <Router root={App}>
      <Route path="/" component={ProjectsHomeRoute} />
      <Route path="/widgets" component={WidgetsRoute} />
      <Route path="/setup" component={SetupRoute} />
      <Route path="/settings" component={SettingsRoute} />
      <Route path="/project/:name" component={ProjectRoute} />
      <Route path="/terminal/:id" component={TerminalRoute} />
      <Route path="/widget/:name" component={WidgetRoute} />

      {/* Legacy /v2/* redirects. The /v2/ prefix existed while the React
          dashboard ran alongside the Solid one; v1 has been deleted in
          G16-P4. Keep these for a release or two so bookmarks survive. */}
      <Route path="/v2" component={() => <Navigate href="/" />} />
      <Route path="/v2/widgets" component={() => <Navigate href="/widgets" />} />
      <Route path="/v2/setup" component={() => <Navigate href="/setup" />} />
      <Route path="/v2/settings" component={() => <Navigate href="/settings" />} />
      <Route
        path="/v2/project/:name"
        component={(props) => <Navigate href={`/project/${props.params.name}`} />}
      />
      <Route
        path="/v2/terminal/:id"
        component={(props) => <Navigate href={`/terminal/${props.params.id}`} />}
      />
      <Route
        path="/v2/widget/:name"
        component={(props) => <Navigate href={`/widget/${props.params.name}`} />}
      />
    </Router>
  ),
  root,
);
