import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { ExpandedImageDialog } from "../src/components/ExpandedImageDialog";
import type { ExpandedImagePreview } from "../src/components/ExpandedImagePreview";

afterEach(() => {
  document.body.innerHTML = "";
});

const SAMPLE_TRIPLE: ExpandedImagePreview = {
  images: [
    { src: "blob:1", name: "alpha.png", sizeLabel: "120 KB" },
    { src: "blob:2", name: "beta.png" },
    { src: "blob:3", name: "gamma.png", sizeLabel: "2.0 MB" },
  ],
  index: 1,
};

const SAMPLE_SINGLE: ExpandedImagePreview = {
  images: [{ src: "blob:only", name: "lonely.png" }],
  index: 0,
};

function mount(initial: ExpandedImagePreview | null, onClose = vi.fn()) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [preview, setPreview] = createSignal<ExpandedImagePreview | null>(initial);
  render(() => <ExpandedImageDialog preview={preview} onClose={onClose} />, container);
  return { container, setPreview, onClose };
}

function key(name: string) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
}

describe("ExpandedImageDialog", () => {
  it("renders nothing when preview is null", () => {
    const { container } = mount(null);
    expect(container.querySelector('[data-testid="expanded-image-dialog"]')).toBeNull();
  });

  it("renders the active image and caption from the preview", () => {
    const { container } = mount(SAMPLE_TRIPLE);
    const img = container.querySelector(
      '[data-testid="expanded-image-dialog-image"]',
    ) as HTMLImageElement | null;
    expect(img).toBeTruthy();
    expect(img!.getAttribute("src")).toBe("blob:2");
    expect(img!.getAttribute("alt")).toBe("beta.png");
    expect(
      container.querySelector('[data-testid="expanded-image-dialog-caption"]')?.textContent,
    ).toContain("beta.png");
    // 1-indexed (2/3)
    expect(
      container.querySelector('[data-testid="expanded-image-dialog-caption"]')?.textContent,
    ).toContain("(2/3)");
  });

  it("hides prev/next chevrons when there's only one image", () => {
    const { container } = mount(SAMPLE_SINGLE);
    expect(container.querySelector('[data-testid="expanded-image-dialog-prev"]')).toBeNull();
    expect(container.querySelector('[data-testid="expanded-image-dialog-next"]')).toBeNull();
  });

  it("navigates with ArrowRight / ArrowLeft when multiple images are present", () => {
    const { container } = mount(SAMPLE_TRIPLE);
    expect(
      (container.querySelector('[data-testid="expanded-image-dialog-image"]') as HTMLImageElement)
        .src,
    ).toContain("blob:2");

    key("ArrowRight");
    expect(
      (container.querySelector('[data-testid="expanded-image-dialog-image"]') as HTMLImageElement)
        .src,
    ).toContain("blob:3");

    key("ArrowRight");
    expect(
      (container.querySelector('[data-testid="expanded-image-dialog-image"]') as HTMLImageElement)
        .src,
    ).toContain("blob:1"); // wraps

    key("ArrowLeft");
    expect(
      (container.querySelector('[data-testid="expanded-image-dialog-image"]') as HTMLImageElement)
        .src,
    ).toContain("blob:3"); // wraps the other way
  });

  it("ignores arrow keys when only one image is present", () => {
    const { container } = mount(SAMPLE_SINGLE);
    key("ArrowRight");
    expect(
      (container.querySelector('[data-testid="expanded-image-dialog-image"]') as HTMLImageElement)
        .src,
    ).toContain("blob:only");
  });

  it("fires onClose when the Escape key is pressed", () => {
    const onClose = vi.fn();
    mount(SAMPLE_SINGLE, onClose);
    key("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("fires onClose when the backdrop is clicked", () => {
    const onClose = vi.fn();
    const { container } = mount(SAMPLE_TRIPLE, onClose);
    (
      container.querySelector('[data-testid="expanded-image-dialog-backdrop"]') as HTMLButtonElement
    ).click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("fires onClose when the × button is clicked", () => {
    const onClose = vi.fn();
    const { container } = mount(SAMPLE_TRIPLE, onClose);
    (
      container.querySelector('[data-testid="expanded-image-dialog-close"]') as HTMLButtonElement
    ).click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("navigates via the chevron buttons", () => {
    const { container } = mount(SAMPLE_TRIPLE);
    (
      container.querySelector('[data-testid="expanded-image-dialog-next"]') as HTMLButtonElement
    ).click();
    expect(
      (container.querySelector('[data-testid="expanded-image-dialog-image"]') as HTMLImageElement)
        .src,
    ).toContain("blob:3");
    (
      container.querySelector('[data-testid="expanded-image-dialog-prev"]') as HTMLButtonElement
    ).click();
    expect(
      (container.querySelector('[data-testid="expanded-image-dialog-image"]') as HTMLImageElement)
        .src,
    ).toContain("blob:2");
  });

  it("re-seeds the cursor when the host hands in a new preview reference", () => {
    const { container, setPreview } = mount(SAMPLE_TRIPLE);
    expect(
      (container.querySelector('[data-testid="expanded-image-dialog-image"]') as HTMLImageElement)
        .src,
    ).toContain("blob:2");
    setPreview({ ...SAMPLE_TRIPLE, index: 2 });
    expect(
      (container.querySelector('[data-testid="expanded-image-dialog-image"]') as HTMLImageElement)
        .src,
    ).toContain("blob:3");
  });
});
