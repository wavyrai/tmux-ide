import { describe, expect, it } from "vitest";
import {
  PANE_STREAM_ISSUE_PATH,
  PANE_STREAM_MAX_HELD_DELTAS,
  PANE_STREAM_MAX_INPUT_TEXT_CHARS,
  PANE_STREAM_MAX_LAYOUT_PANES,
  PANE_STREAM_MAX_OUTPUT_BASE64_CHARS,
  PANE_STREAM_MAX_PANES,
  PANE_STREAM_PROTOCOL_VERSION,
  PANE_STREAM_REDEEM_PATH,
  PANE_STREAM_WEBSOCKET_SUBPROTOCOL,
  PaneStreamClientFrameSchemaZ,
  PaneStreamConsumedFrameSchemaZ,
  PaneStreamInputFrameSchemaZ,
  PaneStreamIssueDescriptorSchemaZ,
  PaneStreamIssueErrorSchemaZ,
  PaneStreamIssueMutationRequestSchemaZ,
  PaneStreamIssueResultSchemaZ,
  PaneStreamKeyNameSchemaZ,
  PaneStreamLeaseRequestSchemaZ,
  PaneStreamLoopbackWebSocketUrlSchemaZ,
  PaneStreamRedeemFrameSchemaZ,
  PaneStreamRedemptionTicketSchemaZ,
  PaneStreamSeedBatchFrameSchemaZ,
  PaneStreamServerFrameSchemaZ,
} from "../pane-stream.ts";

const TICKET = `ps1_${"A".repeat(43)}`;
const REQUEST_ID = "7f0f9a7e-9be0-4b6e-a3a3-0a15c9a7e0d1";
const INSTANCE_ID = "3d3f8a52-77aa-4b3e-9a44-2f2f7b1c9d10";
const WS_URL = `ws://127.0.0.1:6070${PANE_STREAM_REDEEM_PATH}`;

function leaseRequest() {
  return {
    protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
    workspaceName: "workspace.alpha",
    panes: ["pane.editor", "pane.mirror.abc123"],
    viewerMode: "read-only" as const,
  };
}

function descriptor() {
  return {
    protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
    webSocketUrl: WS_URL,
    subprotocol: PANE_STREAM_WEBSOCKET_SUBPROTOCOL,
    redemptionTicket: TICKET,
    daemonInstanceId: INSTANCE_ID,
    requestId: REQUEST_ID,
    expiresAt: 90_000,
    panes: ["pane.editor"],
    effectiveViewerMode: "read-only" as const,
  };
}

