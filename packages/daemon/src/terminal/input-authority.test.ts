import { describe, expect, it } from "vitest";
import { TerminalInputAuthority, TerminalInputAuthorityConflictError } from "./input-authority.ts";

describe("TerminalInputAuthority", () => {
  it("serializes input per live window across transports", () => {
    const authority = new TerminalInputAuthority();
    authority.claim({ transport: "terminal-attachment", leaseId: "attach-a" }, ["@1"]);

    expect(() =>
      authority.claim({ transport: "pane-stream", leaseId: "stream-b" }, ["@1"]),
    ).toThrow(TerminalInputAuthorityConflictError);
    expect(() =>
      authority.claim({ transport: "pane-stream", leaseId: "stream-c" }, ["@2"]),
    ).not.toThrow();
  });

  it("claims a multi-window set atomically and releases it completely", () => {
    const authority = new TerminalInputAuthority();
    authority.claim({ transport: "pane-stream", leaseId: "stream-a" }, ["@1", "@2"]);
    expect(() =>
      authority.claim({ transport: "terminal-attachment", leaseId: "attach-b" }, ["@2", "@3"]),
    ).toThrow(TerminalInputAuthorityConflictError);
    expect(authority.snapshot().owners).toHaveLength(1);

    authority.release({ transport: "pane-stream", leaseId: "stream-a" });
    expect(() =>
      authority.claim({ transport: "terminal-attachment", leaseId: "attach-b" }, ["@2", "@3"]),
    ).not.toThrow();
  });

  it("reserves a rebound window before retiring the old one", () => {
    const authority = new TerminalInputAuthority();
    const owner = { transport: "terminal-attachment" as const, leaseId: "attach-a" };
    authority.claim(owner, ["@1"]);
    authority.claim(owner, ["@2"]);
    expect(authority.snapshot().owners[0]!.runtimeWindowIds).toEqual(["@1", "@2"]);

    authority.replace(owner, ["@2"]);
    expect(() =>
      authority.claim({ transport: "pane-stream", leaseId: "stream-b" }, ["@1"]),
    ).not.toThrow();
  });
});
