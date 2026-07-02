/**
 * Dispatcher entry for the compiled `tmux-ide-tui` binary.
 *
 * `bun build --compile` bundles every TUI surface (the cockpit + widgets) into
 * ONE standalone executable so the OpenTUI/Solid `.tsx` surfaces run on a clean
 * `npm i -g tmux-ide` — no dev checkout, no `bun` runtime, no bunfig preload.
 * The native OpenTUI dylib rides along via Bun's embedded-asset mechanism (the
 * `import ... with { type: "file" }` in @opentui/core-*), and the Solid JSX
 * transform happens at build time via the @opentui/solid bun plugin, so the
 * binary carries only plain JS.
 *
 * Contract: `tmux-ide-tui <surface> [--flags…]`. The first positional selects
 * the surface; the rest are the surface's own args (theme, session, dir, …),
 * exactly as the `bun <entry> …` invocation passed them. We strip the surface
 * token from `process.argv` before importing so each entry's top-level
 * `parseArgs()` sees the same argv it always has.
 *
 * The `import()` calls use LITERAL specifiers on purpose: Bun's bundler only
 * embeds dynamic imports it can resolve statically, and a literal switch keeps
 * exactly one surface's top-level `render()` side effect from firing.
 */

const SURFACES = ["team", "explorer", "changes", "preview", "config", "setup", "sidebar"] as const;

type Surface = (typeof SURFACES)[number];

function isSurface(value: string | undefined): value is Surface {
  return value !== undefined && (SURFACES as readonly string[]).includes(value);
}

async function main(): Promise<void> {
  const surface = process.argv[2];

  if (!isSurface(surface)) {
    process.stderr.write(
      `tmux-ide-tui: unknown surface ${surface ? `"${surface}"` : "(none given)"}.\n` +
        `Usage: tmux-ide-tui <${SURFACES.join("|")}> [flags]\n`,
    );
    process.exit(2);
  }

  // Drop the surface token so each entry's `parseArgs()` sees only its flags.
  process.argv.splice(2, 1);

  switch (surface) {
    case "team":
      await import("./team/index.tsx");
      break;
    case "explorer":
      await import("../widgets/explorer/index.tsx");
      break;
    case "changes":
      await import("../widgets/changes/index.tsx");
      break;
    case "preview":
      await import("../widgets/preview/index.tsx");
      break;
    case "config":
      await import("../widgets/config/index.tsx");
      break;
    case "setup":
      await import("../widgets/setup/index.tsx");
      break;
    case "sidebar":
      await import("../widgets/sidebar/index.tsx");
      break;
  }
}

void main();