describe("pane-stream lease contracts", () => {
  it("publishes one shared issue and redemption endpoint authority", () => {
    expect(PANE_STREAM_ISSUE_PATH).toBe("/api/v1/terminal/pane-streams/issue");
    expect(PANE_STREAM_REDEEM_PATH).toBe("/v1/terminal/pane-streams/redeem");
    expect(PANE_STREAM_WEBSOCKET_SUBPROTOCOL).toBe("tmux-ide-pane-stream.v1");
  });

  it("accepts a viewport-free enumerated pane set", () => {
    const parsed = PaneStreamLeaseRequestSchemaZ.parse(leaseRequest());
    expect(parsed.panes).toHaveLength(2);
  });

  it("rejects a viewport — mirror streams do not size the source", () => {
    expect(
      PaneStreamLeaseRequestSchemaZ.safeParse({
        ...leaseRequest(),
        viewport: { cols: 80, rows: 24 },
      }).success,
    ).toBe(false);
  });

  it("bounds and deduplicates the pane set", () => {
    expect(PaneStreamLeaseRequestSchemaZ.safeParse({ ...leaseRequest(), panes: [] }).success).toBe(
      false,
    );
    expect(
      PaneStreamLeaseRequestSchemaZ.safeParse({
        ...leaseRequest(),
        panes: ["pane.editor", "pane.editor"],
      }).success,
    ).toBe(false);
    const tooMany = Array.from({ length: PANE_STREAM_MAX_PANES + 1 }, (_, i) => `pane.p${i}`);
    expect(
      PaneStreamLeaseRequestSchemaZ.safeParse({ ...leaseRequest(), panes: tooMany }).success,
    ).toBe(false);
  });

  it("rejects runtime tmux addresses and reserved identities as pane ids", () => {
    for (const pane of ["%5", "@3", "$1", "terminal.discovered.x", "__proto__", "pane:colon"]) {
      expect(
        PaneStreamLeaseRequestSchemaZ.safeParse({ ...leaseRequest(), panes: [pane] }).success,
      ).toBe(false);
    }
  });

  it("rejects renderer-supplied execution, runtime-target, and credential fields", () => {
    for (const forbidden of [
      { command: "sh -c whoami" },
      { cwd: "/tmp" },
      { paneId: "%7" },
      { tmuxTarget: "owner:@9" },
      { authToken: "secret" },
      { sessionName: "victim" },
    ]) {
      expect(
        PaneStreamLeaseRequestSchemaZ.safeParse({ ...leaseRequest(), ...forbidden }).success,
      ).toBe(false);
    }
  });

  it("accepts only ps1 tickets", () => {
    expect(PaneStreamRedemptionTicketSchemaZ.safeParse(TICKET).success).toBe(true);
    for (const invalid of [`ta1_${"A".repeat(43)}`, `ps1_${"A".repeat(42)}`, "ps1_", "ps1"]) {
      expect(PaneStreamRedemptionTicketSchemaZ.safeParse(invalid).success).toBe(false);
    }
  });

  it("pins the WebSocket URL to the canonical loopback redemption endpoint", () => {
    expect(PaneStreamLoopbackWebSocketUrlSchemaZ.safeParse(WS_URL).success).toBe(true);
    for (const invalid of [
      `wss://127.0.0.1:6070${PANE_STREAM_REDEEM_PATH}`,
      `ws://example.com:6070${PANE_STREAM_REDEEM_PATH}`,
      "ws://127.0.0.1:6070/v1/terminal/attachments/redeem",
      `ws://user:pw@127.0.0.1:6070${PANE_STREAM_REDEEM_PATH}`,
      `ws://127.0.0.1:6070${PANE_STREAM_REDEEM_PATH}?token=x`,
    ]) {
      expect(PaneStreamLoopbackWebSocketUrlSchemaZ.safeParse(invalid).success).toBe(false);
    }
  });

  it("validates the issue descriptor strictly", () => {
    expect(PaneStreamIssueDescriptorSchemaZ.parse(descriptor()).panes).toEqual(["pane.editor"]);
    expect(
      PaneStreamIssueDescriptorSchemaZ.safeParse({ ...descriptor(), ownerToken: "x" }).success,
    ).toBe(false);
    expect(
      PaneStreamIssueDescriptorSchemaZ.safeParse({
        ...descriptor(),
        redemptionTicket: `ta1_${"A".repeat(43)}`,
      }).success,
    ).toBe(false);
  });

  it("requires layout authority snapshots to be complete and bijective", () => {
    const layout = (window: string | null, pane: string | null, currentWindow: boolean) => ({
      type: "layout" as const,
      semanticWindowId: window,
      windowName: "work",
      currentWindow,
      cols: 80,
      rows: 24,
      zoomed: false,
      paneBorderStatus: "off" as const,
      panes: [{ pane, left: 0, top: 0, width: 80, height: 24, active: true }],
    });
    const snapshot = {
      type: "layout-snapshot" as const,
      topologyEpoch: 1,
      layouts: [layout("window.one", "pane.editor", true)],
    };
    expect(PaneStreamServerFrameSchemaZ.safeParse(snapshot).success).toBe(true);
    for (const layouts of [
      [layout(null, "pane.editor", true)],
      [layout("window.one", null, true)],
      [layout("window.one", "pane.editor", false)],
      [layout("window.one", "pane.editor", true), layout("window.two", "pane.two", true)],
      [layout("window.one", "pane.editor", true), layout("window.one", "pane.two", false)],
      [layout("window.one", "pane.editor", true), layout("window.two", "pane.editor", false)],
    ]) {
      expect(PaneStreamServerFrameSchemaZ.safeParse({ ...snapshot, layouts }).success).toBe(false);
    }
  });

  it("redacts credential material from renderer-facing error reasons", () => {
    for (const reason of [
      `The redemptionTicket was ${TICKET}`,
      "Authorization: Bearer abc",
      "owner-token mismatch",
    ]) {
      expect(
        PaneStreamIssueErrorSchemaZ.safeParse({
          code: "attachment-unavailable",
          reason,
          retryable: false,
        }).success,
      ).toBe(false);
    }
    expect(
      PaneStreamIssueResultSchemaZ.safeParse({
        status: "error",
        error: {
          code: "pane-not-found",
          reason: "The requested pane is unavailable.",
          retryable: false,
        },
      }).success,
    ).toBe(true);
  });

  it("binds the private issue mutation envelope to daemon identity", () => {
    expect(
      PaneStreamIssueMutationRequestSchemaZ.safeParse({
        requestId: REQUEST_ID,
        expectedDaemonInstanceId: INSTANCE_ID,
        stream: leaseRequest(),
      }).success,
    ).toBe(true);
    expect(
      PaneStreamIssueMutationRequestSchemaZ.safeParse({
        requestId: REQUEST_ID,
        stream: leaseRequest(),
      }).success,
    ).toBe(false);
  });
});

