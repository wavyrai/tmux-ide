import { expect, it, vi } from "vitest";
import { createPaneResizeRequests } from "./pane-resize-requests";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function fixture() {
  const geometry = { cells: 80, maximum: 100 };
  let finish!: (ok: boolean) => void;
  const send = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(true);
  const error = vi.fn();
  const requests = createPaneResizeRequests(() => geometry, send, error);
  return { geometry, send, error, requests, finish: (ok: boolean) => finish(ok) };
}

it("retains ten rapid arrow increments while the first acknowledgement is delayed", async () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) f.requests.step(1);
  expect(f.send.mock.calls).toEqual([[81]]);
  f.geometry.cells = 81;
  f.requests.observe(81);
  f.requests.step(1);
  f.finish(true);
  await tick();
  expect(f.send.mock.calls).toEqual([[81], [91]]);
  expect(f.geometry.cells).toBe(81); // Only the daemon layout updates rendering.
});

it("coalesces reversals and accelerated keys into the final requested size", async () => {
  const f = fixture();
  f.requests.step(5);
  f.requests.step(5);
  f.requests.step(-1);
  f.requests.step(-5);
  f.finish(true);
  await tick();
  expect(f.send.mock.calls).toEqual([[85], [84]]);
});

it("clamps every increment without accumulating overshoot at either bound", async () => {
  const f = fixture();
  f.requests.step(100);
  f.requests.step(100);
  f.requests.step(-1);
  f.finish(true);
  await tick();
  expect(f.send.mock.calls).toEqual([[100], [99]]);
  f.requests.step(-1000);
  await tick();
  f.requests.step(1);
  await tick();
  expect(f.send.mock.calls.slice(-2)).toEqual([[2], [3]]);
});

it("starts from canonical geometry again after acknowledgement and cancellation", async () => {
  const f = fixture();
  f.requests.step(1);
  f.requests.step(1);
  f.requests.reset();
  f.geometry.cells = 70;
  f.requests.step(1);
  f.finish(true);
  await tick();
  expect(f.send.mock.calls).toEqual([[81], [71]]);
  f.geometry.cells = 71;
  f.requests.observe(71);
  f.geometry.cells = 60;
  f.requests.observe(60);
  f.requests.step(1);
  await tick();
  expect(f.send).toHaveBeenLastCalledWith(61);
});

it("drops pending increments on authority loss and starts retries from canonical cells", async () => {
  const f = fixture();
  f.requests.step(1);
  f.requests.step(10);
  f.finish(false);
  await tick();
  expect(f.error).toHaveBeenCalledOnce();
  expect(f.send.mock.calls).toEqual([[81]]);
  f.requests.step(-1);
  await tick();
  expect(f.send).toHaveBeenLastCalledWith(79);
});

it("does not dispatch queued sizes after a binding is disposed", async () => {
  const f = fixture();
  f.requests.step(1);
  f.requests.step(10);
  f.requests.dispose();
  f.finish(true);
  await tick();
  expect(f.send.mock.calls).toEqual([[81]]);
  expect(f.error).not.toHaveBeenCalled();
});

it("reissues a previous size when another client changed the canonical geometry", async () => {
  const f = fixture();
  f.requests.step(1);
  f.finish(true);
  await tick();
  f.geometry.cells = 81;
  f.requests.observe(81);
  f.geometry.cells = 80;
  f.requests.observe(80);
  f.requests.step(1);
  await tick();
  expect(f.send.mock.calls).toEqual([[81], [81]]);
});
