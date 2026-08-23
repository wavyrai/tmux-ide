import { readFileSync } from "node:fs";

const referenceBudgets = JSON.parse(
  readFileSync(new URL("../../performance/reference-budgets.json", import.meta.url), "utf8"),
);

const memory = referenceBudgets?.memory;
const eventLoop = referenceBudgets?.eventLoop;
const cursorPresentation = referenceBudgets?.cursorPresentation;
if (
  !Number.isSafeInteger(memory?.rssAbsoluteCeilingBytes) ||
  memory.rssAbsoluteCeilingBytes <= 0 ||
  !Number.isSafeInteger(memory?.heapAbsoluteCeilingBytes) ||
  memory.heapAbsoluteCeilingBytes <= 0
)
  throw new TypeError("reference memory budgets require positive safe absolute ceilings");
if (
  eventLoop?.currentEndpointCeilingMicros !== 33_000 ||
  eventLoop?.generationStickyPeakCeilingMicros !== 100_000 ||
  eventLoop?.workloadP99CeilingMs !== 33
)
  throw new TypeError("reference event-loop budgets require the fixed product contract");
if (cursorPresentation?.p99CeilingMicros !== 33_000)
  throw new TypeError("reference cursor-presentation budget requires the fixed product contract");

export const REFERENCE_MEMORY_BUDGET = Object.freeze({ ...memory });
export const REFERENCE_EVENT_LOOP_BUDGET = Object.freeze({ ...eventLoop });
export const REFERENCE_CURSOR_PRESENTATION_BUDGET = Object.freeze({ ...cursorPresentation });
export const TUI_RSS_ABSOLUTE_CEILING_BYTES = memory.rssAbsoluteCeilingBytes;
export const TUI_HEAP_ABSOLUTE_CEILING_BYTES = memory.heapAbsoluteCeilingBytes;
export const TUI_EVENT_LOOP_CURRENT_ENDPOINT_CEILING_MICROS =
  eventLoop.currentEndpointCeilingMicros;
export const TUI_EVENT_LOOP_GENERATION_STICKY_PEAK_CEILING_MICROS =
  eventLoop.generationStickyPeakCeilingMicros;
export const TUI_EVENT_LOOP_WORKLOAD_P99_CEILING_MS = eventLoop.workloadP99CeilingMs;
export const TUI_CURSOR_PRESENTATION_P99_CEILING_MICROS = cursorPresentation.p99CeilingMicros;
