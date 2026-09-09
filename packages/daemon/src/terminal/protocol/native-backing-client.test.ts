import { afterEach, expect, it, vi } from "vitest";
import { readNativeBacking } from "./native-backing-client.ts";

afterEach(() => vi.unstubAllGlobals());

it("never follows redirects from the authenticated native backing endpoint", async () => {
  const request = vi.fn(async () => new Response(null, { status: 302 }));
  vi.stubGlobal("fetch", request);
  await expect(
    readNativeBacking({
      baseUrl: "http://127.0.0.1:6060",
      ownerToken: "test-token",
      workspaceName: "workspace.alpha",
      paneId: "pane.editor",
      expected: { generation: "daemon", incarnation: "pane", revision: 1, stateHash: "hash" },
      signal: new AbortController().signal,
    }),
  ).resolves.toBeNull();
  expect(request).toHaveBeenCalledWith(
    expect.any(URL),
    expect.objectContaining({ redirect: "error" }),
  );
});
