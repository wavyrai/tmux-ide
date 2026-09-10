import { AgentIcon } from "./agent-icon";
import { useState } from "react";
import { MarkdownClient as Markdown } from "@comark/react";
import type { Pane } from "@superlogical/shared/model";
import { Terminal, X } from "./icons";
const documents: Record<string, string> = {
  "README.md":
    "# One workspace. Every machine.\n\nKeep **agents, terminals and context** together, wherever the work runs.\n\n## This design demo\n\n- Compact terminal panes with agent presence\n- Local and remote machines in one sidebar\n- Markdown, files and activity as native widgets\n\n> Widgets belong beside your terminals, not in a separate dashboard.\n\n## Quick start\n\n```sh\ntmux-ide app --ssh mini\n```\n\n| Surface | State |\n| --- | --- |\n| Terminal | Interactive fixture |\n| Markdown | Comark renderer |\n| Remote | Sample data |\n\n[Comark source](https://github.com/comarkdown/comark)",
  "architecture.md":
    "# Shared content, native renderers\n\nComark produces a **serializable document tree**.\n\n1. Parse markdown once.\n2. Render that tree in React for the web.\n3. Render it as ANSI or native OpenTUI components for the terminal.\n\n## Next validation\n\n- Width-aware wrapping and Unicode\n- Theme tokens and text selection\n- Streaming updates without full reparsing\n\n> This is a demo, not a daemon-connected workspace.",
  "package.json":
    '# Package preview\n\n```json\n{\n  "name": "tmux-ide",\n  "widgets": ["markdown", "files", "activity"]\n}\n```',
};
export function WidgetPane({
  pane,
  focused,
  onFocus,
  onClose,
}: {
  pane: Pane;
  focused: boolean;
  onFocus: () => void;
  onClose: () => void;
}) {
  const [file, setFile] = useState("README.md");
  const [source, setSource] = useState(false);
  const [filter, setFilter] = useState("All");
  const activity = [
    {
      agent: "Claude Code",
      machine: "Local",
      kind: "READ",
      text: "Read terminal output",
      time: "12:41:08",
    },
    {
      agent: "Codex",
      machine: "mini",
      kind: "INPUT",
      text: "Sent input to test runner",
      time: "12:41:04",
    },
    {
      agent: "Claude Code",
      machine: "Local",
      kind: "DONE",
      text: "Completed workspace review",
      time: "12:40:51",
    },
  ];
  return (
    <section
      className="widget-pane"
      data-focused={focused}
      onFocusCapture={onFocus}
      onPointerDown={onFocus}
      aria-label={`${pane.widget} widget`}
    >
      <header className="widget-header">
        <span className="pane-focus-marker" data-focused={focused}>
          {focused ? "●" : "○"}
        </span>
        <Terminal size={13} />
        <strong>{pane.widget}</strong>
        <span className="widget-demo">DEMO</span>
        <button aria-label={`Close ${pane.widget} widget`} onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      {pane.widget === "Activity" ? (
        <>
          <div className="widget-tools">
            {["All", "Local", "mini"].map((f) => (
              <button aria-pressed={filter === f} onClick={() => setFilter(f)} key={f}>
                {f}
              </button>
            ))}
          </div>
          <div className="activity-list">
            {activity
              .filter((a) => filter === "All" || a.machine === filter)
              .map((a) => (
                <article key={a.time}>
                  <div>
                    <AgentIcon name={a.agent} size={14} />
                    <strong style={{ flex: 1 }}>{a.agent}</strong>
                    <span className="pane-interaction">{a.kind}</span>
                  </div>
                  <p>{a.text}</p>
                  <small>
                    {a.machine} · {a.time}
                  </small>
                </article>
              ))}
          </div>
        </>
      ) : (
        <>
          <div className="widget-tools">
            {Object.keys(documents).map((f) => (
              <button key={f} aria-pressed={file === f} onClick={() => setFile(f)}>
                {f}
              </button>
            ))}
            <button
              className="source-toggle"
              aria-pressed={source}
              onClick={() => setSource(!source)}
            >
              {source ? "Preview" : "Source"}
            </button>
          </div>
          <div className="markdown-body">
            {source ? <pre>{documents[file]}</pre> : <Markdown>{documents[file]}</Markdown>}
          </div>
        </>
      )}
    </section>
  );
}
