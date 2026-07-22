import { For } from "solid-js";
import { render } from "solid-js/web";

import type {
  NativeTerminalAttachment,
  NativeTerminalTransport,
} from "./native-terminal-transport.ts";
import { TerminalSurface } from "./terminal-surface.tsx";

const attachment: NativeTerminalAttachment = {
  write: async () => ({ status: "ok" }),
  resize: async () => ({ status: "ok" }),
  dispose: () => undefined,
};

const encoder = new TextEncoder();
const ESC = "\u001b";
const sgr = (code: string): string => `${ESC}[${code}m`;
const RESET = sgr("0");

/** A transport that immediately connects and replays a fixed screen of bytes. */
function replayTransport(screen: string): NativeTerminalTransport {
  return {
    async connect(request, listener) {
      setTimeout(() => {
        void listener({
          type: "state",
          state: "connected",
          error: null,
          sourceGrid: request.viewport,
          clientViewport: request.viewport,
        });
        void listener({ type: "output", bytes: encoder.encode(screen) });
      }, 0);
      return { status: "connected", attachment };
    },
  };
}

/**
 * A dense TUI screen: box-drawing frames, the full 16-color ANSI palette, and
 * bold text. Box-drawing alignment and palette cohesion are exactly where poor
 * metrics or a mismatched theme show up first, so this is the eyeball target.
 */
function denseScreen(): string {
  const lines: string[] = [];
  lines.push(`${sgr("1")}${sgr("34")}tmux-ide${RESET}  terminal rendering probe\r\n`);
  lines.push("┌────────────── session ──────────────┐\r\n");
  lines.push("│ ▸ agent-a   working   ██▁▁  claude   │\r\n");
  lines.push("│ ▸ agent-b   blocked   ████  codex    │\r\n");
  lines.push("├───────────────┬─────────────────────┤\r\n");
  lines.push("│ box drawing   │ ╔═╗ ╭─╮ ┏━┓ ┌─┐ ░▒▓█ │\r\n");
  lines.push("│ alignment     │ ║ ║ │ │ ┃ ┃ │ │ ▉▊▋▌ │\r\n");
  lines.push("│ check         │ ╚═╝ ╰─╯ ┗━┛ └─┘ ▍▎▏  │\r\n");
  lines.push("└───────────────┴─────────────────────┘\r\n");

  const swatch = (base: number, offset: number): string =>
    `${sgr(String(base + offset))}██${RESET}`;
  let normal = " normal ";
  let bright = " bright ";
  for (let index = 0; index < 8; index += 1) {
    normal += swatch(30, index);
    bright += swatch(90, index);
  }
  lines.push(`${normal}\r\n`);
  lines.push(`${bright}\r\n`);
  lines.push(
    ` ${sgr("1")}${sgr("32")}✔ pass${RESET}  ${sgr("33")}● warn${RESET}  ` +
      `${sgr("31")}✘ fail${RESET}  ${sgr("36")}ℹ info${RESET}  ${sgr("2")}dim${RESET}\r\n`,
  );
  lines.push(
    `${sgr("7")} reversed ${RESET} ${sgr("4")}underline${RESET} ` + "CSP terminal ready\r\n",
  );
  lines.push(`${sgr("90")}~/dev/tmux-ide${RESET} $ ${sgr("1")}▊${RESET}`);
  return lines.join("");
}

const READY_SCREEN = `${sgr("32")}CSP terminal ready${RESET}\r\n`;

/** Real xterm/transport smoke fixture; never mounted by the product shell. */
export function mountTerminalSurfaceSmokeFixture(root: HTMLElement): () => void {
  root.className = "tmi-terminal-smoke-fixture";
  root.setAttribute("data-theme", "dark");
  return render(
    () => (
      <TerminalSurface
        target={{ workspaceName: "csp-smoke", semanticPaneId: "terminal.csp-smoke" }}
        title="Strict CSP smoke"
        transport={replayTransport(READY_SCREEN)}
        focused
      />
    ),
    root,
  );
}

interface GalleryCase {
  readonly appearance: "dark" | "light";
  readonly label: string;
  readonly width: number;
  readonly height: number;
}

const GALLERY_CASES: readonly GalleryCase[] = [
  { appearance: "dark", label: "dark · dense", width: 360, height: 260 },
  { appearance: "light", label: "light · dense", width: 360, height: 260 },
  { appearance: "dark", label: "dark · wide", width: 520, height: 200 },
  { appearance: "light", label: "light · narrow", width: 260, height: 300 },
];

/**
 * Light/dark, several sizes, dense TUI content. Mounted by the CSP smoke script
 * to screenshot terminal rendering across appearances and geometries.
 */
export function mountTerminalRenderingGalleryFixture(root: HTMLElement): () => void {
  root.className = "tmi-terminal-gallery-fixture";
  return render(
    () => (
      <div
        style={{
          display: "grid",
          "grid-template-columns": "repeat(2, max-content)",
          gap: "18px",
          padding: "18px",
        }}
      >
        <For each={GALLERY_CASES}>
          {(entry) => (
            <div
              data-theme={entry.appearance}
              style={{
                padding: "12px",
                "border-radius": "12px",
                background: entry.appearance === "dark" ? "#0e1013" : "#dfe2e6",
                color: entry.appearance === "dark" ? "#e6e8f2" : "#24252b",
              }}
            >
              <div style={{ "font-size": "11px", "margin-bottom": "6px", opacity: "0.7" }}>
                {entry.label}
              </div>
              <div
                style={{
                  width: `${entry.width}px`,
                  height: `${entry.height}px`,
                  "border-radius": "8px",
                  border: `1px solid ${entry.appearance === "dark" ? "#2b2d36" : "#c8cad2"}`,
                  overflow: "hidden",
                }}
              >
                <TerminalSurface
                  target={{
                    workspaceName: "gallery",
                    semanticPaneId: `terminal.${entry.appearance}.${entry.width}`,
                  }}
                  title={entry.label}
                  transport={replayTransport(denseScreen())}
                />
              </div>
            </div>
          )}
        </For>
      </div>
    ),
    root,
  );
}
