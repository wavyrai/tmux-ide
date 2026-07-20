import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { ActionContractsZ } from "./contract.ts";
import { createActionDispatcher } from "./dispatcher.ts";
import { setDaemonShutdownBackend } from "./handlers/daemon-shutdown.ts";

const actionApp = (broadcast = vi.fn()) => {
  const app = new Hono();
  app.post("/api/v2/action/:name", createActionDispatcher({ broadcast }));
  return { app, broadcast };
};

afterEach(() => {
  setDaemonShutdownBackend(null);
});

describe("command-backed action dispatcher compatibility", () => {
  it("keeps unknown action transport behavior unchanged", async () => {
    const { app } = actionApp();
    const response = await app.request("http://localhost/api/v2/action/no.suchAction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        code: "validation_failed",
        message: "Unknown action: no.suchAction",
        details: { name: "no.suchAction" },
      },
    });
  });

  it("keeps malformed JSON a 400 transport failure", async () => {
    const { app } = actionApp();
    const response = await app.request("http://localhost/api/v2/action/project.launch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "validation_failed" },
    });
  });

  it("keeps schema failures in the existing HTTP-200 action envelope", async () => {
    const { app } = actionApp();
    const response = await app.request("http://localhost/api/v2/action/project.launch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: {
        code: "validation_failed",
        message: "Input failed schema validation",
        details: { issues: expect.any(Array) },
      },
    });
  });

  it.each([
    ["null", null],
    ["array", []],
    ["scalar", 7],
  ])("keeps exact action-schema validation details for %s bodies", async (_kind, body) => {
    const direct = ActionContractsZ["project.launch"].input.safeParse(body);
    expect(direct.success).toBe(false);
    if (direct.success) throw new Error("test body unexpectedly passed the action schema");

    const { app } = actionApp();
    const response = await app.request("http://localhost/api/v2/action/project.launch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        code: "validation_failed",
        message: "Input failed schema validation",
        details: { issues: direct.error.issues },
      },
    });
  });

  it("keeps success results and action.complete broadcast payloads unchanged", async () => {
    setDaemonShutdownBackend(() => undefined);
    const { app, broadcast } = actionApp();
    const response = await app.request("http://localhost/api/v2/action/daemon.shutdown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "compatibility test" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, result: { stopping: true } });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith("daemon.shutdown", { stopping: true });
  });
});
