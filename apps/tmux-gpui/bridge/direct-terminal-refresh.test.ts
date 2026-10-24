import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readDirectInventory, refreshDirectTerminal } from "./direct-terminal-refresh.ts";
const config = {
  baseUrl: "http://127.0.0.1:41234/",
  ownerToken: "private",
  scope: { serverId: `tmux-server.${"a".repeat(32)}`, generation: randomUUID() },
  workspaceName: "workspace",
  liveSessionId: `live-session.${"b".repeat(20)}`,
  semanticPaneId: "source",
};
const binding = {
  id: randomUUID(),
  request: 7,
  config,
  origin: "tmux-ide://app",
  hostClientId: `gpui:${randomUUID()}`,
};
const command = { type: "native-terminal-refresh", id: binding.id, request: 7 };
test("split preserves selected pane and request; close selects a verified survivor", async () => {
  for (const closed of [false, true]) {
    const order: string[] = [];
    const choices = [
      ...(!closed ? [{ ...config, visiblePaneIds: ["source", "survivor"] }] : []),
      {
        ...config,
        semanticPaneId: "survivor",
        visiblePaneIds: closed ? ["survivor"] : ["source", "survivor"],
      },
    ];
    assert.equal(
      await refreshDirectTerminal(binding, command, {
        current: () => true,
        retire: () => {
          order.push("retire");
        },
        read: async () => {
          order.push("read");
          return choices;
        },
        open: async (selected, _choices, request) => {
          order.push("open");
          assert.equal(selected.semanticPaneId, closed ? "survivor" : "source");
          assert.equal(request, 7);
        },
      }),
      true,
    );
    assert.deepEqual(order, ["retire", "read", "open"]);
  }
});
test("navigation during read cannot reopen stale scope", async () => {
  let current = true,
    opened = false;
  await refreshDirectTerminal(binding, command, {
    current: () => current,
    retire: () => {},
    read: async () => {
      current = false;
      return [config];
    },
    open: async () => {
      opened = true;
    },
  });
  assert.equal(opened, false);
});
test("wrong request never retires and changed generation cannot supply survivor", async () => {
  let retired = false;
  assert.equal(
    await refreshDirectTerminal(
      binding,
      { ...command, request: 8 },
      {
        current: () => true,
        retire: () => {
          retired = true;
        },
        read: async () => [],
        open: async () => {
          throw Error("unexpected");
        },
      },
    ),
    false,
  );
  assert.equal(retired, false);
  await assert.rejects(
    refreshDirectTerminal(binding, command, {
      current: () => true,
      retire: () => {},
      read: async () => [{ ...config, scope: { ...config.scope, generation: randomUUID() } }],
      open: async () => {
        throw Error("unexpected");
      },
    }),
    /no surviving pane/,
  );
});

test("created preferred pane may be outside old capability but must appear in fresh inventory", async () => {
  let reads = 0;
  let opened: string | undefined;
  await refreshDirectTerminal(
    { ...binding, config: { ...config, visiblePaneIds: ["source"] } },
    { ...command, preferredPane: "created" },
    {
      current: () => true,
      retire: () => {},
      read: async () => {
        reads++;
        return reads < 2
          ? [config]
          : [
              config,
              { ...config, semanticPaneId: "created", visiblePaneIds: ["source", "created"] },
            ];
      },
      open: async (selected) => {
        opened = selected.semanticPaneId;
      },
    },
  );
  assert.equal(reads, 2);
  assert.equal(opened, "created");
});
test("missing or wrong-scope preferred pane never falls back to the original pane", async () => {
  let reads = 0;
  let opens = 0;
  await assert.rejects(
    refreshDirectTerminal(
      binding,
      { ...command, preferredPane: "created" },
      {
        current: () => true,
        retire: () => {},
        read: async () => {
          reads++;
          return [
            config,
            {
              ...config,
              semanticPaneId: "created",
              scope: { ...config.scope, generation: randomUUID() },
            },
          ];
        },
        open: async () => {
          opens++;
        },
      },
    ),
    /preferred pane is unavailable/,
  );
  assert.equal(reads, 4);
  assert.equal(opens, 0);
});
test("invalid preferred pane does not retire existing capability", async () => {
  let retired = false;
  assert.equal(
    await refreshDirectTerminal(
      binding,
      { ...command, preferredPane: "" },
      {
        current: () => true,
        retire: () => {
          retired = true;
        },
        read: async () => [config],
        open: async () => {
          throw Error("unexpected");
        },
      },
    ),
    false,
  );
  assert.equal(retired, false);
});

test("structural refresh publishes authoritative session count, not issued pane count", async () => {
  let publication: { sessions: { id: string; label: string; paneCount?: number }[] } = {
    sessions: [{ id: config.liveSessionId, label: "one", paneCount: 2 }],
  };
  await refreshDirectTerminal(binding, command, {
    current: () => true,
    retire: () => {},
    read: () =>
      readDirectInventory({
        current: () => true,
        panes: async () => [config],
        sessions: async () => [
          { liveSessionId: config.liveSessionId, sessionName: "one", paneCount: 31 },
        ],
        publishSessions: (sessions) => {
          publication = { sessions };
        },
      }),
    open: async (_selected, choices) => {
      assert.equal(choices.length, 1);
      assert.deepEqual(JSON.parse(JSON.stringify(publication)), {
        sessions: [{ id: config.liveSessionId, label: "one", paneCount: 31 }],
      });
    },
  });
});

test("retired session metadata cannot overwrite publication and lists stay bounded", async () => {
  let current = true;
  let publications = 0;
  const options = {
    current: () => current,
    panes: async () => [config],
    sessions: async () => {
      current = false;
      return [{ liveSessionId: config.liveSessionId, sessionName: "old", paneCount: 3 }];
    },
    publishSessions: () => {
      publications++;
    },
  };
  assert.deepEqual(await readDirectInventory(options), []);
  assert.equal(publications, 0);
  current = true;
  await assert.rejects(
    readDirectInventory({
      ...options,
      sessions: async () =>
        Array.from({ length: 513 }, () => ({
          liveSessionId: config.liveSessionId,
          sessionName: "old",
        })),
    }),
    /session bound/,
  );
  assert.equal(publications, 0);
});
