/**
 * Wire coverage for `ChatComposer` mounting the new action surface.
 *
 * Validates:
 *   1. When `pendingApproval` is null/undefined, no approval surface
 *      mounts.
 *   2. When `pendingApproval` is set, `ComposerPendingApprovalPanel`
 *      and `ComposerPendingApprovalActions` both render, and the
 *      4-button verdict row routes clicks back to the host with the
 *      pending request id.
 *   3. The default send/stop path is now delegated to
 *      `ComposerPrimaryActions` — Send when idle, Stop when busy.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { ChatComposer } from "../src/components/ChatComposer";
import type { ProviderApprovalDecision } from "../src/components/ComposerPendingApprovalActions";
import type { PendingApproval } from "../src/components/ComposerPendingApprovalPanel";
import type { AvailableCommand, ContentBlock } from "../src/types";

const commands: AvailableCommand[] = [{ name: "deploy", description: "Deploy" }];

afterEach(() => {
  document.body.innerHTML = "";
});

interface MountOpts {
  disabled?: boolean;
  pendingApproval?: PendingApproval | null;
  pendingApprovalCount?: number;
  onRespondToApproval?: (id: string, decision: ProviderApprovalDecision) => Promise<void>;
}

function mountChat(opts: MountOpts = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);

  const [disabled] = createSignal(opts.disabled ?? false);
  const [pendingApproval] = createSignal<PendingApproval | null>(opts.pendingApproval ?? null);
  const [count] = createSignal(opts.pendingApprovalCount ?? 1);
  const onRespond =
    opts.onRespondToApproval ??
    vi.fn(async (_id: string, _decision: ProviderApprovalDecision) => undefined);
  const onSend = vi.fn(async (_content: ContentBlock[]) => undefined);
  const onCancel = vi.fn();

  const dispose = render(
    () => (
      <ChatComposer
        disabled={disabled}
        availableCommands={() => commands}
        providerName={() => "Claude"}
        sessionName={() => "alpha"}
        projectDir={() => "/tmp/p"}
        attachments={() => []}
        terminalPanes={() => []}
        onAddAttachment={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onSend={onSend}
        onCancel={onCancel}
        pendingApproval={pendingApproval}
        pendingApprovalCount={count}
        onRespondToApproval={onRespond}
      />
    ),
    container,
  );

  return { container, dispose, onRespond, onSend, onCancel };
}

describe("ChatComposer wiring — approval surface + primary actions", () => {
  it("mounts neither approval surface when pendingApproval is null", () => {
    const { container, dispose } = mountChat();
    expect(container.querySelector("[data-testid='composer-pending-approval-panel']")).toBeNull();
    expect(container.querySelector("[data-testid='composer-pending-approval-actions']")).toBeNull();
    dispose();
  });

  it("mounts panel and actions when pendingApproval is set", () => {
    const { container, dispose } = mountChat({
      pendingApproval: { requestId: "req-1", requestKind: "command" },
    });
    expect(container.querySelector("[data-testid='composer-pending-approval-panel']")).toBeTruthy();
    expect(
      container.querySelector("[data-testid='composer-pending-approval-actions']"),
    ).toBeTruthy();
    expect(container.textContent).toContain("Command approval requested");
    dispose();
  });

  it("forwards clicks on each verdict button to onRespondToApproval", () => {
    const onRespond = vi.fn(async (_id: string, _decision: ProviderApprovalDecision) => undefined);
    const { container, dispose } = mountChat({
      pendingApproval: { requestId: "req-42", requestKind: "file-change" },
      onRespondToApproval: onRespond,
    });

    for (const decision of ["cancel", "decline", "acceptForSession", "accept"] as const) {
      const btn = container.querySelector<HTMLButtonElement>(`button[data-decision='${decision}']`);
      expect(btn).toBeTruthy();
      btn!.click();
    }
    expect(onRespond).toHaveBeenCalledTimes(4);
    expect(onRespond.mock.calls.map(([id, decision]) => ({ id, decision }))).toEqual([
      { id: "req-42", decision: "cancel" },
      { id: "req-42", decision: "decline" },
      { id: "req-42", decision: "acceptForSession" },
      { id: "req-42", decision: "accept" },
    ]);
    dispose();
  });

  it("renders the Send button (composer-primary-send) when idle", () => {
    const { container, dispose } = mountChat();
    expect(container.querySelector("[data-testid='composer-primary-send']")).toBeTruthy();
    expect(container.querySelector("[data-testid='composer-stop']")).toBeNull();
    dispose();
  });

  it("renders the Stop button when disabled (running) and dispatches onCancel", () => {
    const { container, dispose, onCancel } = mountChat({ disabled: true });
    const stop = container.querySelector<HTMLButtonElement>("[data-testid='composer-stop']");
    expect(stop).toBeTruthy();
    expect(container.querySelector("[data-testid='composer-primary-send']")).toBeNull();
    stop!.click();
    expect(onCancel).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("renders the pending count badge when more than one approval is queued", () => {
    const { container, dispose } = mountChat({
      pendingApproval: { requestId: "req-1", requestKind: "command" },
      pendingApprovalCount: 5,
    });
    expect(container.textContent).toContain("1/5");
    dispose();
  });
});
