import { Fragment } from "react";
import { AgentIcon } from "../agent-icon";
import { Columns2, Rows2, Home, Layers, Palette, Terminal } from "../icons";
import type { WorkbenchCommand } from "./command-model";
const icons = {
  terminal: Terminal,
  home: Home,
  layout: Layers,
  columns: Columns2,
  rows: Rows2,
  theme: Palette,
};
/** Highlight literal query fragments without changing the accessible command name. */
function MatchText({ text, query }: { text: string; query: string }) {
  const terms = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!terms.length) return text;
  const pattern = new RegExp(
    `(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "gi",
  );
  return text
    .split(pattern)
    .map((part, index) =>
      index % 2 ? <mark key={index}>{part}</mark> : <Fragment key={index}>{part}</Fragment>,
    );
}
export function CommandResult({
  command,
  query,
  reasonId,
}: {
  command: WorkbenchCommand;
  query: string;
  reasonId: string;
}) {
  const Icon = icons[command.icon ?? "layout"];
  return (
    <>
      <span className="dw-command-icon">
        {command.agent ? <AgentIcon name={command.agent} /> : <Icon />}
      </span>
      <span className="dw-command-copy">
        <span>
          <MatchText text={command.label} query={query} />
        </span>
        {command.description && (
          <span className="dw-command-description">
            <MatchText text={command.description} query={query} />
          </span>
        )}
        {command.disabledReason && (
          <span className="dw-command-description" id={reasonId}>
            {command.disabledReason}
          </span>
        )}
      </span>
      {command.shortcut && <kbd className="dw-command-shortcut">{command.shortcut}</kbd>}
    </>
  );
}