describe("pane-stream client frames", () => {
  it("validates the redemption frame strictly", () => {
    const frame = {
      type: "redeem",
      protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
      ticket: TICKET,
      requestId: REQUEST_ID,
      daemonInstanceId: "daemon-instance-1",
    };
    expect(PaneStreamRedeemFrameSchemaZ.safeParse(frame).success).toBe(true);
    expect(PaneStreamRedeemFrameSchemaZ.safeParse({ ...frame, deliveryAcks: true }).success).toBe(
      true,
    );
    expect(PaneStreamRedeemFrameSchemaZ.safeParse({ ...frame, extra: 1 }).success).toBe(false);
    expect(
      PaneStreamRedeemFrameSchemaZ.safeParse({ ...frame, ticket: `ta1_${"A".repeat(43)}` }).success,
    ).toBe(false);
  });

  it("accepts tmux named keys and rejects command-injection shapes", () => {
    for (const key of ["Enter", "Escape", "C-c", "M-x", "C-M-a", "F12", "Up", "BSpace", "a", "5"]) {
      expect(PaneStreamKeyNameSchemaZ.safeParse(key).success).toBe(true);
    }
    for (const key of [
      "; kill-server",
      "Enter Enter",
      "$(reboot)",
      "'Enter'",
      "C-",
      "F13",
      "Enter;",
      "\u0000",
      "",
    ]) {
      expect(PaneStreamKeyNameSchemaZ.safeParse(key).success).toBe(false);
    }
  });

  it("bounds input text and sequence", () => {
    const base = { type: "input", kind: "text", pane: "pane.editor", seq: 1 };
    expect(PaneStreamInputFrameSchemaZ.safeParse({ ...base, data: "echo hi" }).success).toBe(true);
    expect(
      PaneStreamInputFrameSchemaZ.safeParse({
        ...base,
        data: "x".repeat(PANE_STREAM_MAX_INPUT_TEXT_CHARS + 1),
      }).success,
    ).toBe(false);
    expect(PaneStreamInputFrameSchemaZ.safeParse({ ...base, data: "a\0b" }).success).toBe(false);
    expect(PaneStreamInputFrameSchemaZ.safeParse({ ...base, seq: 0, data: "x" }).success).toBe(
      false,
    );
    expect(PaneStreamInputFrameSchemaZ.safeParse({ ...base, pane: "%5", data: "x" }).success).toBe(
      false,
    );
  });

  it("validates consumed frames and the client union", () => {
    expect(
      PaneStreamConsumedFrameSchemaZ.safeParse({ type: "consumed", pane: "pane.editor", seq: 4 })
        .success,
    ).toBe(true);
    expect(
      PaneStreamClientFrameSchemaZ.safeParse({ type: "consumed", pane: "pane.editor", seq: 0 })
        .success,
    ).toBe(false);
    expect(PaneStreamClientFrameSchemaZ.safeParse({ type: "resize", cols: 80 }).success).toBe(
      false,
    );
  });
});

