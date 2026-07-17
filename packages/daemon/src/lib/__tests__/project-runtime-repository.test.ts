import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectResolution } from "../project-resolver.ts";
import {
  CorruptEventLogError,
  DocumentRevisionConflictError,
  EventSequenceConflictError,
  ProjectRuntimeRepositoryError,
  createProjectRuntimeRepository,
  openProjectRuntimeRepository,
  type JsonValue,
} from "../project-runtime-repository.ts";

const roots: string[] = [];
const IDENTITY_KEY = `git-${"a".repeat(64)}`;

function temporaryRoot(prefix = "tmux-ide-runtime-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function resolution(
  projectRoot: string,
  overrides: Partial<ProjectResolution> = {},
): ProjectResolution {
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
    ...overrides,
  };
}

function writeRaw(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf-8");
}

function caughtError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected action to throw");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ProjectRuntimeRepository identity and location", () => {
  it("stores runtime data below TMUX_IDE_HOME and never pollutes the checkout", () => {
    const project = temporaryRoot("tmux-ide-project-");
    const home = temporaryRoot("tmux-ide-home-");
    const previous = process.env.TMUX_IDE_HOME;
    process.env.TMUX_IDE_HOME = home;
    try {
      const repository = createProjectRuntimeRepository(resolution(project));

      expect(repository.metadata.runtimeRoot).toBe(join(home, "projects", IDENTITY_KEY));
      repository.writeDocument("ui-state.json", { selected: "T-1" }, { expectedRevision: null });

      expect(existsSync(join(home, "projects", IDENTITY_KEY, "ui-state.json"))).toBe(true);
      expect(existsSync(join(project, ".tmux-ide"))).toBe(false);
      expect(existsSync(join(project, ".tasks"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.TMUX_IDE_HOME;
      else process.env.TMUX_IDE_HOME = previous;
    }
  });

  it("maps linked worktrees with one C01 identity to the same runtime root", () => {
    const home = temporaryRoot("tmux-ide-home-");
    const main = temporaryRoot("tmux-ide-main-");
    const linked = temporaryRoot("tmux-ide-linked-");
    const commonAnchor = join(main, ".git");
    const first = createProjectRuntimeRepository(
      resolution(main, { identityAnchor: commonAnchor }),
      { home },
    );
    const second = createProjectRuntimeRepository(
      resolution(linked, { identityAnchor: commonAnchor }),
      { home },
    );

    expect(first.metadata.runtimeRoot).toBe(second.metadata.runtimeRoot);
    expect(first.metadata.projectRoot).not.toBe(second.metadata.projectRoot);
  });

  it("offers a convenience opener backed by the C01 resolver", async () => {
    const project = temporaryRoot("tmux-ide-project-");
    const home = temporaryRoot("tmux-ide-home-");
    const repository = await openProjectRuntimeRepository(project, {
      home,
      resolverIo: {
        exists: () => false,
        realpath: (path) => path,
        runGit: async () => null,
      },
    });

    expect(repository.metadata.identitySource).toBe("canonical-realpath");
    expect(repository.metadata.runtimeRoot).toContain(join(home, "projects", "path-"));
  });
});

describe("ProjectRuntimeRepository documents", () => {
  it("creates, reads, updates, reopens, and detaches values", () => {
    const home = temporaryRoot("tmux-ide-home-");
    const project = temporaryRoot("tmux-ide-project-");
    const first = createProjectRuntimeRepository(resolution(project), { home });
    const input = { nested: { count: 1 }, labels: ["a"] };

    const created = first.writeDocument("missions/m-1/mission.json", input, {
      expectedRevision: null,
    });
    input.nested.count = 99;
    created.payload.labels.push("returned-mutation");

    const read = first.readRequiredDocument<typeof input>("missions/m-1/mission.json");
    expect(read).toMatchObject({
      revision: 1,
      payload: { nested: { count: 1 }, labels: ["a"] },
    });
    read.payload.nested.count = 42;

    const second = createProjectRuntimeRepository(resolution(project), { home });
    const updated = second.writeDocument(
      "missions/m-1/mission.json",
      { nested: { count: 2 }, labels: ["b"] },
      { expectedRevision: 1 },
    );
    expect(updated.revision).toBe(2);
    expect(first.readRequiredDocument("missions/m-1/mission.json")).toMatchObject({
      revision: 2,
      payload: { nested: { count: 2 }, labels: ["b"] },
    });
    expect(first.readDocument("missing.json")).toEqual({
      found: false,
      path: "missing.json",
      revision: null,
    });
    expect(caughtError(() => first.readRequiredDocument("missing.json"))).toMatchObject({
      code: "DOCUMENT_MISSING",
      path: "missing.json",
    });
  });

  it("uses a unique temp file and cleans it after an injected rename failure", () => {
    const home = temporaryRoot("tmux-ide-home-");
    const project = temporaryRoot("tmux-ide-project-");
    const operations: string[] = [];
    const repository = createProjectRuntimeRepository(resolution(project), {
      home,
      io: {
        randomId: () => "attempt-1",
        writeFile: (path, contents) => {
          operations.push(`write:${path}`);
          writeFileSync(path, contents, "utf-8");
        },
        rename: (from, to) => {
          operations.push(`rename:${from}->${to}`);
          throw new Error("injected rename failure");
        },
      },
    });

    expect(
      caughtError(() =>
        repository.writeDocument("bindings.json", { task: "T-1" }, { expectedRevision: null }),
      ),
    ).toMatchObject({ code: "IO_ERROR", path: "bindings.json" });
    const directory = join(home, "projects", IDENTITY_KEY);
    expect(readdirSync(directory)).toEqual([]);
    expect(operations[0]).toContain("write:");
    expect(operations[0]).toContain(".tmp-");
    expect(operations[1]).toContain("rename:");
    expect(existsSync(join(directory, "bindings.json"))).toBe(false);
  });

  it("detects create-only and stale revision conflicts across instances", () => {
    const home = temporaryRoot("tmux-ide-home-");
    const project = temporaryRoot("tmux-ide-project-");
    const first = createProjectRuntimeRepository(resolution(project), { home });
    const second = createProjectRuntimeRepository(resolution(project), { home });
    first.writeDocument("ui-state.json", { tab: "home" }, { expectedRevision: null });

    expect(() =>
      second.writeDocument("ui-state.json", { tab: "files" }, { expectedRevision: null }),
    ).toThrow(DocumentRevisionConflictError);
    try {
      second.writeDocument("ui-state.json", { tab: "files" }, { expectedRevision: null });
    } catch (error) {
      expect(error).toMatchObject({
        code: "REVISION_CONFLICT",
        path: "ui-state.json",
        expectedRevision: null,
        actualRevision: 1,
      });
    }

    first.writeDocument("ui-state.json", { tab: "files" }, { expectedRevision: 1 });
    expect(
      caughtError(() =>
        second.writeDocument("ui-state.json", { tab: "diff" }, { expectedRevision: 1 }),
      ),
    ).toMatchObject({ expectedRevision: 1, actualRevision: 2 });
  });

  it.each(["../escape.json", "/tmp/escape.json", "a//b.json", "a/./b.json", "a\\b.json", "bad\0x"])(
    "rejects unsafe document path %j",
    (path) => {
      const repository = createProjectRuntimeRepository(resolution(temporaryRoot()), {
        home: temporaryRoot(),
      });
      expect(caughtError(() => repository.readDocument(path))).toMatchObject({
        code: "INVALID_PATH",
        path,
      });
    },
  );

  it("reserves events/ for event streams", () => {
    const repository = createProjectRuntimeRepository(resolution(temporaryRoot()), {
      home: temporaryRoot(),
    });
    expect(caughtError(() => repository.readDocument("events/mission-1.jsonl"))).toMatchObject({
      code: "INVALID_PATH",
      path: "events/mission-1.jsonl",
    });
  });

  it("rejects an existing symbolic-link segment that escapes the runtime root", () => {
    const home = temporaryRoot("tmux-ide-home-");
    const outside = temporaryRoot("tmux-ide-outside-");
    const repository = createProjectRuntimeRepository(resolution(temporaryRoot()), { home });
    mkdirSync(repository.metadata.runtimeRoot, { recursive: true });
    symlinkSync(outside, join(repository.metadata.runtimeRoot, "linked"), "dir");
    writeRaw(
      join(outside, "secret.json"),
      JSON.stringify({ version: 1, revision: 1, payload: {} }),
    );

    expect(caughtError(() => repository.readDocument("linked/secret.json"))).toMatchObject({
      code: "INVALID_PATH",
      path: "linked/secret.json",
    });
    expect(
      caughtError(() =>
        repository.writeDocument("linked/new.json", {}, { expectedRevision: null }),
      ),
    ).toMatchObject({ code: "INVALID_PATH", path: "linked/new.json" });
    expect(existsSync(join(outside, "new.json"))).toBe(false);
  });

  it("wraps non-missing read failures in a typed IO error", () => {
    const repository = createProjectRuntimeRepository(resolution(temporaryRoot()), {
      home: temporaryRoot(),
      io: {
        readFile: () => {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        },
      },
    });
    expect(caughtError(() => repository.readDocument("ui-state.json"))).toMatchObject({
      code: "IO_ERROR",
      path: "ui-state.json",
    });
  });

  it("distinguishes malformed and unsupported document envelopes from missing data", () => {
    const home = temporaryRoot("tmux-ide-home-");
    const repository = createProjectRuntimeRepository(resolution(temporaryRoot()), { home });
    const root = repository.metadata.runtimeRoot;

    writeRaw(join(root, "broken.json"), "{not-json\n");
    expect(caughtError(() => repository.readDocument("broken.json"))).toMatchObject({
      code: "DOCUMENT_CORRUPT",
      path: "broken.json",
    });

    writeRaw(join(root, "future.json"), JSON.stringify({ version: 2, revision: 1, payload: {} }));
    expect(caughtError(() => repository.readDocument("future.json"))).toMatchObject({
      code: "UNSUPPORTED_DOCUMENT_VERSION",
      path: "future.json",
    });

    writeRaw(
      join(root, "bad-revision.json"),
      JSON.stringify({ version: 1, revision: 0, payload: {} }),
    );
    expect(caughtError(() => repository.readDocument("bad-revision.json"))).toMatchObject({
      code: "DOCUMENT_CORRUPT",
      path: "bad-revision.json",
    });
  });

  it.each([
    ["undefined", undefined],
    ["bigint", 1n],
    ["infinity", Number.POSITIVE_INFINITY],
    ["date", new Date()],
    ["function", () => undefined],
    ["sparse array", new Array(1)],
  ])("rejects %s payloads without writing", (_label, value) => {
    const home = temporaryRoot("tmux-ide-home-");
    const repository = createProjectRuntimeRepository(resolution(temporaryRoot()), { home });
    expect(
      caughtError(() =>
        repository.writeDocument("invalid.json", value as never, { expectedRevision: null }),
      ),
    ).toMatchObject({ code: "INVALID_JSON_VALUE" });
    expect(existsSync(join(repository.metadata.runtimeRoot, "invalid.json"))).toBe(false);
  });

  it("rejects cyclic payloads with a typed error instead of RangeError", () => {
    const home = temporaryRoot("tmux-ide-home-");
    const repository = createProjectRuntimeRepository(resolution(temporaryRoot()), { home });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let caught: unknown;
    try {
      repository.writeDocument("cyclic.json", cyclic as JsonValue, { expectedRevision: null });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProjectRuntimeRepositoryError);
    expect(caught).not.toBeInstanceOf(RangeError);
    expect(caught).toMatchObject({ code: "INVALID_JSON_VALUE", valuePath: "$.self" });
  });
});

describe("ProjectRuntimeRepository event streams", () => {
  it("assigns durable ordered sequences across reopen and separate instances", () => {
    const home = temporaryRoot("tmux-ide-home-");
    const project = temporaryRoot("tmux-ide-project-");
    const times = [
      new Date("2026-07-17T10:00:00.000Z"),
      new Date("2026-07-17T10:00:01.000Z"),
      new Date("2026-07-17T10:00:02.000Z"),
    ];
    const first = createProjectRuntimeRepository(resolution(project), {
      home,
      io: { now: () => times.shift()! },
    });
    const input = { type: "created", nested: { id: "T-1" } };
    const event1 = first.appendEvent("mission-1", input, { expectedPreviousSequence: 0 });
    input.nested.id = "mutated";
    event1.payload.nested.id = "returned-mutation";
    first.appendEvent("mission-1", { type: "claimed" }, { expectedPreviousSequence: 1 });

    const reopened = createProjectRuntimeRepository(resolution(project), {
      home,
      io: { now: () => times.shift()! },
    });
    const event3 = reopened.appendEvent(
      "mission-1",
      { type: "submitted" },
      {
        expectedPreviousSequence: 2,
      },
    );
    expect(event3.sequence).toBe(3);
    expect(first.readEvents("mission-1")).toEqual([
      {
        version: 1,
        sequence: 1,
        timestamp: "2026-07-17T10:00:00.000Z",
        payload: { type: "created", nested: { id: "T-1" } },
      },
      {
        version: 1,
        sequence: 2,
        timestamp: "2026-07-17T10:00:01.000Z",
        payload: { type: "claimed" },
      },
      {
        version: 1,
        sequence: 3,
        timestamp: "2026-07-17T10:00:02.000Z",
        payload: { type: "submitted" },
      },
    ]);
  });

  it("raises a typed expected-sequence conflict", () => {
    const home = temporaryRoot("tmux-ide-home-");
    const repository = createProjectRuntimeRepository(resolution(temporaryRoot()), { home });
    repository.appendEvent("mission-1", { type: "created" });

    expect(() =>
      repository.appendEvent("mission-1", { type: "stale" }, { expectedPreviousSequence: 0 }),
    ).toThrow(EventSequenceConflictError);
    try {
      repository.appendEvent("mission-1", { type: "stale" }, { expectedPreviousSequence: 0 });
    } catch (error) {
      expect(error).toMatchObject({
        code: "EVENT_SEQUENCE_CONFLICT",
        stream: "mission-1",
        expectedPreviousSequence: 0,
        actualPreviousSequence: 1,
      });
    }
  });

  it.each(["../escape", "nested/stream", "\\escape", ".", "", "bad\0id"])(
    "rejects unsafe event stream id %j",
    (stream) => {
      const repository = createProjectRuntimeRepository(resolution(temporaryRoot()), {
        home: temporaryRoot(),
      });
      expect(caughtError(() => repository.readEvents(stream))).toMatchObject({
        code: "INVALID_PATH",
        stream,
      });
    },
  );

  it.each([
    ["malformed JSON", "{nope\n", 1],
    [
      "duplicate sequence",
      [
        { version: 1, sequence: 1, timestamp: "2026-01-01T00:00:00.000Z", payload: {} },
        { version: 1, sequence: 1, timestamp: "2026-01-01T00:00:01.000Z", payload: {} },
      ]
        .map(JSON.stringify)
        .join("\n") + "\n",
      2,
    ],
    [
      "gapped sequence",
      [
        { version: 1, sequence: 1, timestamp: "2026-01-01T00:00:00.000Z", payload: {} },
        { version: 1, sequence: 3, timestamp: "2026-01-01T00:00:01.000Z", payload: {} },
      ]
        .map(JSON.stringify)
        .join("\n") + "\n",
      2,
    ],
    [
      "out-of-order sequence",
      [
        { version: 1, sequence: 2, timestamp: "2026-01-01T00:00:00.000Z", payload: {} },
        { version: 1, sequence: 1, timestamp: "2026-01-01T00:00:01.000Z", payload: {} },
      ]
        .map(JSON.stringify)
        .join("\n") + "\n",
      1,
    ],
  ])("rejects %s with stream and line context", (_label, contents, line) => {
    const home = temporaryRoot("tmux-ide-home-");
    const repository = createProjectRuntimeRepository(resolution(temporaryRoot()), { home });
    writeRaw(join(repository.metadata.runtimeRoot, "events", "mission-1.jsonl"), contents);

    let caught: unknown;
    try {
      repository.readEvents("mission-1");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CorruptEventLogError);
    expect(caught).toMatchObject({
      code: "EVENT_LOG_CORRUPT",
      stream: "mission-1",
      lineNumber: line,
    });
  });

  it.each([
    [
      "unsupported event version",
      { version: 2, sequence: 1, timestamp: "2026-01-01T00:00:00.000Z", payload: {} },
    ],
    [
      "non-canonical timestamp",
      { version: 1, sequence: 1, timestamp: "January 1, 2026", payload: {} },
    ],
  ])("rejects %s with typed event-log corruption", (_label, record) => {
    const repository = createProjectRuntimeRepository(resolution(temporaryRoot()), {
      home: temporaryRoot(),
    });
    writeRaw(
      join(repository.metadata.runtimeRoot, "events", "mission-1.jsonl"),
      `${JSON.stringify(record)}\n`,
    );
    expect(caughtError(() => repository.readEvents("mission-1"))).toMatchObject({
      code: "EVENT_LOG_CORRUPT",
      stream: "mission-1",
      lineNumber: 1,
    });
  });

  it("atomically replaces the JSONL stream without leaving temp files", () => {
    const home = temporaryRoot("tmux-ide-home-");
    const project = temporaryRoot("tmux-ide-project-");
    const operations: string[] = [];
    const repository = createProjectRuntimeRepository(resolution(project), {
      home,
      io: {
        randomId: () => "event-write",
        rename: (from, to) => {
          operations.push(`${from}->${to}`);
          renameSync(from, to);
        },
      },
    });
    repository.appendEvent("mission-1", { type: "created" });

    const eventsDir = join(repository.metadata.runtimeRoot, "events");
    expect(operations).toHaveLength(1);
    expect(operations[0]).toContain(".tmp-");
    expect(readdirSync(eventsDir)).toEqual(["mission-1.jsonl"]);
    expect(readFileSync(join(eventsDir, "mission-1.jsonl"), "utf-8")).toMatch(/"sequence":1/u);
  });
});
