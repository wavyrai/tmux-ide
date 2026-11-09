import { createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { ApplicationPluginPaletteCommand } from "../workspace/application-command-description.ts";
import { applicationCommandDescription } from "../workspace/application-command-description.ts";
import { paletteSection } from "../workspace/palette-list-layout.ts";
import { createApplicationPaletteCommandOwner } from "./application-palette-command-owner.ts";
import { createApplicationPluginCommands } from "./application-plugin-commands.ts";
import { createApplicationPluginForm } from "./application-plugin-form.ts";

const plugin = (
  overrides: Partial<ApplicationPluginPaletteCommand> = {},
): ApplicationPluginPaletteCommand => ({
  kind: "plugin-command",
  id: "plugin.tasks.new",
  label: "New task",
  category: "Tasks",
  plugin: "tasks",
  dangerous: false,
  params: [
    {
      name: "name",
      type: "string",
      label: "Branch name",
      required: true,
      dynamicDefault: false,
      dynamicChoices: false,
    },
  ],
  ...overrides,
});

function setup(commands: ApplicationPluginPaletteCommand[]) {
  const invoke = vi.fn(async () => ({ ok: true as const }));
  const refresh = vi.fn();
  const setNote = vi.fn();
  const splitPane = vi.fn(async () => "unexpected");
  const setPaletteOpen = vi.fn(async () => true);
  let owner: ReturnType<typeof createApplicationPaletteCommandOwner> | null = null;
  const form = createApplicationPluginForm({
    // Choices never arrive, so a dynamic-choice step stays "loading".
    service: { invoke, paramOptions: vi.fn(() => new Promise<never>(() => {})) },
    context: () => ({ source: "palette" }),
    query: () => owner?.query() ?? "",
    setNote,
    close: () => owner?.setOpen(false, "keyboard"),
    stepChanged: () => owner?.resetForStep(),
  });
  owner = createApplicationPaletteCommandOwner({
    activeSurface: () => "terminals",
    isOpen: () => true,
    binding: {
      openSurface: vi.fn(async () => true),
      setPaletteOpen,
      activatePaletteSurface: vi.fn(async () => true),
    },
    commandSource: (kind, surface) => ({ kind, surface }),
    setSurface: vi.fn(),
    setNote,
    newWindow: vi.fn(async () => "created"),
    splitPane,
    closePane: vi.fn(async () => "closed"),
    openAgent: vi.fn(async () => true),
    commands: () => ["new-window", ...commands],
    plugins: { form, refresh },
  });
  return { owner, form, invoke, refresh, setNote, splitPane, setPaletteOpen };
}

describe("plugin commands in the TUI palette", () => {
  it("are described and grouped by their category", () => {
    expect(applicationCommandDescription(plugin())).toEqual({
      id: '["plugin-command","plugin.tasks.new"]',
      label: "New task…",
      detail: "Tasks · tasks plugin",
    });
    expect(applicationCommandDescription(plugin({ params: [] })).label).toBe("New task");
    expect(paletteSection(plugin())).toBe("Tasks");
  });

  it("refresh the plugin list when the palette opens", () => {
    const h = setup([plugin()]);
    h.owner.setOpen(true, "keyboard");
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("open a form, take typed input through the search line, and invoke", () =>
    createRoot(async (dispose) => {
      const h = setup([plugin()]);
      h.owner.setOpen(true, "keyboard");
      h.owner.activate(plugin(), "keyboard");
      expect(h.form.active()).toBe(true);
      expect(h.owner.keyboardHint()).toContain("Branch name (1/1)");
      expect(h.owner.commands().map((c) => applicationCommandDescription(c).label)).toEqual([
        "Type the branch name",
      ]);
      h.owner.setQuery("fix-login");
      const [submit] = h.owner.commands();
      h.owner.activate(submit!, "keyboard");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(h.invoke).toHaveBeenCalledWith(
        "plugin.tasks.new",
        { name: "fix-login" },
        { source: "palette" },
        false,
      );
      expect(h.form.active()).toBe(false);
      expect(h.setPaletteOpen).toHaveBeenLastCalledWith(false, expect.anything());
      expect(h.splitPane).not.toHaveBeenCalled();
      dispose();
    }));

  it("do not act on a disabled form entry, and say why", () => {
    const loading = plugin({
      params: [
        {
          name: "task",
          type: "choice",
          label: "Task",
          required: true,
          dynamicDefault: false,
          dynamicChoices: true,
        },
      ],
    });
    const h = setup([loading]);
    h.owner.setOpen(true, "keyboard");
    h.owner.activate(loading, "keyboard");
    const [entry] = h.owner.commands();
    expect(applicationCommandDescription(entry!).label).toBe("Loading choices…");
    h.owner.activate(entry!, "keyboard");
    expect(h.setNote).toHaveBeenLastCalledWith("Still loading choices");
    expect(h.form.active()).toBe(true);
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("cancel the form when the palette closes", () => {
    const h = setup([plugin()]);
    h.owner.setOpen(true, "keyboard");
    h.owner.activate(plugin(), "keyboard");
    h.owner.setOpen(false, "keyboard");
    expect(h.form.active()).toBe(false);
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("say so when plugins are unavailable", () => {
    const h = setup([]);
    const owner = createApplicationPaletteCommandOwner({
      activeSurface: () => "home",
      binding: {
        openSurface: vi.fn(async () => true),
        setPaletteOpen: vi.fn(async () => true),
        activatePaletteSurface: vi.fn(async () => true),
      },
      commandSource: (kind, surface) => ({ kind, surface }),
      setSurface: vi.fn(),
      setNote: h.setNote,
      newWindow: vi.fn(async () => "created"),
      splitPane: h.splitPane,
      closePane: vi.fn(async () => "closed"),
      openAgent: vi.fn(async () => true),
    });
    owner.activate(plugin(), "keyboard");
    expect(h.setNote).toHaveBeenCalledWith("Plugin commands are unavailable.");
    expect(h.splitPane).not.toHaveBeenCalled();
  });
});

describe("plugin command client", () => {
  const daemon = {
    bindHostname: "127.0.0.1",
    port: 4321,
    authToken: "owner-token",
  } as never;

  it("keeps only plugin entries from the catalog and sends the owner token", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            version: 1,
            revision: 2,
            entries: [
              {
                descriptor: {
                  version: 1,
                  id: "project.launch",
                  owner: "daemon",
                  label: "Launch",
                  category: "project",
                  schemas: { input: "project.launch" },
                  dangerous: false,
                  confirmation: "none",
                },
                params: [],
              },
              {
                descriptor: {
                  version: 1,
                  id: "plugin.tasks.rm",
                  owner: "plugin",
                  label: "Remove",
                  category: "Tasks",
                  schemas: { input: "plugin:tasks" },
                  dangerous: true,
                  confirmation: "dialog",
                },
                plugin: "tasks",
                params: [],
              },
            ],
          }),
        ),
    );
    const client = createApplicationPluginCommands({ daemon: () => daemon, fetch: fetch as never });
    await client.refresh();
    expect(client.commands()).toEqual([
      {
        kind: "plugin-command",
        id: "plugin.tasks.rm",
        label: "Remove",
        category: "Tasks",
        plugin: "tasks",
        dangerous: true,
        params: [],
      },
    ]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4321/api/resources/command-catalog");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer owner-token");
  });

  it("keeps the last list and reports errors without throwing", async () => {
    const client = createApplicationPluginCommands({ daemon: () => null, fetch: vi.fn() as never });
    await client.refresh();
    expect(client.commands()).toEqual([]);
    expect(await client.invoke("plugin.tasks.rm", {}, { source: "palette" }, true)).toEqual({
      ok: false,
      error: "No local tmux-ide daemon is running.",
    });
    const failing = createApplicationPluginCommands({
      daemon: () => daemon,
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "Plugins are not enabled in this daemon" }), {
            status: 503,
          }),
      ) as never,
    });
    expect(await failing.paramOptions("plugin.tasks.rm", "x", { source: "palette" })).toEqual({
      ok: false,
      error: "Plugins are not enabled in this daemon",
    });
  });

  it("sends invoke and param-options requests with their bodies", async () => {
    const bodies: unknown[] = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ok: true }));
    });
    const client = createApplicationPluginCommands({ daemon: () => daemon, fetch: fetch as never });
    expect(
      await client.invoke("plugin.tasks.rm", { a: 1 }, { source: "palette", pane: "%1" }, true),
    ).toEqual({ ok: true });
    expect(await client.paramOptions("plugin.tasks.rm", "a", { source: "palette" })).toEqual({
      ok: true,
    });
    expect(bodies).toEqual([
      {
        id: "plugin.tasks.rm",
        args: { a: 1 },
        context: { source: "palette", pane: "%1" },
        confirmed: true,
      },
      { id: "plugin.tasks.rm", param: "a", context: { source: "palette" } },
    ]);
  });
});

