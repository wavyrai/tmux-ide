import assert from "node:assert/strict";
import test from "node:test";

import { createCausalFixtureGeometry } from "./product-rig-causal-fixture-geometry.mjs";

test("causal fixture follows terminal resize before measured input", () => {
  let columns = 80;
  let resize;
  const writes = [];
  const ready = [];
  const geometry = createCausalFixtureGeometry({
    readColumns: () => columns,
    write: (value, callback) => {
      writes.push(value);
      callback();
    },
    markReady: (value) => ready.push(value),
    subscribeResize: (listener) => {
      resize = listener;
      return () => {
        resize = null;
      };
    },
  });

  geometry.start();
  columns = 132;
  resize();
  geometry.reset("trace-a");

  assert.equal(writes[0].startsWith("\x1b[0m\x1b[2J\x1b[3J\x1b[?7l"), true);
  assert.equal(writes[0].endsWith("\x1b[1;80H\x1b[2K\x1b[1;80H \x1b[1;80H"), true);
  assert.equal(writes[1].endsWith("\x1b[1;132H\x1b[2K\x1b[1;132H \x1b[1;132H"), true);
  assert.equal(writes[2].endsWith("\x1b[1;132H\x1b[2K\x1b[1;132H \x1b[1;132H"), true);
  assert.deepEqual(
    ["\x1b[0m", "\x1b[2J\x1b[3J", "\x1b[?7l", "\x1b[1;80H", "\x1b[2K", " "]
      .map((sequence) => writes[0].indexOf(sequence))
      .map((offset, index, offsets) => (index === 0 ? offset >= 0 : offset > offsets[index - 1])),
    [true, true, true, true, true, true],
  );
  assert.deepEqual(ready, ["ready-v1", "ready-v1", "ready-v1:trace-a"]);
  assert.equal(geometry.columns(), 132);
  geometry.dispose();
  assert.equal(resize, null);
});
