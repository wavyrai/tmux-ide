import { afterEach, describe, expect, it, vi } from "vitest";

const createRenderer = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("@opentui/core", () => ({ createCliRenderer: createRenderer }));
import { createApplicationRootRenderer } from "./application-root-renderer.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("root renderer host capabilities", () => {
  it("disables the unsupported OSC 66 probe before constructing a tmux renderer", async () => {
    vi.stubEnv("TMUX", "/tmp/owned,123,0");
    vi.stubEnv("OPENTUI_FORCE_EXPLICIT_WIDTH", undefined);
    createRenderer.mockImplementationOnce(async () => {
      expect(process.env.OPENTUI_FORCE_EXPLICIT_WIDTH).toBe("false");
      return {};
    });
    await createApplicationRootRenderer(false);
    expect(createRenderer).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ forwardEnvKeys: ["OPENTUI_FORCE_EXPLICIT_WIDTH"] }),
    );
  });
  it("leaves direct terminal detection enabled", async () => {
    vi.stubEnv("TMUX", undefined);
    vi.stubEnv("OPENTUI_FORCE_EXPLICIT_WIDTH", undefined);
    await createApplicationRootRenderer(false);
    expect(process.env.OPENTUI_FORCE_EXPLICIT_WIDTH).toBeUndefined();
  });
  it.each(["true", "1", "false", "0"])("preserves explicit override %s", async (value) => {
    vi.stubEnv("TMUX", "/tmp/owned,123,0");
    vi.stubEnv("OPENTUI_FORCE_EXPLICIT_WIDTH", value);
    await createApplicationRootRenderer(false);
    expect(process.env.OPENTUI_FORCE_EXPLICIT_WIDTH).toBe(value);
  });
});
