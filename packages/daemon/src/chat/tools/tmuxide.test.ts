/**
 * `tmuxide.*` chat-tool tests.
 *
 * Mirrors lsp.test.ts: drives the tools through their public handler
 * shape with stub seams (no real action handlers, no tmux). Verifies
 * the guardrails that are the whole point of this surface:
 *   - READ tools execute freely (no approval round-trip).
 *   - MUTATING tools route through the approval requester; a denial
 *     blocks the action.
 *   - DESTRUCTIVE tools are default-denied (refuse WITHOUT prompting)
 *     unless `allowDestructive` is set; with it they still route
 *     through approval.
 *   - Input is validated against the existing action contract before
 *     anything runs.
 *   - The suite is advertised to a new ACP-session registry with JSON
 *     schemas, and omitted when the option is absent.
 *   - `makePermissionApprovalRequester` maps an `allow_*` selection to
 *     "approved" and reject/cancel to "denied".
 */

import { describe, expect, it, vi } from "vitest";
import {
  createTmuxideTools,
  makePermissionApprovalRequester,
  type TmuxideApprovalRequester,
} from "./tmuxide";
import { buildChatToolRegistry } from "../tool-registry";
import type { PaneInfo } from "../../widgets/lib/pane-comms.ts";
import type { RequestPermissionRequest, RequestPermissionResponse } from "../../acp/index.ts";

function makePane(over: Partial<PaneInfo> = {}): PaneInfo {
  return {
    id: "%1",
    index: 0,
    title: "Shell",
    currentCommand: "zsh",
    width: 80,
    height: 24,
    active: true,
    role: "shell",
    name: null,
    type: null,
    ...over,
  };
}

const approve: TmuxideApprovalRequester = async () => ({ approved: true });
const deny: TmuxideApprovalRequester = async () => ({ approved: false, reason: "nope" });

function baseDeps() {
  return {
    listSessionPanes: () => [makePane()],
    discoverSessions: () => [],
    resolveSessionDir: () => "/tmp/proj",
    loadMission: () => null,
    loadGoals: () => [],
    loadTasks: () => [],
    splitPane: vi.fn(() => "%9"),
    sendKeys: vi.fn(),
    resolvePane: (panes: PaneInfo[]) => panes[0] ?? null,
  };
}

