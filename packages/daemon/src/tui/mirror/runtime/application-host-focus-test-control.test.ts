import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createConnection } from "node:net";
import { describe, expect, it, vi } from "vitest";

import { createPaneSurfaceHostFocusTransitionOwner } from "../pane-surface.tsx";
import { createApplicationHostFocusPresentation } from "./application-host-focus-presentation.ts";
import {
  createApplicationHostFocusTestControl,
  createApplicationHostFocusTestControlRequest,
  executeApplicationHostFocusTestControl,
  type ApplicationHostFocusControlBinding,
} from "./application-host-focus-test-control.ts";
import { OpenTuiTerminalHostFocus } from "./terminal-host-focus.ts";

const KEY = "1".repeat(64);
const binding = (focused: boolean): ApplicationHostFocusControlBinding =>
  Object.freeze({
    generation: "daemon-generation-a",
    runtimeSession: "runtime-session-a",
    workspaceName: "workspace-a",
    semanticPaneId: "pane-a",
    clientId: "opentui:42",
    rendererEpoch: 3,
    clientGeneration: 7,
    bindingEpoch: 1,
    processId: "opentui:42",
    rendererFocused: focused,
  });

function runtime() {
  const authority = {
    generation: "daemon-generation-a",
    session: "runtime-session-a",
    revision: 11,
    owners: { input: "opentui:42", focus: "opentui:42", geometry: "opentui:42" },
    nativeGeometryYieldUntilMs: 0,
    clients: [
      {
        clientId: "opentui:42",
        surface: "opentui" as const,
        state: "foreground" as const,
        connectedRevision: 1,
        activityRevision: 11,
      },
    ],
  };
  return {
    authorityIdentity: {
      generation: authority.generation,
      session: authority.session,
      clientId: "opentui:42",
    },
    getAuthoritySnapshot: vi.fn(() => authority),
    getSnapshot: vi.fn(() => ({
      generation: 7,
      phase: "live",
      target: { daemon: { instanceId: authority.generation }, workspaceName: "workspace-a" },
      authority,
    })),
    setPresence: vi.fn(),
    noteActivity: vi.fn(),
    requestAuthority: vi.fn(async (authorityKind: "input" | "focus" | "geometry") => ({
      generation: authority.generation,
      session: authority.session,
      clientId: "opentui:42",
      authority: authorityKind,
      revision: 11,
    })),
    releaseAuthority: vi.fn(async () => authority),
    onAuthority: vi.fn(() => () => undefined),
  };
}

function request(action: "blur" | "focus", expected = binding(true)) {
  const identity = {
    generation: expected.generation,
    runtimeSession: expected.runtimeSession,
    workspaceName: expected.workspaceName,
    semanticPaneId: expected.semanticPaneId,
    clientId: expected.clientId,
    rendererEpoch: expected.rendererEpoch,
    clientGeneration: expected.clientGeneration,
    bindingEpoch: expected.bindingEpoch,
    processId: expected.processId,
  };
  return createApplicationHostFocusTestControlRequest(KEY, {
    action,
    nonce: "2".repeat(32),
    expected: identity,
  });
}

