/**
 * Browser stand-in for `@opentui/core`.
 *
 * The real package loads a native Zig renderer over FFI (libopentui.dylib and
 * friends), so it cannot be imported in a browser bundle. But the app's SHARED
 * pure modules — status-grammar, agent-rows, agent-chip — only reach into it for
 * `RGBA`, a plain value type. Aliasing `@opentui/core` to this module in the
 * Vite build lets those modules be imported verbatim on the web, which is the
 * whole point: the demo renders from the app's real logic, not a copy of it.
 *
 * If a shared module ever starts importing something else from core, the build
 * fails loudly here rather than silently drifting — that's intentional.
 */

export class RGBA {
  constructor(
    readonly r: number,
    readonly g: number,
    readonly b: number,
    readonly a: number,
  ) {}

  /** The only constructor the shared modules use. Ints are 0–255. */
  static fromInts(r: number, g: number, b: number, a = 255): RGBA {
    return new RGBA(r, g, b, a);
  }

  /** Not part of core's API — the web host's bridge to CSS. */
  css(): string {
    return `rgba(${this.r}, ${this.g}, ${this.b}, ${this.a / 255})`;
  }
}
