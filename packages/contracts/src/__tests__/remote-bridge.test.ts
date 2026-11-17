import { describe, expect, it } from "vitest";
import {
  REMOTE_CLIPBOARD_MAX_BYTES,
  RemoteBridgeCapabilitySchemaZ,
  RemoteBridgeClientFrameSchemaZ,
  RemoteBridgeServerFrameSchemaZ,
} from "../remote-bridge.ts";

const address = { session: "s", paneId: "pane.mirror.00", incarnation: "g:0" };

describe("remote bridge frames", () => {
  it("enumerates exactly the report frames the daemon may send", () => {
    const kinds = RemoteBridgeServerFrameSchemaZ.options.map((option) => option.shape.type.value);
    // A new kind must be added here on purpose, after checking it is a report.
    expect(kinds.sort()).toEqual(["clipboard.refused", "clipboard.write", "ready"]);
  });

  it("gives no daemon frame a request shape", () => {
    // Words a frame would need to ask the app for Mac data or to make it answer.
    const requestWords = new Set(
      "request query read get fetch ask reply respond want need pull paste upload".split(" "),
    );
    for (const option of RemoteBridgeServerFrameSchemaZ.options) {
      const names = [option.shape.type.value, ...Object.keys(option.shape)];
      for (const name of names)
        for (const word of words(name)) expect(requestWords.has(word), name).toBe(false);
      expect(field(option.shape, "id")).toBeUndefined();
      expect(field(option.shape, "requestId")).toBeUndefined();
    }
  });

  it("rejects extra fields so a frame cannot smuggle a request", () => {
    const frame = { type: "clipboard.write", ...address, bytes: 2, text: "hi" };
    expect(RemoteBridgeServerFrameSchemaZ.safeParse(frame).success).toBe(true);
    expect(
      RemoteBridgeServerFrameSchemaZ.safeParse({ ...frame, requestClipboard: true }).success,
    ).toBe(false);
  });

  it("bounds clipboard text to the decoded byte cap", () => {
    const base = { type: "clipboard.write", ...address, text: "x" };
    expect(
      RemoteBridgeServerFrameSchemaZ.safeParse({ ...base, bytes: REMOTE_CLIPBOARD_MAX_BYTES })
        .success,
    ).toBe(true);
    expect(
      RemoteBridgeServerFrameSchemaZ.safeParse({ ...base, bytes: REMOTE_CLIPBOARD_MAX_BYTES + 1 })
        .success,
    ).toBe(false);
    expect(RemoteBridgeServerFrameSchemaZ.safeParse({ ...base, bytes: 0 }).success).toBe(false);
  });

  it("accepts only the version 1 hello from the app", () => {
    expect(RemoteBridgeClientFrameSchemaZ.safeParse({ type: "hello", version: 1 }).success).toBe(
      true,
    );
    expect(RemoteBridgeClientFrameSchemaZ.safeParse({ type: "hello", version: 2 }).success).toBe(
      false,
    );
    expect(
      RemoteBridgeClientFrameSchemaZ.safeParse({ type: "hello", version: 1, x: 1 }).success,
    ).toBe(false);
  });

  it("advertises the bridge path and features", () => {
    expect(
      RemoteBridgeCapabilitySchemaZ.parse({
        version: 1,
        path: "/api/v2/bridge",
        features: ["clipboard-write"],
      }),
    ).toEqual({ version: 1, path: "/api/v2/bridge", features: ["clipboard-write"] });
  });
});

function words(name: string): string[] {
  return name
    .split(/[._-]|(?=[A-Z])/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

function field(shape: Record<string, unknown>, name: string): unknown {
  return shape[name];
}
