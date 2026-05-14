/**
 * W6 — Four-button verdict cluster lives inside `PermissionDialog`.
 *
 * The standalone `ComposerPendingApprovalPanel` was retired in favor
 * of feeding all tool-call approvals through this dialog (audit §W6,
 * option A). These tests cover the new four-kind treatment so a
 * future regression to "green vs red" surfaces immediately:
 *
 *   1. All four daemon option kinds render with distinct
 *      `data-variant` values (primary / allow-outline /
 *      reject-outline / destructive).
 *   2. Clicking each button dispatches `onRespond` with that
 *      option's id.
 *   3. Escape triggers the `reject_once` fallback (preserves the
 *      existing keyboard contract).
 *
 * Component-level: mounts `PermissionDialog` directly with a
 * signal-backed `pending` so the test stays focused on the verdict
 * surface and isn't coupled to the daemon mount harness.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { PermissionDialog } from "../src/components/PermissionDialog";
import type { PermissionOption, PermissionRequest } from "../src/types";

const fourOptions: PermissionOption[] = [
  { optionId: "allow_once", name: "Approve once", kind: "allow_once" },
  { optionId: "allow_always", name: "Always allow this session", kind: "allow_always" },
  { optionId: "reject_once", name: "Decline", kind: "reject_once" },
  { optionId: "reject_always", name: "Always reject", kind: "reject_always" },
];

function request(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    threadId: "thread-1",
    requestId: "req-1",
    toolCall: {
      toolCallId: "tool-1",
      title: "Run dangerous command",
      kind: "execute",
    },
    options: fourOptions,
    receivedAt: Date.now(),
    ...overrides,
  };
}

function mountDialog(initial: PermissionRequest | null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [pending, setPending] = createSignal<PermissionRequest | null>(initial);
  const onRespond = vi.fn(async (_optionId: string) => undefined);
  const dispose = render(
    () => <PermissionDialog pending={pending} onRespond={onRespond} />,
    container,
  );
  return { container, dispose, setPending, onRespond };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("PermissionDialog four-kind verdict cluster (W6)", () => {
  it("renders one button per option with the right data-variant", () => {
    const { container, dispose } = mountDialog(request());

    const variants = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button[data-option-kind]"),
    ).map((btn) => ({
      kind: btn.getAttribute("data-option-kind"),
      variant: btn.getAttribute("data-variant"),
      label: btn.textContent?.trim(),
    }));

    expect(variants).toEqual([
      { kind: "allow_once", variant: "primary", label: "Approve once" },
      {
        kind: "allow_always",
        variant: "allow-outline",
        label: "Always allow this session",
      },
      { kind: "reject_once", variant: "reject-outline", label: "Decline" },
      { kind: "reject_always", variant: "destructive", label: "Always reject" },
    ]);

    dispose();
  });

  it("dispatches the correct optionId per kind", () => {
    // One fresh mount per kind so the in-flight gate doesn't
    // interfere — the dialog disables every button after the first
    // click while the prior response promise is outstanding.
    for (const kind of ["allow_once", "allow_always", "reject_once", "reject_always"] as const) {
      const { container, dispose, onRespond } = mountDialog(request());
      const btn = container.querySelector<HTMLButtonElement>(`button[data-option-kind='${kind}']`);
      expect(btn).toBeTruthy();
      btn!.click();
      expect(onRespond).toHaveBeenCalledExactlyOnceWith(kind);
      dispose();
      document.body.innerHTML = "";
    }
  });

  it("routes Escape to the reject_once fallback", async () => {
    const { dispose, onRespond } = mountDialog(request());

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    // The dialog's keydown handler is attached on the dialog node;
    // bubble through it via the focused dialog ref.
    const dialogNode = document.querySelector<HTMLElement>("[role='dialog']");
    expect(dialogNode).toBeTruthy();
    dialogNode!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(onRespond).toHaveBeenCalledWith("reject_once");
    dispose();
  });

  it("disables every button while a response is in flight", () => {
    const { container, dispose } = mountDialog(request());

    const allow = container.querySelector<HTMLButtonElement>(
      "button[data-option-kind='allow_once']",
    )!;
    allow.click();

    for (const kind of ["allow_once", "allow_always", "reject_once", "reject_always"]) {
      const btn = container.querySelector<HTMLButtonElement>(`button[data-option-kind='${kind}']`);
      expect(btn?.disabled).toBe(true);
    }
    dispose();
  });

  it("renders nothing when pending is null", () => {
    const { container, dispose } = mountDialog(null);
    expect(container.querySelector("button[data-option-kind]")).toBeNull();
    dispose();
  });
});
