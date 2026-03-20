import { render } from "solid-js/web";
import { createSignal, createEffect, onCleanup, Show } from "solid-js";
import { Overview } from "./views/overview.tsx";
import { ProjectView } from "./views/project.tsx";
import type { SessionOverview, ProjectDetail } from "./types.ts";

type View = { kind: "overview" } | { kind: "project"; name: string };

function App() {
  const [view, setView] = createSignal<View>({ kind: "overview" });
  const [sessions, setSessions] = createSignal<SessionOverview[]>([]);
  const [project, setProject] = createSignal<ProjectDetail | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  async function fetchSessions() {
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSessions(data.sessions ?? []);
      setError(null);
    } catch (e) {
      setError(`Cannot connect to API: ${(e as Error).message}`);
    }
  }

  async function fetchProject(name: string) {
    try {
      const res = await fetch(`/api/project/${encodeURIComponent(name)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setProject(data);
      setError(null);
    } catch (e) {
      setError(`Cannot load project: ${(e as Error).message}`);
    }
  }

  // Poll based on current view
  createEffect(() => {
    const v = view();
    if (v.kind === "overview") {
      fetchSessions();
    } else {
      fetchProject(v.name);
    }
    const interval = setInterval(() => {
      if (v.kind === "overview") {
        fetchSessions();
      } else {
        fetchProject(v.name);
      }
    }, 2000);
    onCleanup(() => clearInterval(interval));
  });

  // Handle browser back/forward
  function handlePopState() {
    const hash = window.location.hash;
    if (hash.startsWith("#/project/")) {
      const name = decodeURIComponent(hash.slice("#/project/".length));
      setView({ kind: "project", name });
    } else {
      setView({ kind: "overview" });
    }
  }

  window.addEventListener("popstate", handlePopState);
  onCleanup(() => window.removeEventListener("popstate", handlePopState));

  // Navigate on initial load if hash is set
  if (window.location.hash.startsWith("#/project/")) {
    const name = decodeURIComponent(window.location.hash.slice("#/project/".length));
    setView({ kind: "project", name });
  }

  function navigateToProject(name: string) {
    window.location.hash = `#/project/${encodeURIComponent(name)}`;
    setView({ kind: "project", name });
  }

  function navigateToOverview() {
    window.location.hash = "";
    setView({ kind: "overview" });
  }

  return (
    <div style={{ "min-height": "100vh", background: "var(--bg-base)", color: "var(--text-primary)" }}>
      {/* Connection error banner */}
      <Show when={error()}>
        <div style={{
          background: "rgba(232,125,125,0.08)",
          "border-bottom": "1px solid rgba(232,125,125,0.15)",
          padding: "4px 16px",
          color: "var(--error)",
          "font-size": "11px",
          "text-align": "center",
        }}>
          {error()}
        </div>
      </Show>

      <Show when={view().kind === "overview"}>
        <Overview sessions={sessions()} onSelectProject={navigateToProject} />
      </Show>

      <Show when={view().kind === "project" && project()}>
        <ProjectView project={project()!} onBack={navigateToOverview} />
      </Show>

      <Show when={view().kind === "project" && !project() && !error()}>
        <div style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "center",
          "min-height": "100vh",
        }}>
          <div style={{ color: "var(--text-muted)", "font-size": "12px" }}>Loading project...</div>
        </div>
      </Show>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  render(() => <App />, root);
}
