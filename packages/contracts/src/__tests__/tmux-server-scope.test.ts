import { describe, expect, it } from "vitest";
import {
  TmuxServerScopeSchemaZ,
  tmuxServerPaneStreamPath,
  isTmuxServerPaneStreamPath,
  TmuxServerDescriptorSchemaZ,
  TmuxServersResourceSchemaZ,
  TmuxServerPaneTargetSchemaZ,
  resolveTmuxServerScope,
  tmuxServerScopedResourceKey,
  type TmuxServerScope,
  type TmuxServerDescriptor,
} from "../tmux-server-scope.ts";

import { PaneStreamLoopbackWebSocketUrlSchemaZ, PANE_STREAM_REDEEM_PATH } from "../pane-stream.ts";

const a: TmuxServerScope = {
  serverId: `tmux-server.${"a".repeat(32)}`,
  generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
const b: TmuxServerScope = { ...a, serverId: `tmux-server.${"b".repeat(32)}` };
const replacement: TmuxServerScope = { ...a, generation: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
const online = (scope: TmuxServerScope): TmuxServerDescriptor => ({
  ...scope,
  label: "default",
  state: "online",
});
const offline = (scope: TmuxServerScope): TmuxServerDescriptor => ({
  serverId: scope.serverId,
  label: "default",
  state: "offline",
  generation: null,
});

describe("server-scoped identities", () => {
  it("keeps registration identity separate from each live incarnation", () => {
    expect(TmuxServerScopeSchemaZ.parse(a)).toEqual(a);
    expect(TmuxServerScopeSchemaZ.parse(replacement).serverId).toBe(a.serverId);
    for (const serverId of ["/tmp/tmux/socket", "default", "%0", "tmux-server.short"]) {
      expect(TmuxServerScopeSchemaZ.safeParse({ ...a, serverId }).success).toBe(false);
    }
    expect(TmuxServerScopeSchemaZ.safeParse({ ...a, socketPath: "/tmp/socket" }).success).toBe(
      false,
    );
    expect(TmuxServerScopeSchemaZ.safeParse({ ...a, generation: "1234" }).success).toBe(false);
  });

  it("publishes no live generation for offline registrations", () => {
    expect(TmuxServerDescriptorSchemaZ.parse(online(a))).toEqual(online(a));
    expect(TmuxServerDescriptorSchemaZ.parse(offline(a))).toEqual(offline(a));
    expect(TmuxServerDescriptorSchemaZ.safeParse({ ...online(a), generation: null }).success).toBe(
      false,
    );
    expect(
      TmuxServerDescriptorSchemaZ.safeParse({ ...offline(a), generation: a.generation }).success,
    ).toBe(false);
  });

  it("versions the new resource explicitly and refuses duplicate registrations", () => {
    expect(
      TmuxServersResourceSchemaZ.safeParse({ version: 1, servers: [online(a), online(b)] }).success,
    ).toBe(true);
    expect(TmuxServersResourceSchemaZ.safeParse({ version: 2, servers: [] }).success).toBe(false);
    expect(
      TmuxServersResourceSchemaZ.safeParse({ version: 1, servers: [online(a), offline(a)] })
        .success,
    ).toBe(false);
  });

  it("requires complete server scope for copied pane stamps", () => {
    const target = {
      server: a,
      liveSessionId: `live-session.${"a".repeat(20)}`,
      semanticPaneId: "pane.copied",
    };
    expect(TmuxServerPaneTargetSchemaZ.safeParse(target).success).toBe(true);
    expect(TmuxServerPaneTargetSchemaZ.safeParse({ ...target, server: undefined }).success).toBe(
      false,
    );
    expect(TmuxServerPaneTargetSchemaZ.safeParse({ ...target, runtimePaneId: "%0" }).success).toBe(
      false,
    );
  });

  it("keys copied stamps, native IDs and generations without delimiter collisions", () => {
    const keys = [
      tmuxServerScopedResourceKey(a, "pane", "copied"),
      tmuxServerScopedResourceKey(b, "pane", "copied"),
      tmuxServerScopedResourceKey(replacement, "pane", "copied"),
      tmuxServerScopedResourceKey(a, "window", "copied"),
      tmuxServerScopedResourceKey(a, "pane:copied", ""),
      tmuxServerScopedResourceKey(a, "pane", ":copied"),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(tmuxServerScopedResourceKey(a, "pane", "%0")).not.toBe(
      tmuxServerScopedResourceKey(b, "pane", "%0"),
    );
  });
});

describe("server selection authority", () => {
  it("routes exact scope despite identical display labels", () => {
    expect(resolveTmuxServerScope([online(a), online(b)], b)).toEqual({
      status: "matched",
      scope: b,
    });
  });

  it("rejects old generations without falling back to another live server", () => {
    expect(resolveTmuxServerScope([online(replacement), online(b)], a)).toEqual({
      status: "stale-generation",
    });
    expect(resolveTmuxServerScope([online(b)], a)).toEqual({ status: "not-found" });
    expect(resolveTmuxServerScope([offline(a), online(b)], a)).toEqual({ status: "offline" });
  });

  it("allows legacy selection only with one registered live owner", () => {
    expect(resolveTmuxServerScope([online(a)])).toEqual({ status: "matched", scope: a });
    expect(resolveTmuxServerScope([])).toEqual({ status: "not-found" });
    expect(resolveTmuxServerScope([offline(a)])).toEqual({ status: "offline" });
    expect(resolveTmuxServerScope([online(a), online(b)])).toEqual({ status: "ambiguous" });
    expect(resolveTmuxServerScope([offline(a), online(b)])).toEqual({ status: "ambiguous" });
  });

  it("fails closed if malformed registry repeats an identity", () => {
    expect(resolveTmuxServerScope([online(a), online(a)], a)).toEqual({ status: "ambiguous" });
  });
});

describe("server-scoped pane stream addresses", () => {
  it("separates owners and generations and accepts canonical loopback URLs", () => {
    const paths = [a, b, replacement].map(tmuxServerPaneStreamPath);
    expect(new Set(paths).size).toBe(3);
    for (const path of [...paths, PANE_STREAM_REDEEM_PATH]) {
      expect(
        PaneStreamLoopbackWebSocketUrlSchemaZ.safeParse(`ws://127.0.0.1:1234${path}`).success,
      ).toBe(true);
    }
  });

  it("refuses unscoped, malformed, encoded and credentialed paths", () => {
    const path = tmuxServerPaneStreamPath(a);
    for (const badPath of [
      path + "/",
      path + "/other",
      path.replace(a.serverId, "default"),
      path.replace(a.generation, "old"),
      path.replace("tmux-server.", "tmux-server%2e"),
      "/v2/tmux-servers/pane-streams/redeem",
    ]) {
      expect(isTmuxServerPaneStreamPath(badPath)).toBe(false);
      expect(
        PaneStreamLoopbackWebSocketUrlSchemaZ.safeParse(`ws://127.0.0.1:1234${badPath}`).success,
      ).toBe(false);
    }
    for (const url of [
      `ws://127.0.0.1:1234${path}?generation=${b.generation}`,
      `ws://127.0.0.1:1234${path}#fragment`,
      `ws://user@127.0.0.1:1234${path}`,
      `ws://example.com:1234${path}`,
      `wss://127.0.0.1:1234${path}`,
      `ws://127.0.0.1${path}`,
    ])
      expect(PaneStreamLoopbackWebSocketUrlSchemaZ.safeParse(url).success).toBe(false);
  });
});
