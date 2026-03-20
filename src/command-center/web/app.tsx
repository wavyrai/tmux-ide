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

  // Poll sessions every 2 seconds
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

    // Fetch immediately
    if (v.kind === "overview") {
      fetchSessions();
    } else {
      fetchProject(v.name);
    }

    // Set up polling
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
    <div class="min-h-screen bg-gray-950 text-gray-100">
      {/* Connection error banner */}
      <Show when={error()}>
        <div class="bg-red-400/10 border-b border-red-400/20 px-6 py-2 text-red-400 text-sm text-center">
          {error()}
        </div>
      </Show>

      <Show when={view().kind === "overview"}>
        <Overview sessions={sessions()} onSelectProject={navigateToProject} />
      </Show>

      <Show when={view().kind === "project" && project()}>
        <ProjectView project={project()!} onBack={navigateToOverview} />
      </Show>

      {/* Loading state for project view before data arrives */}
      <Show when={view().kind === "project" && !project() && !error()}>
        <div class="flex items-center justify-center min-h-screen">
          <div class="text-gray-500">Loading project...</div>
        </div>
      </Show>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  render(() => <App />, root);
}
