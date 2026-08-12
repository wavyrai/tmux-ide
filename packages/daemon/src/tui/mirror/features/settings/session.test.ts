import { describe, expect, it, vi } from "vitest";

import { parseAppConfig, type AppConfigPatch } from "../../../../lib/app-config.ts";
import type { NotificationPrefs } from "../../../chrome/notify-prefs.ts";
import type {
  DialogConfirmRequest,
  DialogFeatureSession,
  DialogPromptRequest,
  DialogSelectRequest,
} from "../dialogs/contract.ts";
import type { DialogSelectResult } from "../../dialog-model.ts";
import { createSettingsFeatureSession } from "./session.ts";

const prefs: NotificationPrefs = {
  enabled: true,
  toast: true,
  macos: true,
  terminal: true,
  delaySeconds: 2,
  sound: "blocked",
  onBlocked: true,
  onDone: true,
  quietHours: null,
};

const picked = (id: string, label = id): DialogSelectResult => ({
  item: { id, label },
});

interface DialogScript {
  readonly select?: Array<
    | DialogSelectResult
    | null
    | ((
        request: DialogSelectRequest,
      ) => DialogSelectResult | null | Promise<DialogSelectResult | null>)
  >;
  readonly prompt?: Array<string | null | ((request: DialogPromptRequest) => string | null)>;
  readonly confirm?: Array<boolean | ((request: DialogConfirmRequest) => boolean)>;
}

function scriptedDialogs(script: DialogScript) {
  const selects: DialogSelectRequest[] = [];
  const prompts: DialogPromptRequest[] = [];
  const confirms: DialogConfirmRequest[] = [];
  let clear = () => undefined;
  const dialogs: DialogFeatureSession = {
    open: () => false,
    disposed: () => false,
    snapshot: () => ({ phase: "closed" }),
    async select(request) {
      selects.push(request);
      const step = script.select?.shift();
      return typeof step === "function" ? step(request) : (step ?? null);
    },
    async prompt(request) {
      prompts.push(request);
      const step = script.prompt?.shift();
      return typeof step === "function" ? step(request) : (step ?? null);
    },
    async confirm(request) {
      confirms.push(request);
      const step = script.confirm?.shift();
      return typeof step === "function" ? step(request) : (step ?? false);
    },
    handleKey: () => false,
    handlePointer: () => false,
    dismiss: () => false,
    clear: () => clear(),
    setBusy: () => false,
    dispose: () => undefined,
  };
  return {
    dialogs,
    selects,
    prompts,
    confirms,
    onClear(callback: () => void) {
      clear = callback;
    },
  };
}

function harness(script: DialogScript, writeConfig?: (patch: AppConfigPatch) => void) {
  const config = parseAppConfig({});
  const dialogs = scriptedDialogs(script);
  const writes: AppConfigPatch[] = [];
  const previews: Array<readonly [number, number, number] | null> = [];
  const themes = [] as (typeof config.theme)[];
  const notes: string[] = [];
  const errors: Error[] = [];
  const beforeRun = vi.fn();
  const session = createSettingsFeatureSession({
    dialogs: dialogs.dialogs,
    readConfig: () => config,
    readNotificationPrefs: () => prefs,
    writeConfig: (patch) => {
      writes.push(patch);
      writeConfig?.(patch);
    },
    configureTheme: (theme) => themes.push(theme),
    setPreviewAccent: (rgb) => previews.push(rgb),
    setStatusNote: (note) => notes.push(note),
    kittyKeys: true,
    beforeRun,
    onError: (error) => errors.push(error),
  });
  return { session, config, dialogs, writes, previews, themes, notes, errors, beforeRun };
}