describe("pane-stream server frames", () => {
  it("carries the atomic seed batch as one frame", () => {
    const frame = {
      type: "seed-batch",
      pane: "pane.editor",
      seq: 1,
      reset: { cols: 120, rows: 40 },
      seed: Buffer.from("hello").toString("base64"),
      held: [Buffer.from("tail").toString("base64")],
      cursor: { x: 4, y: 0 },
    };
    expect(PaneStreamSeedBatchFrameSchemaZ.safeParse(frame).success).toBe(true);
    // Degraded path: no probe answer, no fallback size.
    expect(
      PaneStreamSeedBatchFrameSchemaZ.safeParse({ ...frame, reset: null, cursor: null }).success,
    ).toBe(true);
    expect(
      PaneStreamSeedBatchFrameSchemaZ.safeParse({
        ...frame,
        held: Array.from({ length: PANE_STREAM_MAX_HELD_DELTAS + 1 }, () => "aGk="),
      }).success,
    ).toBe(false);
  });

  it("rejects oversized and non-base64 payloads", () => {
    const output = (data: string) => ({ type: "output", pane: "pane.editor", seq: 2, data });
    expect(PaneStreamServerFrameSchemaZ.safeParse(output("aGVsbG8=")).success).toBe(true);
    expect(PaneStreamServerFrameSchemaZ.safeParse(output("not base64!")).success).toBe(false);
    expect(
      PaneStreamServerFrameSchemaZ.safeParse(
        output("A".repeat(PANE_STREAM_MAX_OUTPUT_BASE64_CHARS + 4)),
      ).success,
    ).toBe(false);
  });

  it("speaks semantic identity only — runtime addresses cannot parse", () => {
    for (const pane of ["%5", "@3", "$1", "/tmp/pane"]) {
      expect(
        PaneStreamServerFrameSchemaZ.safeParse({ type: "output", pane, seq: 1, data: "aGk=" })
          .success,
      ).toBe(false);
      expect(
        PaneStreamServerFrameSchemaZ.safeParse({
          type: "flow",
          pane,
          seq: 1,
          state: "paused",
          reason: "backpressure",
        }).success,
      ).toBe(false);
    }
    expect(
      PaneStreamServerFrameSchemaZ.safeParse({
        type: "layout",
        semanticWindowId: "@4",
        windowName: null,
        currentWindow: true,
        cols: 200,
        rows: 50,
        zoomed: false,
        panes: [],
      }).success,
    ).toBe(false);
  });

  it("bounds layout frames", () => {
    const layout = {
      type: "layout",
      semanticWindowId: "window.mirror.abc123",
      windowName: "editors",
      currentWindow: true,
      cols: 200,
      rows: 50,
      zoomed: false,
      panes: [
        {
          pane: "pane.editor",
          displayName: "macmon",
          displayNameSource: "process",
          left: 0,
          top: 0,
          width: 100,
          height: 50,
          active: true,
        },
        { pane: null, left: 100, top: 0, width: 100, height: 50, active: false },
      ],
    };
    expect(PaneStreamServerFrameSchemaZ.safeParse(layout).success).toBe(true);
    expect(
      PaneStreamServerFrameSchemaZ.safeParse({
        ...layout,
        panes: [{ ...layout.panes[0], displayNameSource: "guessed" }],
      }).success,
    ).toBe(false);
    expect(
      PaneStreamServerFrameSchemaZ.safeParse({
        ...layout,
        panes: [{ ...layout.panes[0], displayName: "bad\nname" }],
      }).success,
    ).toBe(false);
    expect(
      PaneStreamServerFrameSchemaZ.safeParse({
        ...layout,
        panes: Array.from({ length: PANE_STREAM_MAX_LAYOUT_PANES + 1 }, () => layout.panes[0]),
      }).success,
    ).toBe(false);
    expect(PaneStreamServerFrameSchemaZ.safeParse({ ...layout, windowName: "a\nb" }).success).toBe(
      false,
    );
  });

  it("validates flow, closed, input-ack, and error frames", () => {
    for (const frame of [
      { type: "flow", pane: "pane.editor", seq: 3, state: "paused", reason: "backpressure" },
      { type: "closed", pane: "pane.editor", seq: 4 },
      { type: "input-ack", pane: "pane.editor", seq: 9 },
      {
        type: "error",
        protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
        code: "ticket-expired",
        retryable: true,
      },
    ]) {
      expect(PaneStreamServerFrameSchemaZ.safeParse(frame).success).toBe(true);
    }
    expect(
      PaneStreamServerFrameSchemaZ.safeParse({
        type: "flow",
        pane: "pane.editor",
        seq: 1,
        state: "gone",
        reason: "backpressure",
      }).success,
    ).toBe(false);
    expect(PaneStreamServerFrameSchemaZ.safeParse({ type: "shutdown" }).success).toBe(false);
  });

  it("audits a representative wire transcript for runtime ids and reserved keys", () => {
    const transcript = [
      {
        type: "ready",
        protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
        daemonInstanceId: "daemon-instance-1",
        requestId: REQUEST_ID,
        panes: ["pane.editor"],
        effectiveViewerMode: "interactive",
      },
      {
        type: "seed-batch",
        pane: "pane.editor",
        seq: 1,
        reset: { cols: 80, rows: 24 },
        seed: "aGVsbG8=",
        held: [],
        cursor: { x: 0, y: 0 },
      },
      { type: "output", pane: "pane.editor", seq: 2, data: "d29ybGQ=" },
    ];
    for (const frame of transcript) {
      const parsed = PaneStreamServerFrameSchemaZ.parse(frame);
      // Structural fields never carry runtime tmux addresses or paths. The
      // base64 payload fields are excluded: pane CONTENT is user bytes.
      const { ...structural } = parsed as Record<string, unknown>;
      delete structural.seed;
      delete structural.held;
      delete structural.data;
      const encoded = JSON.stringify(structural);
      expect(encoded).not.toMatch(/[%@$][0-9]/u);
      expect(encoded).not.toMatch(/\/(?:tmp|Users|home)\//u);
      expect(Object.keys(structural)).not.toContain("__proto__");
    }
  });
});
