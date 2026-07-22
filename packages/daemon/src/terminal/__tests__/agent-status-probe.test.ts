import { describe, expect, it } from "vitest";
import type { AgentManifest } from "../../tui/detect/manifest.ts";
import type { ProcEntry } from "../../tui/detect/process-tree.ts";
import { createTmuxAgentStatusProbe } from "../attachments/agent-status-probe.ts";

const AGENT_FIELD_SEPARATOR = "|tmux-ide-agent-field-v1|";
const AGENT_LINE_SENTINEL = "tmux-ide-agent-v1";

function optionsLine(
  paneId: string,
  fields: {
    state?: string;
    statusText?: string;
    displayName?: string;
    hint?: string;
    pid?: string;
  } = {},
): string {
  return [
    paneId,
    fields.state ?? "",
    fields.statusText ?? "",
    fields.displayName ?? "",
    fields.hint ?? "",
    fields.pid ?? "0",
    AGENT_LINE_SENTINEL,
  ].join(AGENT_FIELD_SEPARATOR);
}

/** A tuned manifest that reports `blocked` when the screen contains "PROMPT?". */
const CLAUDE_MANIFEST: AgentManifest = {
  id: "claude",
  commands: ["claude"],
  states: { blocked: { any: [{ region: "bottom", contains: "PROMPT?" }] } },
  confidence: "tuned",
};
const SHELL_MANIFEST: AgentManifest = { id: "shell", commands: ["sh", "bash", "zsh"], states: {} };
const MANIFESTS = [CLAUDE_MANIFEST, SHELL_MANIFEST];

const NOW = 2_000_000;

describe("createTmuxAgentStatusProbe", () => {
  it("returns no facts and issues no tmux calls for an empty pane set", () => {
    const runs: string[][] = [];
    const probe = createTmuxAgentStatusProbe({
      run: (argv) => {
        runs.push([...argv]);
        return "";
      },
    });
    const facts = probe.probe({ sessionId: "$1", panes: [], nowSec: NOW });
    expect(facts.size).toBe(0);
    expect(runs).toEqual([]);
  });

  it("takes fresh authority and never captures the pane", () => {
    const captures: string[] = [];
    let processTableReads = 0;
    const probe = createTmuxAgentStatusProbe({
      run: (argv) =>
        argv[0] === "list-panes"
          ? optionsLine("%3", {
              state: `working:${NOW}`,
              statusText: "building",
              displayName: "Fable",
              pid: "4242",
            }) + "\n"
          : "",
      capture: (paneId) => {
        captures.push(paneId);
        return "";
      },
      readProcessTable: () => {
        processTableReads += 1;
        return [];
      },
      manifests: MANIFESTS,
    });

    const facts = probe.probe({
      sessionId: "$1",
      panes: [{ runtimePaneId: "%3", currentCommand: "claude", title: "Agent" }],
      nowSec: NOW,
    });

    expect(facts.get("%3")).toEqual({
      agentStateRaw: `working:${NOW}`,
      agentStatusTextRaw: "building",
      agentDisplayNameRaw: "Fable",
      agentScrapeState: null,
    });
    // Fresh authority skips the scrape entirely.
    expect(captures).toEqual([]);
    expect(processTableReads).toBe(0);
  });

  it("scrapes a recognized agent when authority is absent or stale", () => {
    const table: ProcEntry[] = [{ pid: 4242, ppid: 1, command: "node /x/bin/claude --foo" }];
    let processTableReads = 0;
    const probe = createTmuxAgentStatusProbe({
      run: (argv) =>
        argv[0] === "list-panes"
          ? [
              // stale working -> scrape
              optionsLine("%3", { state: `working:${NOW - 700}`, pid: "4242" }),
              // no authority at all -> scrape
              optionsLine("%4", { pid: "4242" }),
            ].join("\n") + "\n"
          : "",
      capture: () => "line one\nPROMPT? waiting\n",
      readProcessTable: () => {
        processTableReads += 1;
        return table;
      },
      manifests: MANIFESTS,
    });

    const facts = probe.probe({
      sessionId: "$1",
      panes: [
        { runtimePaneId: "%3", currentCommand: "node", title: "Agent" },
        { runtimePaneId: "%4", currentCommand: "node", title: "Agent" },
      ],
      nowSec: NOW,
    });

    expect(facts.get("%3")).toMatchObject({
      agentScrapeState: "blocked",
      agentStateRaw: `working:${NOW - 700}`,
    });
    expect(facts.get("%4")).toMatchObject({ agentScrapeState: "blocked", agentStateRaw: null });
    // The `ps` read is shared across both scraped panes — taken at most once.
    expect(processTableReads).toBe(1);
  });

  it("classifies an unrecognized / shell pane as unknown without capturing", () => {
    const captures: string[] = [];
    const probe = createTmuxAgentStatusProbe({
      run: (argv) => (argv[0] === "list-panes" ? optionsLine("%9", { pid: "10" }) + "\n" : ""),
      capture: (paneId) => {
        captures.push(paneId);
        return "";
      },
      readProcessTable: () => [{ pid: 10, ppid: 1, command: "zsh" }],
      manifests: MANIFESTS,
    });

    const facts = probe.probe({
      sessionId: "$1",
      panes: [{ runtimePaneId: "%9", currentCommand: "zsh", title: "Shell" }],
      nowSec: NOW,
    });

    expect(facts.get("%9")).toMatchObject({ agentScrapeState: "unknown" });
    // A shell/no-match pane never triggers a capture round-trip.
    expect(captures).toEqual([]);
  });

  it("degrades cleanly when the option query fails", () => {
    const probe = createTmuxAgentStatusProbe({
      run: () => null,
      readProcessTable: () => [],
      manifests: MANIFESTS,
    });
    const facts = probe.probe({
      sessionId: "$1",
      panes: [{ runtimePaneId: "%3", currentCommand: "sh", title: "Shell" }],
      nowSec: NOW,
    });
    // No options + shell command -> unknown, no throw.
    expect(facts.get("%3")).toMatchObject({
      agentStateRaw: null,
      agentStatusTextRaw: null,
      agentDisplayNameRaw: null,
      agentScrapeState: "unknown",
    });
  });
});
