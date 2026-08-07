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
      agentKind: "claude",
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
      agentKind: "claude",
      agentScrapeState: "blocked",
      agentStateRaw: `working:${NOW - 700}`,
    });
    expect(facts.get("%4")).toMatchObject({
      agentKind: "claude",
      agentScrapeState: "blocked",
      agentStateRaw: null,
    });
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

    expect(facts.get("%9")).toMatchObject({ agentKind: null, agentScrapeState: "unknown" });
    // A shell/no-match pane never triggers a capture round-trip.
    expect(captures).toEqual([]);
  });

  it("reuses a cached scrape verdict inside the TTL window instead of re-capturing", () => {
    const table: ProcEntry[] = [{ pid: 4242, ppid: 1, command: "node /x/bin/claude" }];
    const captures: string[] = [];
    let processTableReads = 0;
    const probe = createTmuxAgentStatusProbe({
      run: (argv) => (argv[0] === "list-panes" ? optionsLine("%3", { pid: "4242" }) + "\n" : ""),
      capture: (paneId) => {
        captures.push(paneId);
        return "PROMPT? waiting\n";
      },
      readProcessTable: () => {
        processTableReads += 1;
        return table;
      },
      manifests: MANIFESTS,
      scrapeCacheTtlSeconds: 5,
    });
    const panes = [{ runtimePaneId: "%3", currentCommand: "node", title: "Agent" }];

    const first = probe.probe({ sessionId: "$1", panes, nowSec: NOW });
    const second = probe.probe({ sessionId: "$1", panes, nowSec: NOW + 3 });
    expect(first.get("%3")).toMatchObject({ agentScrapeState: "blocked" });
    expect(second.get("%3")).toMatchObject({ agentScrapeState: "blocked" });
    // One capture and one ps read serve both reads inside the TTL window.
    expect(captures).toEqual(["%3"]);
    expect(processTableReads).toBe(1);

    // Past the TTL both are re-taken.
    const third = probe.probe({ sessionId: "$1", panes, nowSec: NOW + 9 });
    expect(third.get("%3")).toMatchObject({ agentScrapeState: "blocked" });
    expect(captures).toEqual(["%3", "%3"]);
    expect(processTableReads).toBe(2);
  });

  it("invalidates a cached verdict when the pane command changes", () => {
    const captures: string[] = [];
    const probe = createTmuxAgentStatusProbe({
      run: (argv) => (argv[0] === "list-panes" ? optionsLine("%3", { pid: "4242" }) + "\n" : ""),
      capture: (paneId) => {
        captures.push(paneId);
        return "PROMPT? waiting\n";
      },
      readProcessTable: () => [{ pid: 4242, ppid: 1, command: "node /x/bin/claude" }],
      manifests: MANIFESTS,
    });

    probe.probe({
      sessionId: "$1",
      panes: [{ runtimePaneId: "%3", currentCommand: "node", title: "Agent" }],
      nowSec: NOW,
    });
    // Same pane, same TTL window, different foreground command -> re-scrape.
    probe.probe({
      sessionId: "$1",
      panes: [{ runtimePaneId: "%3", currentCommand: "claude", title: "Agent" }],
      nowSec: NOW + 1,
    });
    expect(captures).toEqual(["%3", "%3"]);
  });

  it("drops a pane's cached verdict once fresh authority reappears", () => {
    let state = "";
    const captures: string[] = [];
    const probe = createTmuxAgentStatusProbe({
      run: (argv) =>
        argv[0] === "list-panes" ? optionsLine("%3", { state, pid: "4242" }) + "\n" : "",
      capture: (paneId) => {
        captures.push(paneId);
        return "PROMPT? waiting\n";
      },
      readProcessTable: () => [{ pid: 4242, ppid: 1, command: "node /x/bin/claude" }],
      manifests: MANIFESTS,
      scrapeCacheTtlSeconds: 1_000_000,
    });
    const panes = [{ runtimePaneId: "%3", currentCommand: "node", title: "Agent" }];

    probe.probe({ sessionId: "$1", panes, nowSec: NOW });
    expect(captures).toEqual(["%3"]);

    // A fresh stamp lands: authority wins and evicts the cached verdict...
    state = `working:${NOW + 1}`;
    const withAuthority = probe.probe({ sessionId: "$1", panes, nowSec: NOW + 1 });
    expect(withAuthority.get("%3")).toMatchObject({ agentScrapeState: null });

    // ...so when the stamp goes stale the pane is re-scraped, not served the
    // pre-authority verdict from the (still unexpired) cache.
    state = "";
    probe.probe({ sessionId: "$1", panes, nowSec: NOW + 2 });
    expect(captures).toEqual(["%3", "%3"]);
  });

  it("bounds captures per probe and rotates the budget across reads", () => {
    const table: ProcEntry[] = [{ pid: 4242, ppid: 1, command: "node /x/bin/claude" }];
    const paneIds = ["%1", "%2", "%3", "%4", "%5", "%6"];
    const capturesByProbe: string[][] = [];
    let captures: string[] = [];
    const probe = createTmuxAgentStatusProbe({
      run: (argv) =>
        argv[0] === "list-panes"
          ? paneIds.map((id) => optionsLine(id, { pid: "4242" })).join("\n") + "\n"
          : "",
      capture: (paneId) => {
        captures.push(paneId);
        return "PROMPT? waiting\n";
      },
      readProcessTable: () => table,
      manifests: MANIFESTS,
      scrapeCaptureBudget: 2,
      scrapeCacheTtlSeconds: 5,
    });
    const panes = paneIds.map((id) => ({
      runtimePaneId: id,
      currentCommand: "node",
      title: "Agent",
    }));
    const read = (nowSec: number) => {
      captures = [];
      const facts = probe.probe({ sessionId: "$1", panes, nowSec });
      capturesByProbe.push(captures);
      return facts;
    };

    // Read 1: two captures; the four budget-skipped panes are honestly unknown.
    const first = read(NOW);
    expect(capturesByProbe[0]).toEqual(["%1", "%2"]);
    expect(first.get("%1")).toMatchObject({ agentScrapeState: "blocked" });
    expect(first.get("%3")).toMatchObject({ agentScrapeState: "unknown" });
    expect(first.get("%6")).toMatchObject({ agentScrapeState: "unknown" });

    // Reads 2-3 (inside the TTL): the never-scraped panes go first, cached
    // verdicts ride free, and the whole session converges without any read
    // paying more than the budget.
    const second = read(NOW + 1);
    expect(capturesByProbe[1]).toEqual(["%3", "%4"]);
    expect(second.get("%1")).toMatchObject({ agentScrapeState: "blocked" });
    const third = read(NOW + 2);
    expect(capturesByProbe[2]).toEqual(["%5", "%6"]);
    expect(third.get("%6")).toMatchObject({ agentScrapeState: "blocked" });

    // Read 4: everything cached, zero captures.
    const fourth = read(NOW + 3);
    expect(capturesByProbe[3]).toEqual([]);
    for (const id of paneIds) {
      expect(fourth.get(id)).toMatchObject({ agentScrapeState: "blocked" });
    }

    // Past the TTL, refresh is still bounded and a budget-skipped pane keeps
    // its previous verdict (a few seconds stale beats flapping to unknown).
    const fifth = read(NOW + 10);
    expect(capturesByProbe[4]).toHaveLength(2);
    for (const id of paneIds) {
      expect(fifth.get(id)).toMatchObject({ agentScrapeState: "blocked" });
    }
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
