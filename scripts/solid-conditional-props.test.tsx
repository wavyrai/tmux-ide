import { expect, test } from "bun:test";
import { createComputed, createRoot, createSignal } from "solid-js";

// Exercise the installed production JSX transform, not a hand-written getter.
test("reading a conditional component prop does not retain a computation per read", () => {
  createRoot((dispose) => {
    const [enabled, setEnabled] = createSignal(false);
    let reads = 0;
    const condition = () => {
      reads += 1;
      return enabled();
    };
    const secondary = () => false;
    let captured!: { marker: string; focused: boolean };
    const Row = (props: typeof captured) => {
      captured = props;
      return null;
    };
    const view = (
      <Row
        marker={condition() ? "on" : secondary() ? "middle" : "off"}
        focused={condition() && secondary()}
      />
    );
    void view;
    for (let index = 0; index < 1000; index += 1) {
      expect(captured.marker).toBe("off");
      expect(captured.focused).toBe(false);
    }
    reads = 0;
    setEnabled(true);
    const retainedWork = reads;
    dispose();
    expect(retainedWork).toBe(0);
  });
});

test("conditional props still track their consumer and release it on disposal", () => {
  let change!: (value: boolean) => void;
  const seen: string[] = [];
  const dispose = createRoot((dispose) => {
    const [enabled, setEnabled] = createSignal(false);
    change = setEnabled;
    let captured!: { marker: string };
    const Row = (props: typeof captured) => {
      captured = props;
      return null;
    };
    const view = <Row marker={enabled() ? "on" : "off"} />;
    void view;
    createComputed(() => {
      seen.push(captured.marker);
    });
    return dispose;
  });
  expect(seen).toEqual(["off"]);
  change(true);
  expect(seen).toEqual(["off", "on"]);
  dispose();
  change(false);
  expect(seen).toEqual(["off", "on"]);
});
