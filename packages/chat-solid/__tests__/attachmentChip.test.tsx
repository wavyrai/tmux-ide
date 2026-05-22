import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { AttachmentChip } from "../src/components/AttachmentChip";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("AttachmentChip", () => {
  it("renders terminal attachments and removes them", () => {
    const onRemove = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);

    render(
      () => (
        <AttachmentChip
          attachment={{
            kind: "terminal",
            paneId: "%1",
            paneTitle: "Dev Server",
            sessionName: "alpha",
          }}
          onRemove={onRemove}
        />
      ),
      container,
    );

    expect(container.textContent).toContain("▤");
    expect(container.textContent).toContain("Terminal: Dev Server");
    container.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("renders file attachments with the file icon", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);

    render(
      () => (
        <AttachmentChip
          attachment={{ kind: "file", path: "/tmp/output.log", label: "output.log" }}
          onRemove={() => undefined}
        />
      ),
      container,
    );

    expect(container.textContent).toContain("📄");
    expect(container.textContent).toContain("output.log");
  });
});
