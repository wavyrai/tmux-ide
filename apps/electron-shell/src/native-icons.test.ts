import { describe, expect, it, vi } from "vitest";
import { DesktopIconCatalogSchemaZ, SEMANTIC_ICON_NAMES } from "@tmux-ide/contracts";
import { createNativeIconCatalog } from "./native-icons.ts";

describe("native icon provider", () => {
  it.each(["linux", "win32", "unknown"])("never resolves Apple images on %s", (platform) => {
    const createFromNamedImage = vi.fn();
    expect(createNativeIconCatalog(platform, { createFromNamedImage })()).toEqual({
      provider: "open",
    });
    expect(createFromNamedImage).not.toHaveBeenCalled();
  });
  it("resolves a finite catalog once and tolerates missing OS symbols", () => {
    const createFromNamedImage = vi.fn((name: string) => {
      if (name === "terminal") throw new Error("not supported");
      return { isEmpty: () => name === "house", toDataURL: () => "data:image/png;base64,YQ==" };
    });
    const get = createNativeIconCatalog("darwin", { createFromNamedImage });
    const result = get();
    expect(DesktopIconCatalogSchemaZ.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      provider: "sf-symbols",
      icons: { Plus: "data:image/png;base64,YQ==" },
    });
    if (result.provider === "sf-symbols") {
      expect(result.icons.Home).toBeUndefined();
      expect(result.icons.Terminal).toBeUndefined();
    }
    expect(get()).toBe(result);
    expect(createFromNamedImage).toHaveBeenCalledTimes(SEMANTIC_ICON_NAMES.length);
  });
});
