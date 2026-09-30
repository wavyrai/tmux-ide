import assert from "node:assert/strict";
import { test } from "node:test";
import { collectStockOracle } from "./collect-stock.mjs";

const answers = () => [
  "118|30|118|29|top|off|7|28|1\n",
  "0|1|1|1|0|0|1|0|0\n",
  "line\n".repeat(29),
  "\x1b[31mline\n".repeat(29),
];
function collect(lines, pane = "%1") {
  const calls = [];
  const result = collectStockOracle((...args) => {
    calls.push(args);
    assert(lines.length);
    return lines.shift();
  }, pane);
  assert.equal(lines.length, 0);
  return { ...result, calls };
}
test("collects explicit stock geometry/modes/capture through only the supplied runner", () => {
  const result = collect(answers());
  assert.equal(result.stock.rows, 29);
  assert.equal(result.stock.modes.synchronizedOutput, false);
  assert.deepEqual(result.evidence.unavailableFormats, []);
  assert.deepEqual(
    result.calls.map((x) => x[0]),
    ["display-message", "display-message", "capture-pane", "capture-pane"],
  );
  assert(result.calls.every((x) => x.includes("%1")));
});
test("only unavailable synchronized-output format is disclosed and omitted", () => {
  const values = answers();
  values[1] = "0|1|1|1|0|0|1|0|\n";
  const result = collect(values);
  assert(!Object.hasOwn(result.stock.modes, "synchronizedOutput"));
  assert.deepEqual(result.evidence.unavailableFormats, ["synchronized_output_flag"]);
});
for (const [name, edit] of [
  ["missing required format", (a) => (a[1] = "0|1|1|1|0||1|0|0\n")],
  ["unknown boolean", (a) => (a[1] = "0|1|1|1|0|0|1|0|2\n")],
  ["stale width", (a) => (a[0] = a[0].replace("118|30", "116|30"))],
  ["incorrect pane geometry", (a) => (a[0] = a[0].replace("118|29", "118|30"))],
  ["missing cursor visibility", (a) => (a[0] = "118|30|118|29|top|off|7|28|\n")],
  ["incomplete capture", (a) => (a[2] = a[2].slice(0, -1))],
  ["missing visible row", (a) => (a[2] = "line\n".repeat(28))],
])
  test(`rejects ${name}`, () => {
    const a = answers();
    edit(a);
    assert.throws(() => collect(a));
  });
test("rejects arbitrary pane selector before invoking the runner", () => {
  let calls = 0;
  assert.throws(() =>
    collectStockOracle(() => {
      calls++;
    }, "session:0"),
  );
  assert.equal(calls, 0);
});
