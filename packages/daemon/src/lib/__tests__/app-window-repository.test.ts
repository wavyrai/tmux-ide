import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectResolution } from "../project-resolver.ts";
import { createProjectRuntimeRepository } from "../project-runtime-repository.ts";
import { applyAppWindowCommand } from "../app-window-kernel.ts";
import {
  APP_WINDOW_DOCUMENT_PATH,
  AppWindowService,
  loadAppWindowDocument,
  resetAppWindowDocument,
  writeAppWindowDocument,
} from "../app-window-repository.ts";
import {
  emptyAppWindowDocument,
  serializeAppWindowDocument,
} from "../../tui/mirror/app-window-state.ts";

const roots: string[] = [];
const IDENTITY_KEY = `git-${"f".repeat(64)}`;
const NOW = "2026-07-20T12:00:00.000Z";
const LATER = "2026-07-20T12:01:00.000Z";

function temporaryRoot(prefix = "app-window-repository-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function resolution(projectRoot: string): ProjectResolution {
  return {
    inputDir: projectRoot,
    projectRoot,
    identityKey: IDENTITY_KEY,
    identitySource: "git-common-dir",
    identityAnchor: join(projectRoot, ".git"),
    config: { kind: "none", path: null, explicit: false },
    workspaceConfigPath: null,
    legacyConfigPath: null,
    hasLegacyConfigAtInput: false,
  };
}

function legacyWorkspaceUiState() {
  return {
    version: 2,
    active: { viewId: "terminals", panel: "terminals" },
    dock: {
      activeTab: "changes",
      mode: "open",
      preferredHeight: 11,
      focusZone: "canvas",
    },
    surfaces: {},
    views: { files: { panel: "files" }, diff: { panel: "diff" } },
  };
}