describe("tmuxide tools — classification guardrails", () => {
  it("executes a READ tool freely without requesting approval", async () => {
    const requestApproval = vi.fn(approve);
    const runAction = vi.fn(async () => ({ report: { total: 0 } }));
    const tools = createTmuxideTools({
      session: "proj",
      requestApproval,
      runAction,
      ...baseDeps(),
    });
    const res = await tools["tmuxide.validation.report"]!.handler({});
    expect(res.ok).toBe(true);
    expect(requestApproval).not.toHaveBeenCalled();
    expect(runAction).toHaveBeenCalledWith("validation.report", expect.any(Object));
  });

  it("custom READ tool (pane.list) runs without approval", async () => {
    const requestApproval = vi.fn(approve);
    const deps = baseDeps();
    const tools = createTmuxideTools({ session: "proj", requestApproval, ...deps });
    const res = await tools["tmuxide.pane.list"]!.handler({});
    expect(res).toMatchObject({ ok: true, output: { session: "proj" } });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("routes a MUTATING tool through approval and runs it when approved", async () => {
    const requestApproval = vi.fn(approve);
    const runAction = vi.fn(async () => ({ taskId: "1", task: {} }));
    const tools = createTmuxideTools({
      session: "proj",
      requestApproval,
      runAction,
      ...baseDeps(),
    });
    const res = await tools["tmuxide.task.create"]!.handler({ title: "Ship it" });
    expect(res.ok).toBe(true);
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(requestApproval.mock.calls[0]![0]).toMatchObject({
      toolName: "tmuxide.task.create",
      classification: "mutating",
    });
    // The bound session is injected into the contract's scope fields.
    expect(runAction).toHaveBeenCalledWith(
      "task.create",
      expect.objectContaining({ title: "Ship it", sessionName: "proj" }),
    );
  });

  it("blocks a MUTATING tool when approval is denied", async () => {
    const requestApproval = vi.fn(deny);
    const runAction = vi.fn(async () => ({}));
    const tools = createTmuxideTools({
      session: "proj",
      requestApproval,
      runAction,
      ...baseDeps(),
    });
    const res = await tools["tmuxide.task.create"]!.handler({ title: "x" });
    expect(res).toEqual({ ok: false, error: "nope" });
    expect(runAction).not.toHaveBeenCalled();
  });

  it("default-denies a DESTRUCTIVE tool WITHOUT prompting", async () => {
    const requestApproval = vi.fn(approve);
    const runAction = vi.fn(async () => ({ deleted: true }));
    const tools = createTmuxideTools({
      session: "proj",
      requestApproval,
      runAction,
      ...baseDeps(),
    });
    const res = await tools["tmuxide.task.delete"]!.handler({ taskId: "001" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/default-denied/);
    expect(requestApproval).not.toHaveBeenCalled();
    expect(runAction).not.toHaveBeenCalled();
  });

  it("routes a DESTRUCTIVE tool through approval when allowDestructive is set", async () => {
    const requestApproval = vi.fn(approve);
    const runAction = vi.fn(async () => ({ deleted: true }));
    const tools = createTmuxideTools({
      session: "proj",
      requestApproval,
      runAction,
      allowDestructive: true,
      ...baseDeps(),
    });
    const res = await tools["tmuxide.task.delete"]!.handler({ taskId: "001" });
    expect(res.ok).toBe(true);
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(requestApproval.mock.calls[0]![0]).toMatchObject({
      toolName: "tmuxide.task.delete",
      classification: "destructive",
    });
    expect(runAction).toHaveBeenCalledWith(
      "task.delete",
      expect.objectContaining({ taskId: "001" }),
    );
  });

  it("daemon.shutdown and project.stop are destructive + default-denied", async () => {
    const requestApproval = vi.fn(approve);
    const tools = createTmuxideTools({
      session: "proj",
      requestApproval,
      runAction: vi.fn(async () => ({})),
      ...baseDeps(),
    });
    const shutdown = await tools["tmuxide.daemon.shutdown"]!.handler({});
    const stop = await tools["tmuxide.project.stop"]!.handler({ name: "proj" });
    expect(shutdown.ok).toBe(false);
    expect(stop.ok).toBe(false);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("validates input against the action contract before gating", async () => {
    const requestApproval = vi.fn(approve);
    const runAction = vi.fn(async () => ({}));
    const tools = createTmuxideTools({
      session: "proj",
      requestApproval,
      runAction,
      ...baseDeps(),
    });
    // task.create requires a non-empty `title`.
    const res = await tools["tmuxide.task.create"]!.handler({ description: "no title" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Invalid input/);
    expect(requestApproval).not.toHaveBeenCalled();
    expect(runAction).not.toHaveBeenCalled();
  });

  it("pane.send is mutating: approval-gated, then sends to the resolved pane", async () => {
    const requestApproval = vi.fn(approve);
    const deps = baseDeps();
    const tools = createTmuxideTools({ session: "proj", requestApproval, ...deps });
    const res = await tools["tmuxide.pane.send"]!.handler({ target: "Shell", text: "ls" });
    expect(res).toMatchObject({ ok: true, output: { paneId: "%1", enter: true } });
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(deps.sendKeys).toHaveBeenCalledWith("%1", "ls", { enter: true });
  });
});

describe("tmuxide tools — registry advertisement", () => {
  it("advertises the tmuxide.* suite with JSON schemas to a new ACP session", () => {
    const registry = buildChatToolRegistry({
      session: "proj",
      tmuxide: { requestApproval: approve, runAction: async () => ({}) },
    });
    const names = registry.advertise().map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "tmuxide.task.create",
        "tmuxide.task.delete",
        "tmuxide.mission.set",
        "tmuxide.project.stop",
        "tmuxide.daemon.shutdown",
        "tmuxide.validation.report",
        "tmuxide.pane.list",
        "tmuxide.pane.split",
        "tmuxide.pane.send",
      ]),
    );
    const createAd = registry.advertise().find((t) => t.name === "tmuxide.task.create")!;
    expect(createAd.inputSchema).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["title"]),
    });
  });

  it("omits the tmuxide.* suite when no `tmuxide` option is passed", () => {
    const registry = buildChatToolRegistry({ session: "proj" });
    const names = registry.advertise().map((t) => t.name);
    expect(names.some((n) => n.startsWith("tmuxide."))).toBe(false);
  });
});

describe("makePermissionApprovalRequester", () => {
  function requesterWith(res: RequestPermissionResponse) {
    const request = vi.fn(async (_threadId: string, _req: RequestPermissionRequest) => res);
    const requester = makePermissionApprovalRequester({ request, threadId: "thread-1" });
    return { request, requester };
  }

  it("maps an allow_* selection to approved and builds a proper request", async () => {
    const { request, requester } = requesterWith({
      outcome: { outcome: "selected", optionId: "allow_once" },
    });
    const decision = await requester({
      toolName: "tmuxide.task.create",
      classification: "mutating",
      input: { title: "x" },
    });
    expect(decision).toEqual({ approved: true });
    const [threadId, req] = request.mock.calls[0]!;
    expect(threadId).toBe("thread-1");
    expect(req.sessionId).toBe("thread-1");
    expect(req.options.map((o) => o.kind)).toEqual(["allow_once", "reject_once"]);
    expect(req.toolCall.title).toContain("tmuxide.task.create");
    expect(req.toolCall.title).toContain("mutating");
  });

  it("maps a reject selection to denied", async () => {
    const { requester } = requesterWith({
      outcome: { outcome: "selected", optionId: "reject_once" },
    });
    const decision = await requester({
      toolName: "tmuxide.task.delete",
      classification: "destructive",
      input: {},
    });
    expect(decision).toEqual({ approved: false, reason: "Denied by user" });
  });

  it("maps a cancelled outcome to denied", async () => {
    const { requester } = requesterWith({ outcome: { outcome: "cancelled" } });
    const decision = await requester({
      toolName: "tmuxide.mission.set",
      classification: "mutating",
      input: {},
    });
    expect(decision).toEqual({
      approved: false,
      reason: "Permission request cancelled",
    });
  });
});