describe("live catalog updates", () => {
  const daemon = { bindHostname: "127.0.0.1", port: 4321, authToken: "owner-token" } as never;

  function fakeSocket() {
    const listeners = new Map<string, ((event?: { data: unknown }) => void)[]>();
    const sent: unknown[] = [];
    const socket = {
      closed: false,
      addEventListener(type: string, listener: (event?: { data: unknown }) => void) {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      send: (data: string) => sent.push(JSON.parse(data)),
      close() {
        socket.closed = true;
      },
      emit(type: string, event?: { data: unknown }) {
        for (const listener of listeners.get(type) ?? []) listener(event);
      },
    };
    return { socket, sent };
  }

  it("subscribes to command-catalog and refetches on each change", async () => {
    const { socket, sent } = fakeSocket();
    const urls: string[] = [];
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ version: 1, revision: 1, entries: [] })),
    );
    const client = createApplicationPluginCommands({
      daemon: () => daemon,
      fetch: fetch as never,
      socket: (url, token) => {
        urls.push(`${url} ${token}`);
        return socket;
      },
    });
    const stop = client.watch();
    expect(urls).toEqual(["ws://127.0.0.1:4321/ws/events?mode=semantic owner-token"]);
    socket.emit("open");
    expect(sent).toEqual([
      {
        type: "subscribe",
        sessions: [],
        interests: [{ resource: "command-catalog", workspaceName: null }],
        legacyEvents: false,
      },
    ]);
    socket.emit("message", {
      data: JSON.stringify({ type: "resource.changed", resource: "fleet-catalog" }),
    });
    socket.emit("message", { data: "not json" });
    expect(fetch).not.toHaveBeenCalled();
    socket.emit("message", {
      data: JSON.stringify({ type: "resource.changed", resource: "command-catalog", sequence: 2 }),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    stop();
    expect(socket.closed).toBe(true);
    socket.emit("message", {
      data: JSON.stringify({ type: "resource.changed", resource: "command-catalog" }),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a daemon", () => {
    const socket = vi.fn();
    const client = createApplicationPluginCommands({
      daemon: () => null,
      fetch: vi.fn() as never,
      socket,
    });
    client.watch()();
    expect(socket).not.toHaveBeenCalled();
  });

  it("is started when the palette opens and stopped when it closes", () => {
    const h = setup([plugin()]);
    void h;
    const stop = vi.fn();
    const watch = vi.fn(() => stop);
    const owner = createApplicationPaletteCommandOwner({
      activeSurface: () => "home",
      binding: {
        openSurface: vi.fn(async () => true),
        setPaletteOpen: vi.fn(async () => true),
        activatePaletteSurface: vi.fn(async () => true),
      },
      commandSource: (kind, surface) => ({ kind, surface }),
      setSurface: vi.fn(),
      setNote: vi.fn(),
      newWindow: vi.fn(async () => "created"),
      splitPane: vi.fn(async () => "split"),
      closePane: vi.fn(async () => "closed"),
      openAgent: vi.fn(async () => true),
      plugins: { form: h.form, refresh: vi.fn(), watch },
    });
    owner.setOpen(true, "keyboard");
    expect(watch).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    owner.setOpen(false, "keyboard");
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