function repositoryPair() {
  const home = temporaryRoot("app-window-home-");
  const project = temporaryRoot("app-window-project-");
  return {
    home,
    first: createProjectRuntimeRepository(resolution(project), { home }),
    second: createProjectRuntimeRepository(resolution(project), { home }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("app window repository migration and CAS", () => {
  it("atomically creates its own document by first-load migration only when absent", () => {
    const { first } = repositoryPair();
    first.writeDocument("ui/workspace.json", legacyWorkspaceUiState(), {
      expectedRevision: null,
    });
    const service = new AppWindowService(first, {
      now: () => NOW,
      migration: {
        terminalSourceIds: ["agent-lead", "agent-worker"],
        focusedTerminalSourceId: "agent-worker",
      },
    });

    const migrated = service.load();
    const persisted = first.readRequiredDocument<unknown>(APP_WINDOW_DOCUMENT_PATH);
    first.writeDocument("ui/workspace.json", { version: 2, active: null }, { expectedRevision: 1 });
    const reopened = service.load();

    expect(migrated.revision).toBe(1);
    expect(persisted.payload).toEqual(JSON.parse(serializeAppWindowDocument(migrated.document)));
    expect(migrated.document.windows[migrated.document.focusedWindowId!]?.source).toEqual({
      kind: "terminal",
      terminalSourceId: "agent-worker",
    });
    expect(JSON.stringify(persisted.payload)).not.toContain("%pane");
    expect(reopened.document).toEqual(migrated.document);
    expect(reopened.revision).toBe(1);
  });

  it("enforces explicit revision CAS and observes external updates", () => {
    const { first, second } = repositoryPair();
    writeAppWindowDocument(first, null, emptyAppWindowDocument(NOW));
    const a = new AppWindowService(first, { now: () => LATER });
    const b = new AppWindowService(second, { now: () => LATER });
    const base = a.load();
    const external = b.execute(
      { type: "layout.save", layoutId: "external", name: "External" },
      { expectedRevision: base.revision },
    );

    expect(() =>
      a.execute(
        { type: "layout.save", layoutId: "stale", name: "Stale" },
        { expectedRevision: base.revision },
      ),
    ).toThrowError(expect.objectContaining({ code: "REVISION_CONFLICT" }));
    expect(a.load()).toMatchObject({ revision: external.revision });
    expect(a.load().document.layouts.external?.name).toBe("External");
  });

  it("re-reads and reapplies a semantic command after a bounded write race", () => {
    const { first } = repositoryPair();
    writeAppWindowDocument(first, null, emptyAppWindowDocument(NOW));
    const current = loadAppWindowDocument(first, { loadedAt: NOW });
    const external = applyAppWindowCommand(
      current.document,
      { type: "layout.save", layoutId: "external", name: "External" },
      LATER,
    );
    const externalPayload = JSON.parse(serializeAppWindowDocument(external));
    const originalWrite = first.writeDocument.bind(first);
    vi.spyOn(first, "writeDocument").mockImplementationOnce(((path, payload, options) => {
      originalWrite(path, externalPayload, { expectedRevision: current.revision });
      return originalWrite(path, payload, options);
    }) as typeof first.writeDocument);
    const service = new AppWindowService(first, { now: () => LATER });

    const saved = service.execute(
      { type: "layout.save", layoutId: "local", name: "Local" },
      { maxRetries: 2 },
    );

    expect(saved.revision).toBe(3);
    expect(Object.keys(saved.document.layouts)).toEqual(["external", "local"]);
    expect(saved.document.revision).toBe(2);
  });

  it("keeps the winner of a concurrent first-migration create race", () => {
    const { first, second } = repositoryPair();
    first.writeDocument("ui/workspace.json", legacyWorkspaceUiState(), {
      expectedRevision: null,
    });
    const winner = emptyAppWindowDocument(NOW);
    const originalWrite = first.writeDocument.bind(first);
    vi.spyOn(first, "writeDocument").mockImplementationOnce(((path, payload, options) => {
      writeAppWindowDocument(second, null, winner);
      return originalWrite(path, payload, options);
    }) as typeof first.writeDocument);

    const loaded = new AppWindowService(first, {
      now: () => NOW,
      migration: { terminalSourceIds: ["agent-lead"] },
    }).load();

    expect(loaded.document).toEqual(winner);
    expect(loaded.revision).toBe(1);
    expect(loaded.diagnostics).toEqual([]);
  });

  it("stops after the configured retry budget without partially applying the losing command", () => {
    const { first } = repositoryPair();
    writeAppWindowDocument(first, null, emptyAppWindowDocument(NOW));
    const originalWrite = first.writeDocument.bind(first);
    let races = 0;
    vi.spyOn(first, "writeDocument").mockImplementation(((path, payload, options) => {
      if (path !== APP_WINDOW_DOCUMENT_PATH) return originalWrite(path, payload, options);
      const current = loadAppWindowDocument(first, { loadedAt: LATER, migrateLegacy: false });
      races += 1;
      const external = applyAppWindowCommand(
        current.document,
        { type: "layout.save", layoutId: `external-${races}`, name: `External ${races}` },
        LATER,
      );
      originalWrite(path, JSON.parse(serializeAppWindowDocument(external)), {
        expectedRevision: current.revision,
      });
      return originalWrite(path, payload, options);
    }) as typeof first.writeDocument);

    expect(() =>
      new AppWindowService(first, { now: () => LATER }).execute(
        { type: "layout.save", layoutId: "local", name: "Local" },
        { maxRetries: 2 },
      ),
    ).toThrowError(expect.objectContaining({ code: "REVISION_CONFLICT" }));

    const final = loadAppWindowDocument(first, { loadedAt: LATER, migrateLegacy: false });
    expect(races).toBe(3);
    expect(final.document.revision).toBe(3);
    expect(final.document.layouts.local).toBeUndefined();
    expect(Object.keys(final.document.layouts)).toEqual(["external-1", "external-2", "external-3"]);
  });

  it("rejects skipped domain revisions and backwards timestamps even with a matching envelope CAS", () => {
    const { first } = repositoryPair();
    const written = writeAppWindowDocument(first, null, emptyAppWindowDocument(NOW));

    expect(() =>
      writeAppWindowDocument(first, written.revision, {
        ...written.document,
        revision: 2,
        updatedAt: LATER,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_DOCUMENT" }));
    expect(() =>
      writeAppWindowDocument(first, written.revision, {
        ...written.document,
        revision: 1,
        updatedAt: "2026-07-20T11:59:00.000Z",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_DOCUMENT" }));
    expect(first.readRequiredDocument(APP_WINDOW_DOCUMENT_PATH).revision).toBe(1);
  });

  it("rejects invalid CAS and retry controls with repository errors", () => {
    const { first } = repositoryPair();
    writeAppWindowDocument(first, null, emptyAppWindowDocument(NOW));
    const service = new AppWindowService(first, { now: () => LATER });

    expect(() =>
      service.execute(
        { type: "layout.save", layoutId: "review", name: "Review" },
        { expectedRevision: Number.NaN },
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_DOCUMENT" }));
    expect(() =>
      service.execute(
        { type: "layout.save", layoutId: "review", name: "Review" },
        { maxRetries: 9 },
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_DOCUMENT" }));
  });

  it("uses the shared project writer lock and preserves state on lock contention", () => {
    const { first } = repositoryPair();
    writeAppWindowDocument(first, null, emptyAppWindowDocument(NOW));
    const target = join(first.runtimeRoot, APP_WINDOW_DOCUMENT_PATH);
    const before = readFileSync(target, "utf-8");
    const lockPath = join(first.runtimeRoot, "workspace", ".state.lock");
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, "occupied by another writer\n", "utf-8");

    expect(() =>
      new AppWindowService(first, {
        now: () => LATER,
        writerLock: { timeoutMs: 1, pollMs: 1 },
      }).execute({ type: "layout.save", layoutId: "blocked", name: "Blocked" }),
    ).toThrowError(expect.objectContaining({ code: "WRITE_FAILED" }));
    expect(readFileSync(target, "utf-8")).toBe(before);
    expect(readFileSync(lockPath, "utf-8")).toBe("occupied by another writer\n");
  });
});

describe("app window write protection and recovery", () => {
  it("preserves future payloads until typed reset and backs up exact prior bytes", () => {
    const { first } = repositoryPair();
    first.writeDocument(
      APP_WINDOW_DOCUMENT_PATH,
      { version: 99, future: "keep-me" },
      {
        expectedRevision: null,
      },
    );
    const target = join(first.runtimeRoot, APP_WINDOW_DOCUMENT_PATH);
    const before = readFileSync(target, "utf-8");
    const loaded = loadAppWindowDocument(first, { loadedAt: NOW });

    expect(loaded.writeProtected).toBe(true);
    expect(loaded.preservedPayload).toEqual({ version: 99, future: "keep-me" });
    expect(() =>
      writeAppWindowDocument(first, loaded.revision, emptyAppWindowDocument(NOW)),
    ).toThrowError(expect.objectContaining({ code: "WRITE_PROTECTED" }));
    expect(readFileSync(target, "utf-8")).toBe(before);

    const reset = resetAppWindowDocument(first, {
      expectedRecoveryToken: loaded.recoveryToken!,
      reason: "future test payload requires explicit downgrade",
      resetAt: LATER,
    });
    expect(reset.writeProtected).toBe(false);
    expect(readFileSync(join(first.runtimeRoot, reset.backupPath), "utf-8")).toBe(before);
    const metadata = JSON.parse(readFileSync(join(first.runtimeRoot, reset.metadataPath), "utf-8"));
    expect(metadata).toMatchObject({
      version: 1,
      path: APP_WINDOW_DOCUMENT_PATH,
      previousRawSha256: loaded.recoveryToken,
      reason: "future test payload requires explicit downgrade",
      details: {
        diagnostics: [expect.objectContaining({ code: "UNSUPPORTED_VERSION" })],
      },
    });
    expect(loadAppWindowDocument(first, { loadedAt: LATER }).document).toEqual(reset.document);
  });

  it("write-protects a malformed current-version payload and preserves it for inspection", () => {
    const { first } = repositoryPair();
    const malformed = { version: 1, revision: 7, updatedAt: NOW, windows: "not-a-record" };
    first.writeDocument(APP_WINDOW_DOCUMENT_PATH, malformed, { expectedRevision: null });
    const target = join(first.runtimeRoot, APP_WINDOW_DOCUMENT_PATH);
    const before = readFileSync(target, "utf-8");

    const loaded = loadAppWindowDocument(first, { loadedAt: NOW });

    expect(loaded.writeProtected).toBe(true);
    expect(loaded.preservedPayload).toEqual(malformed);
    expect(loaded.diagnostics.some((entry) => entry.code === "INVALID_FIELD")).toBe(true);
    expect(() =>
      new AppWindowService(first, { now: () => LATER }).execute({
        type: "layout.save",
        layoutId: "unsafe",
        name: "Unsafe",
      }),
    ).toThrowError(expect.objectContaining({ code: "WRITE_PROTECTED" }));
    expect(readFileSync(target, "utf-8")).toBe(before);
  });

  it("recovers corrupt envelope bytes only with the exact inspected token", () => {
    const { first } = repositoryPair();
    const target = join(first.runtimeRoot, APP_WINDOW_DOCUMENT_PATH);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "{ definitely not json\n", "utf-8");
    const loaded = loadAppWindowDocument(first, { loadedAt: NOW });

    expect(loaded.writeProtected).toBe(true);
    expect(loaded.diagnostics[0]?.code).toBe("READ_FAILED");
    expect(() =>
      resetAppWindowDocument(first, {
        expectedRecoveryToken: "0".repeat(64),
        reason: "wrong token",
        resetAt: LATER,
      }),
    ).toThrowError(expect.objectContaining({ code: "RECOVERY_CONFLICT" }));

    const reset = resetAppWindowDocument(first, {
      expectedRecoveryToken: loaded.recoveryToken!,
      reason: "corrupt envelope confirmed by operator",
      resetAt: LATER,
    });
    expect(readFileSync(join(first.runtimeRoot, reset.backupPath), "utf-8")).toBe(
      "{ definitely not json\n",
    );
    expect(reset.revision).toBe(1);
  });

  it("rejects recovery when corrupt bytes change after inspection", () => {
    const { first } = repositoryPair();
    const target = join(first.runtimeRoot, APP_WINDOW_DOCUMENT_PATH);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "{ first corrupt value\n", "utf-8");
    const loaded = loadAppWindowDocument(first, { loadedAt: NOW });
    writeFileSync(target, "{ newer corrupt value\n", "utf-8");

    expect(() =>
      resetAppWindowDocument(first, {
        expectedRecoveryToken: loaded.recoveryToken!,
        reason: "stale operator inspection",
        resetAt: LATER,
      }),
    ).toThrowError(expect.objectContaining({ code: "RECOVERY_CONFLICT" }));
    expect(readFileSync(target, "utf-8")).toBe("{ newer corrupt value\n");
  });

  it("rechecks the byte token after backup and leaves a racing writer intact", () => {
    const { home, first } = repositoryPair();
    const target = join(first.runtimeRoot, APP_WINDOW_DOCUMENT_PATH);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "{ inspected corrupt value\n", "utf-8");
    const inspected = loadAppWindowDocument(first, { loadedAt: NOW });
    let targetReads = 0;
    const racing = createProjectRuntimeRepository(first.resolution, {
      home,
      io: {
        readFile: (path) => {
          if (path === target) {
            targetReads += 1;
            if (targetReads === 4) {
              writeFileSync(target, "{ concurrent corrupt value\n", "utf-8");
            }
          }
          return readFileSync(path, "utf-8");
        },
      },
    });

    expect(() =>
      resetAppWindowDocument(racing, {
        expectedRecoveryToken: inspected.recoveryToken!,
        reason: "recovery recheck race test",
        resetAt: LATER,
      }),
    ).toThrowError(expect.objectContaining({ code: "RECOVERY_CONFLICT" }));
    expect(targetReads).toBe(4);
    expect(readFileSync(target, "utf-8")).toBe("{ concurrent corrupt value\n");
  });

  it("never permits recovery of a valid writable document", () => {
    const { first } = repositoryPair();
    const written = writeAppWindowDocument(first, null, emptyAppWindowDocument(NOW));

    expect(() =>
      resetAppWindowDocument(first, {
        expectedRecoveryToken: written.recoveryToken!,
        reason: "should use normal CAS",
        resetAt: LATER,
      }),
    ).toThrowError(expect.objectContaining({ code: "RECOVERY_NOT_REQUIRED" }));
  });
});

describe("app window atomic failure", () => {
  it("leaves the prior document intact and cleans temp files after rename failure", () => {
    const { home, first } = repositoryPair();
    writeAppWindowDocument(first, null, emptyAppWindowDocument(NOW));
    const target = join(first.runtimeRoot, APP_WINDOW_DOCUMENT_PATH);
    const before = readFileSync(target, "utf-8");
    const failing = createProjectRuntimeRepository(first.resolution, {
      home,
      io: {
        rename: (from, to) => {
          if (to === target) throw new Error("simulated rename crash");
          renameSync(from, to);
        },
      },
    });
    const service = new AppWindowService(failing, { now: () => LATER });

    expect(() =>
      service.execute({ type: "layout.save", layoutId: "review", name: "Review" }),
    ).toThrowError(expect.objectContaining({ code: "WRITE_FAILED" }));
    expect(readFileSync(target, "utf-8")).toBe(before);
    expect(readdirSync(dirname(target)).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
  });

  it("does not touch the protected target when the exact-byte recovery backup fails", () => {
    const { home, first } = repositoryPair();
    const target = join(first.runtimeRoot, APP_WINDOW_DOCUMENT_PATH);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "{ protected bytes\n", "utf-8");
    const failing = createProjectRuntimeRepository(first.resolution, {
      home,
      io: {
        rename: (from, to) => {
          if (to.includes(join(first.runtimeRoot, "recovery")) && to.endsWith(".bak")) {
            throw new Error("simulated backup crash");
          }
          renameSync(from, to);
        },
      },
    });
    const loaded = loadAppWindowDocument(failing, { loadedAt: NOW });

    expect(() =>
      resetAppWindowDocument(failing, {
        expectedRecoveryToken: loaded.recoveryToken!,
        reason: "recovery backup failure test",
        resetAt: LATER,
      }),
    ).toThrowError(expect.objectContaining({ code: "WRITE_FAILED" }));
    expect(readFileSync(target, "utf-8")).toBe("{ protected bytes\n");
    expect(readdirSync(join(first.runtimeRoot, "recovery"))).toEqual([]);
  });

  it("retains the exact backup and protected target when final recovery replacement fails", () => {
    const { home, first } = repositoryPair();
    const target = join(first.runtimeRoot, APP_WINDOW_DOCUMENT_PATH);
    const before = "{ protected final bytes\n";
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, before, "utf-8");
    const failing = createProjectRuntimeRepository(first.resolution, {
      home,
      io: {
        rename: (from, to) => {
          if (to === target) throw new Error("simulated recovery replacement crash");
          renameSync(from, to);
        },
      },
    });
    const loaded = loadAppWindowDocument(failing, { loadedAt: NOW });

    expect(() =>
      resetAppWindowDocument(failing, {
        expectedRecoveryToken: loaded.recoveryToken!,
        reason: "recovery replacement failure test",
        resetAt: LATER,
      }),
    ).toThrowError(expect.objectContaining({ code: "WRITE_FAILED" }));
    expect(readFileSync(target, "utf-8")).toBe(before);
    const backups = readdirSync(join(first.runtimeRoot, "recovery")).filter((name) =>
      name.endsWith(".bak"),
    );
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(first.runtimeRoot, "recovery", backups[0]!), "utf-8")).toBe(before);
  });
});
