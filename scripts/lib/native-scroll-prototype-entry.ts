// Explicit experimental build entry. The stock dispatcher never imports this.
import { setRenderLibPath } from "@opentui/core";
import { dlopen } from "bun:ffi";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import library from "tmux-ide:experimental-scroll-library" with { type: "file" };

// Both FFI bindings must share one native handle registry. Bun can materialize
// an embedded library separately for each dlopen; use one real path instead.
const directory = mkdtempSync(join(tmpdir(), "tmux-ide-scroll-native-"));
const nativePath = join(directory, process.platform === "darwin" ? "opentui.dylib" : "opentui.so");
writeFileSync(nativePath, new Uint8Array(await Bun.file(library).arrayBuffer()), { mode: 0o600 });
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
setRenderLibPath(nativePath);
const native = dlopen(nativePath, {
  rendererBeginScrollPrototypeFrame: { args: ["u32", "u32"], returns: "void" },
  rendererScrollPrototypeMarginsSupported: { args: ["u32"], returns: "bool" },
  rendererQueueScrollPrototypeRect: {
    args: ["u32", "u32", "u32", "u32", "u32"],
    returns: "bool",
  },
});
const { registerNativeScrollHint } =
  await import("../../packages/daemon/src/tui/mirror/pane-surface.tsx");
const observedSupport = new WeakMap<object, boolean>();
registerNativeScrollHint((ctx, x, y, width, height) => {
  if (typeof ctx.rendererPtr !== "number" || typeof ctx.frameId !== "number") return;
  native.symbols.rendererBeginScrollPrototypeFrame(ctx.rendererPtr, ctx.frameId >>> 0);
  // Without horizontal margins, leave the queue empty: the native renderer
  // can still optimize a safe full-width scroll or use its normal cell diff.
  const supported = native.symbols.rendererScrollPrototypeMarginsSupported(ctx.rendererPtr);
  const log = process.env.TMUX_IDE_TUI_PERF_LOG;
  if (log && observedSupport.get(ctx) !== supported) {
    observedSupport.set(ctx, supported);
    try {
      appendFileSync(
        log,
        `${JSON.stringify({
          phase: "native-scroll-margin-capability",
          supported,
          enabled: process.env.TMUX_IDE_NATIVE_SCROLL_PROTOTYPE === "1",
          at: new Date().toISOString(),
          processId: `opentui:${process.pid}`,
        })}\n`,
      );
    } catch {
      // Optional capability diagnostics must never interrupt painting.
    }
  }
  if (!supported) return;
  if (![x, y, width, height].every(Number.isInteger)) return;
  if (x < 0 || y < 0 || width < 1 || height < 1) return;
  native.symbols.rendererQueueScrollPrototypeRect(ctx.rendererPtr, x, y, width, height);
});
// Library selection and symbol validation must precede surface initialization.
await import("../../packages/daemon/src/tui/main.ts");
