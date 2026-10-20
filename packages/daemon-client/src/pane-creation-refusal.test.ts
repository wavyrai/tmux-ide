import { expect, test } from "bun:test";
import { createTmuxServerClient, TmuxServerClientError } from "./tmux-server-client.ts";
const scope = {
  serverId: `tmux-server.${"a".repeat(32)}`,
  generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
const intent = {
  workspaceName: "main",
  kind: "agent" as const,
  displayTitle: "Claude",
  harnessProfileId: "claude",
  role: "implementer" as const,
  placement: { kind: "window" as const },
};
async function observe(body: string, status = 409) {
  let calls = 0;
  const client = createTmuxServerClient(
    {
      baseUrl: "http://127.0.0.1:1",
      ownerToken: "fixture",
      hostClientId: "fixture",
      origin: "tmux-ide://app",
      fetch: async () => {
        calls++;
        return new Response(body, { status });
      },
    },
    scope,
  );
  try {
    await client.createPane(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      intent,
      `live-session.${"a".repeat(20)}`,
    );
    throw Error("unexpected success");
  } catch (error) {
    expect(error).toBeInstanceOf(TmuxServerClientError);
    return { error: error as TmuxServerClientError, calls };
  } finally {
    client.dispose();
  }
}
test("creation preserves only an exact known refusal and never retries", async () => {
  const { error, calls } = await observe('{"error":{"code":"harness_unavailable"}}');
  expect(error.code).toBe("request-failed");
  expect(error.status).toBe(409);
  expect(error.refusalCode).toBe("harness_unavailable");
  expect(calls).toBe(1);
});
test("unknown malformed oversized and context-bearing failures stay generic", async () => {
  for (const body of [
    '{"error":{"code":"server-unavailable"}}',
    '{"error":{"code":"harness_unavailable","path":"/secret"}}',
    '{"error":{"code":"harness_unavailable"},"secret":"private"}',
    "{",
    " ".repeat(1025) + '{"error":{"code":"harness_unavailable"}}',
  ]) {
    const { error, calls } = await observe(body);
    expect(error.refusalCode).toBeUndefined();
    expect(error.message).not.toContain("secret");
    expect(calls).toBe(1);
  }
  expect(
    (await observe('{"error":{"code":"harness_unavailable"}}', 503)).error.refusalCode,
  ).toBeUndefined();
});
