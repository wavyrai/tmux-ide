import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { _setListSessions, listInstances, nextInstanceName } from "./session-instances.ts";

let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
});

function mockSessions(names: string[]) {
  restore = _setListSessions(() => names.join("\n"));
}

function mockNoServer() {
  restore = _setListSessions(() => {
    throw new Error("no server running");
  });
}

describe("listInstances", () => {
  it("returns empty array when tmux is not running", () => {
    mockNoServer();
    assert.deepEqual(listInstances("myproject"), []);
  });

  it("returns empty array when no sessions match", () => {
    mockSessions(["other-project", "unrelated"]);
    assert.deepEqual(listInstances("myproject"), []);
  });

  it("returns exact match only", () => {
    mockSessions(["myproject", "other"]);
    assert.deepEqual(listInstances("myproject"), ["myproject"]);
  });

  it("returns base and numbered instances sorted", () => {
    mockSessions(["myproject-3", "myproject", "myproject-1", "other"]);
    assert.deepEqual(listInstances("myproject"), ["myproject", "myproject-1", "myproject-3"]);
  });

  it("does not match partial name overlaps", () => {
    mockSessions(["myproject-extra", "myproject-1", "myprojectfoo"]);
    assert.deepEqual(listInstances("myproject"), ["myproject-1"]);
  });

  it("handles names with regex-special characters", () => {
    mockSessions(["my.project", "my.project-1", "myXproject"]);
    assert.deepEqual(listInstances("my.project"), ["my.project", "my.project-1"]);
  });
});

describe("nextInstanceName", () => {
  it("returns baseName-1 when no instances exist", () => {
    mockNoServer();
    assert.equal(nextInstanceName("myproject"), "myproject-1");
  });

  it("returns baseName-1 when only base exists", () => {
    mockSessions(["myproject"]);
    assert.equal(nextInstanceName("myproject"), "myproject-1");
  });

  it("returns baseName-2 when baseName-1 exists", () => {
    mockSessions(["myproject", "myproject-1"]);
    assert.equal(nextInstanceName("myproject"), "myproject-2");
  });

  it("fills in after the highest index, not gaps", () => {
    mockSessions(["myproject-1", "myproject-5"]);
    assert.equal(nextInstanceName("myproject"), "myproject-6");
  });
});
