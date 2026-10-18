import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { WorkspacePaneCreationError } from "../lib/workspace-pane-creation.ts";
import { mountTmuxServerRoutes, type TmuxServerRoutesOptions } from "./tmux-servers.ts";

const generation = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
async function refusal(error: Error, authorized = true) {
  let calls = 0;
  const app = new Hono();
  const owners = {
    withOwner: async (_scope: unknown, work: (owner: unknown) => unknown) =>
      work({
        createSessionPane: async () => {
          calls++;
          throw error;
        },
      }),
  } as unknown as TmuxServerRoutesOptions["owners"];
  mountTmuxServerRoutes(app, { ownerToken: "fixture", owners });
  const response = await app.request(
    `/api/v1/tmux-servers/tmux-server.${"a".repeat(32)}/${generation}/panes/create?liveSessionId=live-session.${"a".repeat(20)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authorized ? "fixture" : "wrong"}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        expectedDaemonInstanceId: generation,
        intent: {
          workspaceName: "main",
          kind: "agent",
          displayTitle: "Claude",
          harnessProfileId: "claude",
          role: "implementer",
          placement: { kind: "window" },
        },
      }),
    },
  );
  return { status: response.status, body: await response.json(), calls };
}
describe("selected-server agent refusal", () => {
  it("preserves unavailable classification without raw context or installation claims", async () => {
    expect(
      await refusal(
        new WorkspacePaneCreationError("harness_unavailable", {
          path: "/private/secret",
          harnessProfileId: "sensitive",
        }),
      ),
    ).toEqual({ status: 409, body: { error: { code: "harness_unavailable" } }, calls: 1 });
  });
  it("does not promote unknown or potentially mutated failures to confirmed refusal", async () => {
    for (const error of [
      new Error("/private/secret"),
      new WorkspacePaneCreationError("pane_creation_failed"),
    ]) {
      expect(await refusal(error)).toEqual({
        status: 503,
        body: { error: { code: "server-unavailable" } },
        calls: 1,
      });
    }
  });
  it("requires owner authorization before any operation", async () => {
    expect(await refusal(new WorkspacePaneCreationError("harness_unavailable"), false)).toEqual({
      status: 401,
      body: { error: { code: "owner-required" } },
      calls: 0,
    });
  });
});
