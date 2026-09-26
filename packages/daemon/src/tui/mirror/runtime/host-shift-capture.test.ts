import { expect, it, vi } from "vitest";
import { acquireHostShiftCapture } from "./host-shift-capture.ts";

it("requests Ghostty shift reporting and releases it once on disposal", () => {
  const write = vi.fn();
  const release = acquireHostShiftCapture({ TERM_PROGRAM: "ghostty" }, write);
  release();
  release();
  expect(write.mock.calls.flat()).toEqual(["\u001b[>1s", "\u001b[>0s"]);
});
it("does not change other terminals or a surrounding tmux host", () => {
  const write = vi.fn();
  acquireHostShiftCapture({ TERM_PROGRAM: "Apple_Terminal" }, write)();
  acquireHostShiftCapture({ TERM_PROGRAM: "ghostty", TMUX: "/tmp/tmux" }, write)();
  expect(write).not.toHaveBeenCalled();
});
