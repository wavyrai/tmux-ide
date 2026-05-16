import { describe, expect, it } from "vitest";
import {
  requestKindFromToolCall,
  resolveApprovalOptionId,
  toPendingApproval,
} from "../src/lib/pendingApproval";
import type { PermissionRequest } from "../src/types";

function request(options: PermissionRequest["options"], kind?: string): PermissionRequest {
  return {
    threadId: "t1",
    requestId: "r1",
    toolCall: { toolCallId: "tc1", title: "x", kind: kind ?? null },
    options,
    receivedAt: 0,
  };
}

const ALL_OPTIONS: PermissionRequest["options"] = [
  { optionId: "a1", name: "Allow once", kind: "allow_once" },
  { optionId: "aa", name: "Allow always", kind: "allow_always" },
  { optionId: "r1", name: "Reject once", kind: "reject_once" },
  { optionId: "ra", name: "Reject always", kind: "reject_always" },
];

describe("requestKindFromToolCall", () => {
  it("folds edit/delete/move into file-change", () => {
    expect(requestKindFromToolCall("edit")).toBe("file-change");
    expect(requestKindFromToolCall("delete")).toBe("file-change");
    expect(requestKindFromToolCall("move")).toBe("file-change");
  });

  it("folds read/search/fetch/think into file-read", () => {
    expect(requestKindFromToolCall("read")).toBe("file-read");
    expect(requestKindFromToolCall("search")).toBe("file-read");
    expect(requestKindFromToolCall("fetch")).toBe("file-read");
    expect(requestKindFromToolCall("think")).toBe("file-read");
  });

  it("defaults execute/other/unknown/absent to command", () => {
    expect(requestKindFromToolCall("execute")).toBe("command");
    expect(requestKindFromToolCall("other")).toBe("command");
    expect(requestKindFromToolCall("totally-unknown")).toBe("command");
    expect(requestKindFromToolCall(null)).toBe("command");
    expect(requestKindFromToolCall(undefined)).toBe("command");
  });
});

describe("toPendingApproval", () => {
  it("projects the request id and coarse kind", () => {
    expect(toPendingApproval(request(ALL_OPTIONS, "edit"))).toEqual({
      requestId: "r1",
      requestKind: "file-change",
    });
  });
});

describe("resolveApprovalOptionId", () => {
  it("maps each decision to its preferred option kind", () => {
    const req = request(ALL_OPTIONS);
    expect(resolveApprovalOptionId(req, "accept")).toBe("a1");
    expect(resolveApprovalOptionId(req, "acceptForSession")).toBe("aa");
    expect(resolveApprovalOptionId(req, "decline")).toBe("r1");
    expect(resolveApprovalOptionId(req, "cancel")).toBe("ra");
  });

  it("falls back to the next-closest option when the preferred kind is absent", () => {
    // Only allow_always offered → accept falls back to it.
    const onlyAlways = request([{ optionId: "aa", name: "Allow always", kind: "allow_always" }]);
    expect(resolveApprovalOptionId(onlyAlways, "accept")).toBe("aa");
    // Only reject_once offered → cancel falls back to it.
    const onlyRejectOnce = request([{ optionId: "r1", name: "Reject once", kind: "reject_once" }]);
    expect(resolveApprovalOptionId(onlyRejectOnce, "cancel")).toBe("r1");
  });

  it("returns null when no option of any acceptable kind is offered", () => {
    const noAllow = request([{ optionId: "r1", name: "Reject once", kind: "reject_once" }]);
    expect(resolveApprovalOptionId(noAllow, "accept")).toBeNull();
  });
});
