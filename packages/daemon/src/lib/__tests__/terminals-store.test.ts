/**
 * terminals-store unit tests (G20-P1).
 *
 * Drives the JSON-backed registry through a temp-dir workspace.
 * Covers idempotent upsert, rename round-trip, delete return value,
 * and the safe-id guard (invalid ids must throw).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteTerminal,
  findTerminal,
  loadTerminals,
  renameTerminal,
  upsertTerminal,
} from "../terminals-store";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tmux-ide-terminals-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("terminals-store", () => {
  it("returns empty list when no file exists yet", () => {
    expect(loadTerminals(dir)).toEqual([]);
  });

  it("upsert creates and round-trips through load", () => {
    const created = upsertTerminal(dir, {
      id: "shell-1",
      projectId: "proj",
      scopeId: "/dir",
      name: "shell",
      kind: "shell",
    });
    expect(created.id).toBe("shell-1");
    expect(loadTerminals(dir)).toHaveLength(1);
    expect(findTerminal(dir, "shell-1")?.name).toBe("shell");
    // JSON file on disk is human-readable + pretty-printed.
    const raw = readFileSync(join(dir, ".tmux-ide", "terminals.json"), "utf-8");
    expect(raw).toContain('"id": "shell-1"');
  });

  it("upsert is idempotent on the same id (createdAt stable, updatedAt advances)", async () => {
    const a = upsertTerminal(dir, {
      id: "shell-1",
      projectId: "proj",
      scopeId: "/dir",
      name: "shell",
      kind: "shell",
    });
    await new Promise((r) => setTimeout(r, 5));
    const b = upsertTerminal(dir, {
      id: "shell-1",
      projectId: "proj",
      scopeId: "/dir",
      name: "shell renamed",
      kind: "shell",
    });
    expect(loadTerminals(dir)).toHaveLength(1);
    expect(b.createdAt).toBe(a.createdAt);
    expect(b.updatedAt >= a.updatedAt).toBe(true);
    expect(b.name).toBe("shell renamed");
  });

  it("rename returns the new record or null when id is unknown", () => {
    upsertTerminal(dir, {
      id: "shell-1",
      projectId: "proj",
      scopeId: "/dir",
      name: "old",
      kind: "shell",
    });
    expect(renameTerminal(dir, "shell-1", "new")?.name).toBe("new");
    expect(renameTerminal(dir, "missing", "x")).toBeNull();
  });

  it("delete returns false when id is unknown", () => {
    expect(deleteTerminal(dir, "missing")).toBe(false);
    upsertTerminal(dir, {
      id: "shell-1",
      projectId: "proj",
      scopeId: "/dir",
      name: "shell",
      kind: "shell",
    });
    expect(deleteTerminal(dir, "shell-1")).toBe(true);
    expect(loadTerminals(dir)).toEqual([]);
  });

  it("rejects unsafe ids at insert time", () => {
    expect(() =>
      upsertTerminal(dir, {
        id: "../escape",
        projectId: "proj",
        scopeId: "/dir",
        name: "x",
        kind: "shell",
      }),
    ).toThrow(/invalid terminal id/);
  });

  it("marks `scripted: true` when the input opts in", () => {
    const t = upsertTerminal(dir, {
      id: "scripted-1",
      projectId: "proj",
      scopeId: "/dir",
      name: "run",
      kind: "run",
      scripted: true,
    });
    expect(t.scripted).toBe(true);
    expect(loadTerminals(dir)[0]!.scripted).toBe(true);
  });
});
