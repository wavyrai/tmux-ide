/* @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

import { resolveWidget } from "./widget-registry.ts";
import { WidgetSurface } from "./widget-surface.tsx";

afterEach(() => document.body.replaceChildren());

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function mount(
  id: string,
  args: unknown,
  props: Partial<Parameters<typeof WidgetSurface>[0]> = {},
) {
  const root = document.body.appendChild(document.createElement("div"));
  const resolution = resolveWidget({ id, args, lineIndex: 0 });
  const dispose = render(() => <WidgetSurface resolution={resolution} {...props} />, root);
  return { root, dispose };
}

describe("widget surface", () => {
  it("loads an asset-backed animated image through the typed loader", async () => {
    const assetId = "a".repeat(64);
    const loadAsset = vi.fn(async () => ({
      assetId,
      media: "image/gif" as const,
      name: "demo.gif",
      data: "R0lGODlhAQABAAAAACw=",
    }));
    const mounted = mount("image", { assetId, name: "demo.gif" }, { loadAsset });
    await flush();
    expect(loadAsset).toHaveBeenCalledWith(assetId, expect.anything());
    expect(mounted.root.querySelector("img")?.getAttribute("src")).toContain(
      "data:image/gif;base64,",
    );
    mounted.dispose();
  });

  it("renders a safe card and forwards an explicit button action", () => {
    const onAction = vi.fn();
    const mounted = mount(
      "card",
      {
        title: "Build",
        items: [
          { type: "badge", text: "Passed", tone: "success" },
          { type: "button", label: "Rerun", input: "pnpm test", submit: true },
        ],
      },
      { onAction },
    );
    expect(mounted.root.textContent).toContain("Build");
    (mounted.root.querySelector("button") as HTMLButtonElement).click();
    expect(onAction).toHaveBeenCalledWith("pnpm test\r");
    mounted.dispose();
  });
});
