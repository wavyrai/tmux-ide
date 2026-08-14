import { describe, expect, it, vi } from "vitest";

import { OpenTuiTerminalHostFocus } from "./terminal-host-focus.ts";

function client() {
  return {
    setPresence: vi.fn(),
    noteActivity: vi.fn(),
    requestAuthority: vi.fn(async () => null),
    releaseAuthority: vi.fn(async () => undefined),
  };
}

describe("OpenTuiTerminalHostFocus", () => {
  it("claims on focused adoption and yields every authority on blur", () => {
    const runtime = client();
    const focus = new OpenTuiTerminalHostFocus(true);
    focus.adopt(runtime as never);

    expect(runtime.setPresence).toHaveBeenLastCalledWith("foreground");
    expect(runtime.noteActivity).toHaveBeenCalledWith("focus");
    expect(runtime.requestAuthority.mock.calls.map(([kind]) => kind)).toEqual([
      "input",
      "focus",
      "geometry",
    ]);

    focus.blur();
    expect(runtime.releaseAuthority.mock.calls.map(([kind]) => kind)).toEqual([
      "input",
      "focus",
      "geometry",
    ]);
    expect(runtime.setPresence).toHaveBeenLastCalledWith("background");
  });

  it("keeps a replacement background until the renderer regains focus", () => {
    const first = client();
    const second = client();
    const focus = new OpenTuiTerminalHostFocus(true);
    focus.adopt(first as never);
    focus.blur();
    focus.adopt(second as never);

    expect(second.setPresence).toHaveBeenCalledTimes(1);
    expect(second.setPresence).toHaveBeenCalledWith("background");
    expect(second.requestAuthority).not.toHaveBeenCalled();
    focus.focus();
    expect(second.setPresence).toHaveBeenLastCalledWith("foreground");
    expect(second.requestAuthority).toHaveBeenCalledTimes(3);
  });
});
