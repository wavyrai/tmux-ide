import { randomUUID } from "node:crypto";
import { z } from "zod";
export const sessionTabCommandSchema = z
  .object({
    type: z.literal("session-tab"),
    request: z.number().int().positive().safe(),
    fromRequest: z.number().int().nonnegative().safe(),
    revision: z.number().int().positive().safe(),
    action: z.uuid(),
  })
  .strict();
export type TabTarget = {
  key: string;
  identity: string;
  label: string;
  hostLabel: string;
  serverLabel: string | null;
};
type Command = z.infer<typeof sessionTabCommandSchema>;
type Activity = "failed" | "waiting" | "running" | "idle";
export type TabObservation =
  | readonly { identity: string; activity: string; attention: boolean }[]
  | null;
const display = (value: string) =>
  Array.from(value)
    .filter((c) => {
      const n = c.codePointAt(0)!;
      return n >= 32 && (n < 127 || n > 159);
    })
    .slice(0, 160)
    .join("");
/** Retained identities only. The browser owns the single live helper and every admission. */
export function createSessionTabs() {
  const tabs = new Map<
    string,
    {
      id: string;
      target: TabTarget;
      unread: boolean;
      activity: Activity | null;
      observed: Map<string, string> | null;
    }
  >();
  let active: string | null = null,
    pending: { request: number; key: string } | null = null;
  let proof: { request: number; key: string; catalog: object; presence: number } | null = null;
  let floor = -1,
    acceptedRequest = -1,
    revision = 0,
    signature = "",
    highest = -1;
  let actions = new Map<string, { key: string; kind: "activate" | "close" }>();
  let publication: ReturnType<typeof project> | null = null;
  function project(request: number, resolve: (key: string) => TabTarget | null) {
    const rows = [...tabs.values()].map((tab) => {
      const fresh = resolve(tab.target.key);
      return {
        id: tab.id,
        label: display(fresh?.label ?? tab.target.label),
        hostLabel: display(tab.target.hostLabel),
        serverLabel: tab.target.serverLabel === null ? null : display(tab.target.serverLabel),
        available: !!fresh && fresh.identity === tab.target.identity,
        unread: tab.unread,
        activity: tab.activity,
        activate: randomUUID(),
        close: randomUUID(),
      };
    });
    const activeId = active ? (tabs.get(active)?.id ?? null) : null;
    const index = [...tabs.keys()].indexOf(active ?? "");
    return {
      request,
      revision,
      rows,
      active: active ? (tabs.get(active)?.id ?? null) : null,
      pending: pending ? (tabs.get(pending.key)?.id ?? null) : null,
      next: rows.length ? rows[(index + 1 + rows.length) % rows.length]!.activate : null,
      previous: rows.length ? rows[(index - 1 + rows.length) % rows.length]!.activate : null,
      closeActive: active ? (rows.find((row) => row.id === activeId)?.close ?? null) : null,
    };
  }
  const cancel = () => {
    floor = Math.max(floor, pending?.request ?? -1);
    pending = null;
    proof = null;
    signature = "";
  };
  return {
    keys: () => [...tabs.keys()],
    publication(request: number, enabled: boolean, resolve: (key: string) => TabTarget | null) {
      if (!enabled) {
        publication = null;
        actions.clear();
        signature = "";
        return null;
      }
      const next = project(request, resolve);
      // Display observation can change between paint and command delivery. Keep
      // capabilities tied to retained identity/lifetime, not badge availability.
      const sig = JSON.stringify({
        request,
        active,
        pending: pending?.key ?? null,
        rows: [...tabs.values()].map((tab) => [tab.id, tab.target.identity]),
      });
      if (sig !== signature) {
        if (revision === Number.MAX_SAFE_INTEGER) return null;
        signature = sig;
        next.revision = ++revision;
        publication = next;
        actions = new Map();
        next.rows.forEach((row, i) => {
          const key = [...tabs.keys()][i]!;
          actions.set(row.activate, { key, kind: "activate" });
          actions.set(row.close, { key, kind: "close" });
        });
      } else if (publication) {
        const previous = publication;
        publication = {
          ...next,
          revision: previous.revision,
          rows: next.rows.map((row, index) => ({
            ...row,
            activate: previous.rows[index]!.activate,
            close: previous.rows[index]!.close,
          })),
          next: previous.next,
          previous: previous.previous,
          closeActive: previous.closeActive,
        };
      }
      return publication;
    },
    admit(
      command: Command,
      current: number,
      foreground: boolean,
      resolve: (key: string) => TabTarget | null,
    ) {
      if (command.request <= current || command.request <= highest) return null;
      highest = command.request;
      const action = actions.get(command.action);
      if (
        !foreground ||
        command.fromRequest !== current ||
        publication?.request !== current ||
        command.revision !== publication.revision ||
        !action
      )
        return null;
      const tab = tabs.get(action.key);
      if (!tab) return null;
      if (action.kind === "activate") {
        const fresh = resolve(action.key);
        if (!fresh || fresh.identity !== tab.target.identity) return null;
        cancel();
        pending = { request: command.request, key: action.key };
        active = null;
        signature = "";
        return { kind: "activate" as const, key: action.key, home: false };
      }
      const home = active === action.key || pending?.key === action.key;
      if (home) {
        cancel();
        floor = Math.max(floor, current, command.request);
        active = null;
      }
      tabs.delete(action.key);
      signature = "";
      return { kind: "close" as const, key: action.key, home };
    },
    catalogReady(request: number, key: string, catalog: object, presence: number) {
      if (pending?.request === request && pending.key === key)
        proof = { request, key, catalog, presence };
    },
    navigation(
      request: number,
      continuation?: { fromRequest: number; key: string; catalog: object; presence: number },
    ) {
      if (
        pending &&
        proof &&
        continuation &&
        proof.request === continuation.fromRequest &&
        proof.key === continuation.key &&
        proof.catalog === continuation.catalog &&
        proof.presence === continuation.presence &&
        pending.request === proof.request &&
        request > pending.request
      )
        pending.request = request;
      if (pending?.request !== request) cancel();
      proof = null;
      active = null;
      signature = "";
    },
    cancel,
    /** Caller must prove the same machine/server/live session on a fresh route. */
    recover(request: number, previousKey: string, target: TabTarget) {
      if (request !== acceptedRequest || request <= floor || active !== previousKey || pending)
        return false;
      const old = tabs.get(previousKey);
      if (!old || (target.key !== previousKey && tabs.has(target.key))) return false;
      const rows = [...tabs.entries()].map(([key, row]) =>
        key === previousKey
          ? ([
              target.key,
              { ...row, target: Object.freeze({ ...target }), observed: null },
            ] as const)
          : ([key, row] as const),
      );
      tabs.clear();
      for (const [key, row] of rows) tabs.set(key, row);
      active = target.key;
      actions.clear();
      signature = "";
      return true;
    },
    accept(request: number, target: TabTarget) {
      if (request <= floor || request === acceptedRequest) return false;
      if (
        pending &&
        (pending.request !== request ||
          pending.key !== target.key ||
          tabs.get(pending.key)?.target.identity !== target.identity)
      )
        return false;
      pending = null;
      proof = null;
      acceptedRequest = request;
      if (!tabs.has(target.key) && tabs.size >= 8) {
        const key = [...tabs.keys()].find((key) => key !== active);
        if (key) tabs.delete(key);
      }
      const old = tabs.get(target.key);
      tabs.set(target.key, {
        id: old?.id ?? randomUUID(),
        target: Object.freeze({ ...target }),
        unread: false,
        activity: old?.activity ?? null,
        observed: old?.observed ?? null,
      });
      active = target.key;
      signature = "";
      return true;
    },
    observe(key: string, agents: TabObservation) {
      const tab = tabs.get(key);
      if (!tab) return false;
      const before = JSON.stringify([tab.unread, tab.activity]);
      if (!agents) {
        tab.observed = null;
        tab.activity = null;
      } else {
        if (
          active !== key &&
          agents.some(
            (agent) =>
              agent.activity === "complete" && tab.observed?.get(agent.identity) === "running",
          )
        )
          tab.unread = true;
        tab.observed = new Map(agents.map((agent) => [agent.identity, agent.activity]));
        tab.activity = agents.some((a) => a.activity === "failed")
          ? "failed"
          : agents.some((a) => a.attention || a.activity === "waiting")
            ? "waiting"
            : agents.some((a) => a.activity === "running")
              ? "running"
              : "idle";
      }
      return before !== JSON.stringify([tab.unread, tab.activity]);
    },
    dispose() {
      cancel();
      tabs.clear();
      actions.clear();
      publication = null;
      active = null;
      floor = Number.MAX_SAFE_INTEGER;
    },
  };
}
