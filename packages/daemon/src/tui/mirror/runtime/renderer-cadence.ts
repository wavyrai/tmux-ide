export const TUI_RENDERER_CADENCE = Object.freeze({
  targetFps: 60,
  // Dirty terminal frames follow input/output readiness, not a display-rate
  // guess. OpenTUI still coalesces invalidations and handles backpressure;
  // Infinity removes its 1000/maxFps delay between requested frames.
  maxFps: Number.POSITIVE_INFINITY,
});