describe("deferred settings feature session", () => {
  it("previews, persists, and commits an accent through the dialog port", async () => {
    const h = harness({
      select: [
        (request) => {
          const item = request.items.find((candidate) => candidate.id === "colour114")!;
          request.onMove?.(item);
          return { item };
        },
      ],
    });
    await expect(h.session.run("settings-theme")).resolves.toEqual({
      status: "completed",
      command: "settings-theme",
      changed: true,
    });
    expect(h.previews).toEqual([[95, 175, 255], [135, 215, 135], null]);
    expect(h.writes).toEqual([{ theme: { accent: "colour114" } }]);
    expect(h.themes.at(-1)).toMatchObject({ accent: "colour114" });
    expect(h.notes).toEqual(["accent saved — chrome and terminals updated"]);
    expect(h.beforeRun).toHaveBeenCalledOnce();
  });

  it("rolls a live theme preview back on cancel", async () => {
    const h = harness({
      select: [
        (request) => {
          request.onMove?.(request.items.find((item) => item.id === "colour114")!);
          return null;
        },
      ],
    });
    await expect(h.session.run("settings-theme")).resolves.toMatchObject({
      status: "cancelled",
      changed: false,
    });
    expect(h.writes).toEqual([]);
    expect(h.previews.at(-1)).toBeNull();
    expect(h.themes.at(-1)).toEqual(h.config.theme);
  });

  it("rolls preview back and returns a typed error when persistence fails", async () => {
    const h = harness({ select: [picked("colour114", "Soft green")] }, () => {
      throw new Error("disk full");
    });
    const result = await h.session.run("settings-theme");
    expect(result).toMatchObject({
      status: "error",
      changed: false,
      error: { message: "disk full" },
    });
    expect(h.previews.at(-1)).toBeNull();
    expect(h.themes.at(-1)).toEqual(h.config.theme);
    expect(h.errors).toHaveLength(1);
  });

  it("preserves quiet-hour validation and the two-prompt persistence flow", async () => {
    const h = harness({
      select: [picked("window")],
      prompt: [
        (request) => {
          expect(request.validate?.("25:00")).toBeTruthy();
          expect(request.validate?.("22:00")).toBeNull();
          return "22:00";
        },
        (request) => {
          expect(request.validate?.("08:00")).toBeNull();
          return "08:00";
        },
      ],
    });
    await expect(h.session.run("settings-quiet-hours")).resolves.toMatchObject({
      status: "completed",
      changed: true,
    });
    expect(h.writes).toEqual([{ notifications: { quietHours: { start: "22:00", end: "08:00" } } }]);
  });

  it("keeps notification subflows fresh and records partial changes before cancel", async () => {
    const h = harness({
      select: [picked("enabled", "All notifications"), picked("sound"), picked("all"), null],
    });
    await expect(h.session.run("settings-notifications")).resolves.toMatchObject({
      status: "cancelled",
      changed: true,
    });
    expect(h.writes).toEqual([
      { notifications: { enabled: false } },
      { notifications: { sound: "all" } },
    ]);
    expect(h.dialogs.selects).toHaveLength(4);
  });

  it("preserves update, restore, key-viewer, and reset effects", async () => {
    const updates = harness({
      select: [picked("check"), picked("tickMs"), picked("snapshotEvery"), null],
      prompt: [
        (request) => {
          expect(request.validate?.("249")).toBeTruthy();
          return "500";
        },
        (request) => {
          expect(request.validate?.("0")).toBeTruthy();
          return "20";
        },
      ],
    });
    await updates.session.run("settings-updates");
    expect(updates.writes).toEqual([
      { updates: { check: false } },
      { updater: { tickMs: 500 } },
      { updater: { snapshotEvery: 20 } },
    ]);

    const restore = harness({ select: [picked("off")] });
    await expect(restore.session.run("settings-restore")).resolves.toMatchObject({
      status: "completed",
      changed: true,
    });
    expect(restore.writes).toEqual([{ restore: { resumeAgents: false } }]);

    const keys = harness({ select: [null] });
    await keys.session.run("settings-keys");
    expect(keys.dialogs.selects[0]!.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Command palette", detail: "F5 · ^p · ⌘K" }),
      ]),
    );
    expect(keys.writes).toEqual([]);

    const reset = harness({ confirm: [true] });
    await reset.session.run("settings-reset");
    expect(reset.writes).toEqual([
      {
        theme: undefined,
        notifications: undefined,
        updater: undefined,
        updates: undefined,
        restore: undefined,
      },
    ]);
  });

  it("returns from a read-only leaf to the umbrella before root cancellation", async () => {
    const h = harness({ select: [picked("settings-keys"), null, null] });
    await expect(h.session.run("settings")).resolves.toEqual({
      status: "cancelled",
      command: "settings",
      changed: false,
    });
    expect(h.dialogs.selects.map((request) => request.title)).toEqual([
      "Settings",
      "Keyboard shortcuts",
      "Settings",
    ]);
  });

  it("disposes a pending run, clears its modal, and rolls back preview", async () => {
    let resolve!: (value: DialogSelectResult | null) => void;
    const h = harness({
      select: [
        (request) => {
          request.onMove?.(request.items.find((item) => item.id === "colour114")!);
          return new Promise<DialogSelectResult | null>((done) => {
            resolve = done;
          });
        },
      ],
    });
    h.dialogs.onClear(() => resolve(null));
    const running = h.session.run("settings-theme");
    expect(h.session.busy()).toBe(true);
    h.session.dispose();
    h.session.dispose();
    await expect(running).resolves.toMatchObject({ status: "disposed", changed: false });
    expect(h.session.busy()).toBe(false);
    expect(h.session.disposed()).toBe(true);
    expect(h.previews.at(-1)).toBeNull();
    expect(h.themes.at(-1)).toEqual(h.config.theme);
    await expect(h.session.run("settings-reset")).resolves.toMatchObject({ status: "disposed" });
  });
});