describe("application host-focus test control", () => {
  it("refuses paths outside the private runtime root and never removes a replacement", async () => {
    const directory = mkdtempSync("/tmp/tmi-hf-security-");
    const outside = `/tmp/tmi-hf-outside-${Date.now()}.sock`;
    const path = join(directory, "hf.sock");
    const options = {
      runtimeRoot: directory,
      key: KEY,
      currentBinding: () => binding(true),
      driveFocusState: () => ({ changed: false, diagnosticEpoch: null }),
    };
    try {
      expect(() => createApplicationHostFocusTestControl({ ...options, path: outside })).toThrow();
      writeFileSync(path, "not-a-socket", { mode: 0o600 });
      expect(() => createApplicationHostFocusTestControl({ ...options, path })).toThrow();
      unlinkSync(path);
      symlinkSync(outside, path);
      expect(() => createApplicationHostFocusTestControl({ ...options, path })).toThrow();
      unlinkSync(path);
      const control = createApplicationHostFocusTestControl({ ...options, path });
      await control.ready;
      unlinkSync(path);
      writeFileSync(path, "replacement", { mode: 0o600 });
      await control.close();
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(outside, { force: true });
    }
  });

  it("authenticates the socket request before driving the production controller", async () => {
    const directory = mkdtempSync("/tmp/tmi-hf-control-");
    const path = join(directory, "hf.sock");
    const client = runtime();
    const focus = new OpenTuiTerminalHostFocus(true, () => undefined);
    focus.adopt(client as never);
    let focused = true;
    const listeners = new Map<string, Set<() => void>>();
    const renderer = {
      on: (event: string, listener: () => void) => {
        const set = listeners.get(event) ?? new Set();
        set.add(listener);
        listeners.set(event, set);
      },
      off: (event: string, listener: () => void) => listeners.get(event)?.delete(listener),
      requestRender: vi.fn(),
    };
    const emit = (event: string) => {
      for (const listener of [...(listeners.get(event) ?? [])]) listener();
    };
    const identity = {
      generation: "daemon-generation-a",
      incarnation: "incarnation-1",
      revision: 1,
      stateHash: "0a63b052b8f1d994",
      cols: 10,
      rows: 6,
      sourceEpoch: 4,
    } as const;
    const owner = createPaneSurfaceHostFocusTransitionOwner(() => renderer.requestRender());
    const fences = vi.fn();
    const presentation = createApplicationHostFocusPresentation({
      renderer: renderer as never,
      owner,
      sink: { terminalFocusFence: fences } as never,
      hostFocus: focus,
      focusedPane: () => "pane-a",
      rendererFocused: () => focused,
      setRendererFocused: (next) => {
        focused = next;
      },
      rendererSource: () => ({
        rendererEpoch: 3,
        daemonGeneration: "daemon-generation-a",
        clientGeneration: 7,
        adapter: { paneCanonicalIdentity: () => identity } as never,
      }),
    });
    const control = createApplicationHostFocusTestControl({
      path,
      runtimeRoot: directory,
      key: KEY,
      currentBinding: () => binding(focused),
      driveFocusState: presentation.driveFocusState,
    });
    const send = (value: unknown) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const socket = createConnection(path);
        let bytes = "";
        socket.once("connect", () => socket.write(`${JSON.stringify(value)}\n`));
        socket.on("data", (chunk) => {
          bytes += chunk.toString("utf8");
        });
        socket.once("end", () => {
          try {
            resolve(JSON.parse(bytes.trim()) as Record<string, unknown>);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
        socket.once("error", reject);
      });
    try {
      await control.ready;
      const blur = await send(request("blur"));
      expect(blur.status).toBe("changed");
      await vi.waitFor(() => expect(client.releaseAuthority).toHaveBeenCalledTimes(3));
      expect(
        owner.complete(1, {
          processId: "opentui:42",
          clockId: "opentui-performance-now",
          clockKind: "performance-now",
          atMicros: 100,
          semanticPaneId: "pane-a",
          ...identity,
          rendererEpoch: 3,
          viewportCols: 10,
          viewportRows: 5,
          focused: false,
          diagnosticEpoch: 1,
          full: false,
          writtenRows: [2],
        }),
      ).toBe(true);
      emit("frame");
      expect(fences).toHaveBeenCalledTimes(1);
      const noOpBlur = await send(request("blur", binding(false)));
      expect(noOpBlur.status).toBe("no-op");
      emit("frame");
      expect(fences).toHaveBeenCalledTimes(1);
      const claimsBeforeRejectedRequest = client.requestAuthority.mock.calls.length;
      const rejected = await send({ ...request("focus"), authHmac: "f".repeat(64) });
      expect(rejected).toEqual({ version: 1, status: "rejected" });
      expect(client.requestAuthority).toHaveBeenCalledTimes(claimsBeforeRejectedRequest);
    } finally {
      await control.close();
      presentation.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("drives the production focus controller once and returns changed then no-op", async () => {
    const client = runtime();
    const records: Array<{ phase: string; details: Readonly<Record<string, unknown>> }> = [];
    const focus = new OpenTuiTerminalHostFocus(true, (phase, details) =>
      records.push({ phase, details }),
    );
    focus.adopt(client as never);
    records.length = 0;
    let focused = true;
    const execute = (action: "blur" | "focus") =>
      executeApplicationHostFocusTestControl({
        request: request(action),
        key: KEY,
        currentBinding: () => binding(focused),
        driveFocusState: (next) => {
          const diagnosticEpoch = next ? focus.rendererFocus() : focus.rendererBlur();
          focused = next;
          return { changed: diagnosticEpoch !== null, diagnosticEpoch };
        },
      });

    const blur = await execute("blur");
    expect(blur.status).toBe("changed");
    expect(blur.diagnosticEpoch).toBe(1);
    await vi.waitFor(() => expect(client.releaseAuthority).toHaveBeenCalledTimes(3));
    expect(records.map(({ phase }) => phase)).toContain("renderer-blur-event");
    expect(records.map(({ phase }) => phase)).toContain("blur-authority-settled");

    const duplicateBlur = await execute("blur");
    expect(duplicateBlur.status).toBe("no-op");
    expect(duplicateBlur.diagnosticEpoch).toBeNull();
    expect(client.releaseAuthority).toHaveBeenCalledTimes(3);

    const refocus = await execute("focus");
    expect(refocus.status).toBe("changed");
    expect(refocus.diagnosticEpoch).toBe(2);
    await vi.waitFor(() => expect(client.requestAuthority).toHaveBeenCalledTimes(6));
    expect(records.map(({ phase }) => phase)).toContain("renderer-focus-event");
  });

  it("rejects stale, malformed, and foreign bindings without changing focus", async () => {
    const client = runtime();
    const focus = new OpenTuiTerminalHostFocus(true);
    focus.adopt(client as never);
    let focused = true;
    const callsBefore = client.releaseAuthority.mock.calls.length;
    const stale = await executeApplicationHostFocusTestControl({
      request: request("blur", { ...binding(true), rendererEpoch: 2 }),
      key: KEY,
      currentBinding: () => binding(focused),
      driveFocusState: (next) => {
        const diagnosticEpoch = next ? focus.rendererFocus() : focus.rendererBlur();
        focused = next;
        return { changed: diagnosticEpoch !== null, diagnosticEpoch };
      },
    });
    expect(stale).toEqual({ version: 1, status: "stale" });
    expect(focused).toBe(true);
    expect(client.releaseAuthority).toHaveBeenCalledTimes(callsBefore);
    const rejected = await executeApplicationHostFocusTestControl({
      request: { ...request("blur"), authHmac: "f".repeat(64) },
      key: KEY,
      currentBinding: () => binding(focused),
      driveFocusState: vi.fn(() => ({ changed: false, diagnosticEpoch: null })),
    });
    expect(rejected).toEqual({ version: 1, status: "rejected" });
  });
});
