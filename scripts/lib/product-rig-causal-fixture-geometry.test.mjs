import assert from "node:assert/strict";
import test from "node:test";

import { createCausalFixtureGeometry } from "./product-rig-causal-fixture-geometry.mjs";

test("alternate-screen geometry resets never erase the retained primary history", () => {
  const writes = [];
  const geometry = createCausalFixtureGeometry({
    clearHistory: false,
    readColumns: () => 40,
    write: (value, callback) => {
      writes.push(value);
      callback();
    },
    markReady: () => {},
    subscribeResize: () => () => {},
  });
  geometry.start();
  geometry.reset("probe");
  assert.equal(writes.length, 2);
  assert.ok(writes.every((value) => value.includes("\x1b[2J") && !value.includes("\x1b[3J")));
  geometry.dispose();
});

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

test("resize retains the acknowledged reset and stale writes cannot overwrite it", () => {
  let resize;
  let columns = 80;
  const callbacks = [];
  const ready = [];
  const geometry = createCausalFixtureGeometry({
    readColumns: () => columns,
    write: (_value, callback) => callbacks.push(callback),
    markReady: (value) => ready.push(value),
    subscribeResize: (listener) => {
      resize = listener;
    },
  });
  geometry.start();
  geometry.reset("probe-0");
  columns = 132;
  resize();
  callbacks[2]();
  callbacks[0]();
  callbacks[1]();
  assert.deepEqual(ready, ["ready-v1:probe-0"]);
  assert.equal(geometry.columns(), 132);
  resize();
  callbacks[3]();
  assert.deepEqual(ready, ["ready-v1:probe-0", "ready-v1:probe-0"]);
  geometry.reset("probe-1");
  geometry.dispose();
  callbacks[4]();
  assert.equal(ready.length, 2);
});
