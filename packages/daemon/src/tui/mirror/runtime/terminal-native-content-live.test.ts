import { projectTerminalTextRow } from "../semantic-pane-render-source.ts";
import { retainNativeTerminalBacking } from "../terminal-viewport.ts";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { CanonicalTerminalReplicaUpdate, TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import { createTerminalFastLane } from "@tmux-ide/daemon-client/terminal-fast-lane";
import { TerminalFastLaneRendererAdapter } from "./terminal-fast-lane-renderer-adapter.ts";
import { applyTerminalReplicaPatch } from "@tmux-ide/core";
import { createTerminalScrollback } from "../workspace/terminal-scrollback.ts";
import { reflowNativeRows, type NativeReflowRow } from "../terminal-native-reflow.ts";
import {
  clampTerminalViewportOrigin,
  terminalLiveViewportOrigin,
  reflowRetainedTerminalSnapshot,
} from "../terminal-viewport.ts";
import { MirrorControlChannel } from "../../../terminal/mirror/control-channel.ts";
import { MirrorService } from "../../../terminal/mirror/mirror-service.ts";
import {
  extractTerminalSelection,
  terminalSelectionCell,
  terminalMouseInput,
} from "./terminal-selection.ts";
import { SessionRuntimeTerminalReplicaOwner } from "../../../terminal/session-runtime/terminal-replica-owner.ts";

const available = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const socket = `zz-capture-resize-${process.pid}`;
const directory = mkdtempSync(join(tmpdir(), "tmux-capture-resize-"));
const fixture = join(directory, "paint.mjs");
const paint =
  "\x1b[?1049h\x1b[2J" +
  Array.from(
    { length: 8 },
    (_, y) => `\x1b[${y + 1};1H\x1b[4${y % 7}mROW${y}:` + String.fromCharCode(65 + y).repeat(65),
  ).join("") +
  "\x1b[0m";
writeFileSync(
  fixture,
  `process.on('SIGWINCH', () => {}); process.stdout.write(${JSON.stringify(paint)}); setInterval(() => {}, 10000);`,
);
const tmux = (...args: string[]) =>
  execFileSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], {
    encoding: "utf8",
    env: { ...process.env, TMUX: "" },
  }).trimEnd();
afterAll(() => {
  spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
  rmSync(directory, { recursive: true, force: true });
});

// Probe only a disposable server. Stock tmux versions differ in capture-mode
// metadata and frozen-copy capture support; ordinary compatibility tests below
// still run when those newer native contracts are unavailable.
const nativeCapabilities = (() => {
  if (!available) return { captureModes: false, frozenCopy: false, physicalGrid: false };
  const probeSocket = `${socket}-capabilities`;
  const command = (...args: string[]) =>
    spawnSync("tmux", ["-L", probeSocket, "-f", "/dev/null", ...args], {
      encoding: "utf8",
      env: { ...process.env, TMUX: "" },
    });
  try {
    const started = command("new-session", "-d", "-s", "probe", "-x", "40", "-y", "8", "sleep 60");
    if (started.status !== 0)
      throw new Error(`Capability probe could not start: ${started.stderr}`);
    const modes = command(
      "display-message",
      "-p",
      "-t",
      "probe",
      "#{bracket_paste_flag}|#{mouse_all_flag}|#{origin_flag}|#{scroll_region_upper}|#{scroll_region_lower}",
    );
    command("copy-mode", "-t", "probe");
    return {
      captureModes: modes.status === 0 && /^\d+\|\d+\|\d+\|\d+\|\d+$/u.test(modes.stdout.trim()),
      frozenCopy: command("capture-pane", "-p", "-M", "-L", "-S", "-", "-t", "probe").status === 0,
      physicalGrid: command("capture-pane", "-p", "-R", "-S", "-", "-t", "probe").status === 0,
    };
  } finally {
    command("kill-server");
  }
})();
if (
  process.env.TMUX_IDE_REQUIRE_NATIVE_CAPABILITIES === "1" &&
  (!available || !Object.values(nativeCapabilities).every(Boolean))
)
  throw new Error(
    `Required bundled tmux capabilities missing: ${JSON.stringify(nativeCapabilities)}`,
  );

describe.skipIf(!available)("native one-column live geometry", () => {
  it.each(["attach", "resize", "output"])(
    "preserves native dimensions and ASCII rows after %s",
    async (stage) => {
      const session = `one-column-${stage}`;
      const script = join(directory, `${session}.mjs`);
      writeFileSync(
        script,
        `process.stdin.setRawMode(true); process.stdin.resume();
process.stdin.on('data', (data) => process.stdout.write(data));
process.on('SIGWINCH', () => {}); process.stdout.write('HOLD');`,
      );
      tmux(
        "new-session",
        "-d",
        "-s",
        session,
        "-x",
        stage === "resize" ? "8" : "1",
        "-y",
        "12",
        `${process.execPath} ${script}`,
      );
      tmux("set-option", "-t", session, "status", "off");
      await vi.waitFor(() =>
        expect(tmux("capture-pane", "-p", "-J", "-t", session)).toContain("HOLD"),
      );
      const mirror = new MirrorService({
        createIo: (target, handlers) =>
          new MirrorControlChannel({
            session: target,
            handlers,
            socketName: socket,
            configFile: "/dev/null",
          }),
      });
      let owner: SessionRuntimeTerminalReplicaOwner | undefined;
      let snapshot: TerminalReplicaSnapshot | null = null;
      let revision = -1;
      try {
        const described = await mirror.describeSession(session);
        owner = new SessionRuntimeTerminalReplicaOwner(
          "00000000-0000-4000-8000-000000000001",
          session,
          described.panes[0]!.semanticPaneId,
          mirror,
          { incarnation: "one-column:0", initialRevision: 0 },
        );
        await owner.subscribe((update) => {
          if (update.type === "terminal.seed") snapshot = update.snapshot;
          else if (update.type === "terminal.patch" && snapshot)
            snapshot = applyTerminalReplicaPatch(snapshot, update.patch);
          revision = update.revision;
        });
        const before = revision;
        if (stage === "resize") tmux("resize-window", "-t", session, "-x", "1", "-y", "12");
        if (stage === "output") tmux("send-keys", "-t", session, "-l", "P");
        if (stage !== "attach") await vi.waitFor(() => expect(revision).toBeGreaterThan(before));
        await vi.waitFor(
          () => {
            const [cols, rows] = tmux(
              "display-message",
              "-p",
              "-t",
              session,
              "#{pane_width} #{pane_height}",
            )
              .split(" ")
              .map(Number);
            expect(cols).toBe(1);
            expect(snapshot?.cols).toBe(cols);
            expect(snapshot?.rows).toBe(rows);
            expect(
              snapshot?.grid
                .map((row) =>
                  row.cells
                    .map((cell) => (cell.width === 0 ? "" : cell.grapheme || " "))
                    .join("")
                    .trimEnd(),
                )
                .join("\n")
                .trimEnd(),
            ).toBe(tmux("capture-pane", "-p", "-t", session));
          },
          { timeout: 1000 },
        );
      } finally {
        await owner?.dispose();
        await mirror.dispose();
      }
    },
    10000,
  );
});

describe.skipIf(!available)("native transient capture recovery", () => {
  it("recovers a failed initial capture through the retained control channel", async () => {
    const session = "transient-capture";
    const script = join(directory, `${session}.mjs`);
    writeFileSync(script, "process.stdout.write('TRUTH');setInterval(()=>{},10000);");
    tmux(
      "new-session",
      "-d",
      "-s",
      session,
      "-x",
      "40",
      "-y",
      "12",
      `${process.execPath} ${script}`,
    );
    tmux("set-option", "-t", session, "status", "off");
    await vi.waitFor(() => expect(tmux("capture-pane", "-p", "-t", session)).toBe("TRUTH"));
    let injected = 0;
    let channels = 0;
    const faults: unknown[] = [];
    const mirror = new MirrorService({
      internalReadHookEmission: (pane, marker) => ({
        bufferName: "transient-recovery-observer",
        signalChannel: "transient-recovery-observer",
        record: `${pane}|${marker}|workspace.pane.read|`,
      }),
      createIo: (target, handlers) => {
        channels++;
        const io = new MirrorControlChannel({
          session: target,
          handlers,
          socketName: socket,
          configFile: "/dev/null",
        });
        const send = io.commandListInline.bind(io);
        io.commandListInline = (command, count, index, onReply) => {
          if (injected === 0 && command.includes("capture-pane -p -e -J")) {
            injected++;
            onReply({ ok: false, lines: [] });
          } else send(command, count, index, onReply);
        };
        return io;
      },
    });
    const retention = await mirror.retainSession(session);
    let owner: SessionRuntimeTerminalReplicaOwner | undefined;
    let snapshot: TerminalReplicaSnapshot | null = null;
    try {
      const described = await mirror.describeSession(session);
      owner = new SessionRuntimeTerminalReplicaOwner(
        "00000000-0000-4000-8000-000000000001",
        session,
        described.panes[0]!.semanticPaneId,
        mirror,
        { incarnation: "transient:0", initialRevision: 0, onFault: (error) => faults.push(error) },
      );
      await owner.subscribe((update) => {
        if (update.type === "terminal.seed") snapshot = update.snapshot;
        else if (update.type === "terminal.patch" && snapshot)
          snapshot = applyTerminalReplicaPatch(snapshot, update.patch);
      });
      expect(injected).toBe(1);
      expect(channels).toBe(1);
      expect(faults).toEqual([]);
      expect(snapshot?.grid[0]?.cells.map((cell) => cell.grapheme).join("")).toBe("TRUTH");
    } finally {
      await owner?.dispose();
      await retention.close();
      await mirror.dispose();
    }
  }, 10000);
});

describe.skipIf(!available)("native pre-existing alternate screen", () => {
  it.each(["attach", "scroll", "exit", "exit-after-resize"] as const)(
    "preserves native screen authority on %s",
    async (stage) => {
      const session = `preexisting-alt-${stage}`;
      const script = join(directory, `${session}.mjs`);
      writeFileSync(
        script,
        `process.stdin.setRawMode(true); process.stdin.resume();
process.stdin.on('data', data => process.stdout.write(data)); process.stdout.write('READY');`,
      );
      tmux(
        "new-session",
        "-d",
        "-s",
        session,
        "-x",
        "40",
        "-y",
        "12",
        `${process.execPath} ${script}`,
      );
      tmux("set-option", "-t", session, "status", "off");
      await vi.waitFor(() => expect(tmux("capture-pane", "-p", "-t", session)).toBe("READY"));
      const shell =
        "\x1b[2J\x1b[H" +
        Array.from({ length: 30 }, (_, i) => `SHELL-LINE-${i}-abcdefghijklmnopqrstuv\r\n`).join(
          "",
        ) +
        "SHELL> ";
      tmux("send-keys", "-t", session, "-l", shell);
      await vi.waitFor(() => expect(tmux("capture-pane", "-p", "-t", session)).toContain("SHELL>"));
      const normalScreen = tmux("capture-pane", "-p", "-t", session);
      const normalHistory = tmux("capture-pane", "-p", "-S", "-", "-J", "-t", session);
      const savedCursor = tmux("display-message", "-p", "-t", session, "#{cursor_x} #{cursor_y}");
      tmux("send-keys", "-t", session, "-l", "\x1b[?1049h\x1b[2J\x1b[HALTERNATE");
      await vi.waitFor(() => expect(tmux("capture-pane", "-p", "-t", session)).toBe("ALTERNATE"));
      expect(
        tmux(
          "display-message",
          "-p",
          "-t",
          session,
          "#{alternate_on} #{alternate_saved_x} #{alternate_saved_y}",
        ),
      ).toBe(`1 ${savedCursor}`);
      expect(tmux("capture-pane", "-a", "-p", "-t", session)).toBe(normalScreen);
      expect(
        Number(tmux("display-message", "-p", "-t", session, "#{history_size}")),
      ).toBeGreaterThan(0);
      const mirror = new MirrorService({
        createIo: (target, handlers) =>
          new MirrorControlChannel({
            session: target,
            handlers,
            socketName: socket,
            configFile: "/dev/null",
          }),
      });
      let owner: SessionRuntimeTerminalReplicaOwner | undefined;
      let snapshot: TerminalReplicaSnapshot | null = null;
      const visible = () =>
        snapshot?.grid
          .map((row) =>
            row.cells
              .map((cell) => cell.grapheme || " ")
              .join("")
              .trimEnd(),
          )
          .join("\n")
          .trimEnd();
      const publications: string[] = [];
      try {
        const described = await mirror.describeSession(session);
        owner = new SessionRuntimeTerminalReplicaOwner(
          "00000000-0000-4000-8000-000000000001",
          session,
          described.panes[0]!.semanticPaneId,
          mirror,
          { incarnation: "preexisting-alt:0", initialRevision: 0 },
        );
        await owner.subscribe((update) => {
          if (update.type === "terminal.seed") snapshot = update.snapshot;
          else if (update.type === "terminal.patch" && snapshot)
            snapshot = applyTerminalReplicaPatch(snapshot, update.patch);
          if (snapshot) publications.push(visible()!);
        });
        expect(visible()).toBe("ALTERNATE");
        expect(snapshot?.history.length).toBe(
          Number(tmux("display-message", "-p", "-t", session, "#{history_size}")),
        );
        if (stage === "exit-after-resize") {
          tmux("resize-window", "-t", session, "-x", "20", "-y", "12");
          await vi.waitFor(() => {
            expect(snapshot?.cols).toBe(20);
            expect(visible()).toBe("ALTERNATE");
            expect(snapshot?.modes.alternateScreen).toBe(true);
          });
        }
        if (stage === "attach" || stage === "scroll") {
          expect(snapshot?.modes.alternateScreen).toBe(true);
          if (stage === "scroll") {
            const history = snapshot!.history;
            const output =
              "\x1b[12;1H" + Array.from({ length: 20 }, (_, i) => `\r\nALT-${i}`).join("");
            tmux("send-keys", "-t", session, "-l", output);
            await vi.waitFor(() => {
              const native = tmux("capture-pane", "-p", "-t", session);
              expect(native).toContain("ALT-19");
              expect(visible()).toBe(native);
              expect(snapshot?.history).toEqual(history);
              expect(Number(tmux("display-message", "-p", "-t", session, "#{history_size}"))).toBe(
                history.length,
              );
            });
          }
        } else {
          publications.length = 0;
          tmux("send-keys", "-t", session, "-l", "\x1b[?1049lAFTER");
          await vi.waitFor(() =>
            expect(tmux("capture-pane", "-p", "-t", session)).toContain("SHELL> AFTER"),
          );
          const expected = tmux("capture-pane", "-p", "-t", session);
          await vi.waitFor(
            () => {
              expect(tmux("capture-pane", "-p", "-t", session)).toBe(expected);
              expect(visible()).toBe(expected);
              expect(snapshot?.modes.alternateScreen).toBe(false);
              expect(tmux("capture-pane", "-p", "-S", "-", "-J", "-t", session)).toBe(
                normalHistory + " AFTER",
              );
            },
            { timeout: 1000 },
          );
          expect(publications.length).toBeGreaterThan(0);
          for (const frame of publications)
            expect([normalScreen, expected.replace(/ AFTER$/u, ""), expected]).toContain(frame);
        }
      } finally {
        await owner?.dispose();
        await mirror.dispose();
      }
    },
    10000,
  );
});

describe.skipIf(!available || !nativeCapabilities.captureModes)(
  "native scrolling region recovery",
  () => {
    it.each(
      [false, true].flatMap((origin) => [
        { top: 1, bottom: 5, origin },
        { top: 3, bottom: 8, origin },
      ]),
    )(
      "retains fixed rows from $top through $bottom with origin $origin",
      async ({ top, bottom, origin }) => {
        const session = `region-${top}-${bottom}-${origin}`;
        const script = join(directory, `${session}.mjs`);
        writeFileSync(
          script,
          `process.stdin.setRawMode(true); process.stdin.resume();
process.stdin.on('data', data => process.stdout.write(data)); process.stdout.write('READY');`,
        );
        tmux(
          "new-session",
          "-d",
          "-s",
          session,
          "-x",
          "40",
          "-y",
          "12",
          `${process.execPath} ${script}`,
        );
        tmux("set-option", "-t", session, "status", "off");
        await vi.waitFor(() => expect(tmux("capture-pane", "-p", "-t", session)).toBe("READY"));
        const rows = Array.from({ length: 12 }, (_, row) => `ROW${String(row).padStart(2, "0")}`);
        const paint =
          "\x1b[2J" +
          rows.map((text, row) => `\x1b[${row + 1};1H${text}`).join("") +
          `\x1b[${top + 1};${bottom + 1}r\x1b[?6${origin ? "h" : "l"}\x1b[${origin ? bottom - top + 1 : bottom + 1};1H`;
        tmux("send-keys", "-t", session, "-l", paint);
        await vi.waitFor(() =>
          expect(tmux("capture-pane", "-p", "-t", session)).toBe(rows.join("\n")),
        );
        expect(
          tmux(
            "display-message",
            "-p",
            "-t",
            session,
            "#{scroll_region_upper} #{scroll_region_lower} #{origin_flag} #{cursor_y}",
          ),
        ).toBe(`${top} ${bottom} ${origin ? 1 : 0} ${bottom}`);
        const mirror = new MirrorService({
          createIo: (target, handlers) =>
            new MirrorControlChannel({
              session: target,
              handlers,
              socketName: socket,
              configFile: "/dev/null",
            }),
        });
        let owner: SessionRuntimeTerminalReplicaOwner | undefined;
        let snapshot: TerminalReplicaSnapshot | null = null;
        const publications: string[][] = [];
        const visible = () =>
          snapshot?.grid
            .map((row) =>
              row.cells
                .map((cell) => cell.grapheme || " ")
                .join("")
                .trimEnd(),
            )
            .join("\n")
            .trimEnd();
        try {
          const described = await mirror.describeSession(session);
          owner = new SessionRuntimeTerminalReplicaOwner(
            "00000000-0000-4000-8000-000000000001",
            session,
            described.panes[0]!.semanticPaneId,
            mirror,
            { incarnation: "region:0", initialRevision: 0 },
          );
          await owner.subscribe((update) => {
            if (update.type === "terminal.seed") snapshot = update.snapshot;
            else if (update.type === "terminal.patch" && snapshot)
              snapshot = applyTerminalReplicaPatch(snapshot, update.patch);
            if (snapshot)
              publications.push(
                snapshot.grid.map((row) =>
                  row.cells
                    .map((cell) => cell.grapheme || " ")
                    .join("")
                    .trimEnd(),
                ),
              );
          });
          expect(visible()).toBe(rows.join("\n"));
          expect(snapshot?.modes.origin).toBe(origin);
          publications.length = 0;
          tmux("send-keys", "-t", session, "-l", "\r\nNEW");
          rows.splice(top, 1);
          rows.splice(bottom, 0, "NEW");
          await vi.waitFor(
            () => {
              expect(tmux("capture-pane", "-p", "-t", session)).toBe(rows.join("\n"));
              expect(visible()).toBe(rows.join("\n"));
              expect(snapshot?.cursor).toMatchObject({ x: 3, y: bottom });
            },
            { timeout: 1000 },
          );
          expect(publications.length).toBeGreaterThan(0);
          for (const frame of publications) {
            expect(frame.slice(0, top)).toEqual(rows.slice(0, top));
            expect(frame.slice(bottom + 1)).toEqual(rows.slice(bottom + 1));
          }
          tmux("send-keys", "-t", session, "-l", "\x1b[1;1HP");
          rows[origin ? top : 0] = "P" + rows[origin ? top : 0]!.slice(1);
          await vi.waitFor(() => {
            expect(tmux("capture-pane", "-p", "-t", session)).toBe(rows.join("\n"));
            expect(visible()).toBe(rows.join("\n"));
            expect(snapshot?.cursor).toMatchObject({ x: 1, y: origin ? top : 0 });
          });
        } finally {
          await owner?.dispose();
          await mirror.dispose();
        }
      },
      10000,
    );
  },
);

describe.skipIf(!available)("native binary mouse input", () => {
  it.each(["default", "utf8", "sgr"] as const)(
    "delivers exact %s mouse bytes through the control lane",
    async (encoding) => {
      const session = `binary-mouse-${encoding}`;
      const script = join(directory, `${session}.mjs`);
      const received = join(directory, `${session}.bin`);
      writeFileSync(received, "");
      const initial =
        "\x1b[?1000h" +
        (encoding === "sgr" ? "\x1b[?1006h" : encoding === "utf8" ? "\x1b[?1005h" : "") +
        "READY";
      writeFileSync(
        script,
        `import { appendFileSync } from 'node:fs';
process.stdin.setRawMode(true); process.stdin.resume();
process.stdin.on('data', data => appendFileSync(${JSON.stringify(received)}, data)); process.stdout.write(${JSON.stringify(initial)});`,
      );
      tmux(
        "new-session",
        "-d",
        "-s",
        session,
        "-x",
        "240",
        "-y",
        "12",
        `${process.execPath} ${script}`,
      );
      tmux("set-option", "-t", session, "status", "off");
      await vi.waitFor(() => expect(tmux("capture-pane", "-p", "-t", session)).toBe("READY"));
      const mirror = new MirrorService({
        createIo: (target, handlers) =>
          new MirrorControlChannel({
            session: target,
            handlers,
            socketName: socket,
            configFile: "/dev/null",
          }),
      });
      let owner: SessionRuntimeTerminalReplicaOwner | undefined;
      try {
        const described = await mirror.describeSession(session);
        const pane = described.panes[0]!.semanticPaneId;
        owner = new SessionRuntimeTerminalReplicaOwner(
          "00000000-0000-4000-8000-000000000001",
          session,
          pane,
          mirror,
          { incarnation: "binary:0", initialRevision: 0 },
        );
        await owner.subscribe(() => undefined);
        mirror.sendText(session, pane, "A");
        for (const action of ["down", "up"] as const) {
          const input = terminalMouseInput({ action, column: 150, row: 3 }, encoding)!;
          if (input.kind === "bytes")
            mirror.sendBytes(session, pane, Buffer.from(input.data, "hex"));
          else mirror.sendText(session, pane, input.data);
        }
        mirror.sendKey(session, pane, "Enter");
        const expected =
          encoding === "default"
            ? "411b5b4d20b7241b5b4d23b7240d"
            : encoding === "utf8"
              ? "411b5b4d20c2b7241b5b4d23c2b7240d"
              : Buffer.from("A\x1b[<0;151;4M\x1b[<0;151;4m\r").toString("hex");
        await vi.waitFor(() => expect(readFileSync(received).toString("hex")).toBe(expected));
      } finally {
        await owner?.dispose();
        await mirror.dispose();
      }
    },
    10000,
  );
});

describe.skipIf(!available || !nativeCapabilities.captureModes)(
  "native mouse and paste capture",
  () => {
    it.each(
      ["none", "vt200", "drag", "any"].flatMap((protocol) =>
        ["default", "utf8", "sgr", "both"].map((encoding) => ({ protocol, encoding })),
      ),
    )(
      "restores $protocol tracking with $encoding encoding and follows live changes",
      async ({ protocol, encoding }) => {
        const session = `mouse-${protocol}-${encoding}`;
        const script = join(directory, `${session}.mjs`);
        const mode = { none: 0, vt200: 1000, drag: 1002, any: 1003 }[protocol]!;
        const utf8 = encoding === "utf8" || encoding === "both";
        const sgr = encoding === "sgr" || encoding === "both";
        const initial =
          "\x1b[?2004h" +
          (mode ? `\x1b[?${mode}h` : "") +
          (utf8 ? "\x1b[?1005h" : "") +
          (sgr ? "\x1b[?1006h" : "") +
          "READY";
        writeFileSync(
          script,
          `process.stdin.setRawMode(true); process.stdin.resume();
process.stdin.on('data', data => process.stdout.write(data)); process.stdout.write(${JSON.stringify(initial)});`,
        );
        tmux(
          "new-session",
          "-d",
          "-s",
          session,
          "-x",
          "40",
          "-y",
          "12",
          `${process.execPath} ${script}`,
        );
        tmux("set-option", "-t", session, "status", "off");
        await vi.waitFor(() => expect(tmux("capture-pane", "-p", "-t", session)).toBe("READY"));
        const mirror = new MirrorService({
          createIo: (target, handlers) =>
            new MirrorControlChannel({
              session: target,
              handlers,
              socketName: socket,
              configFile: "/dev/null",
            }),
        });
        let owner: SessionRuntimeTerminalReplicaOwner | undefined;
        let snapshot: TerminalReplicaSnapshot | null = null;
        try {
          const described = await mirror.describeSession(session);
          owner = new SessionRuntimeTerminalReplicaOwner(
            "00000000-0000-4000-8000-000000000001",
            session,
            described.panes[0]!.semanticPaneId,
            mirror,
            { incarnation: "mouse:0", initialRevision: 0 },
          );
          await owner.subscribe((update) => {
            if (update.type === "terminal.seed") snapshot = update.snapshot;
            else if (update.type === "terminal.patch" && snapshot)
              snapshot = applyTerminalReplicaPatch(snapshot, update.patch);
          });
          expect(
            tmux(
              "display-message",
              "-p",
              "-t",
              session,
              "#{bracket_paste_flag} #{mouse_sgr_flag} #{mouse_utf8_flag}",
            ),
          ).toBe(`1 ${sgr ? 1 : 0} ${utf8 ? 1 : 0}`);
          expect(snapshot?.modes).toMatchObject({
            bracketedPaste: true,
            mouseTracking: protocol !== "none",
            mouseProtocol: protocol,
            mouseEncoding: sgr ? "sgr" : utf8 ? "utf8" : "default",
          });
          tmux("send-keys", "-t", session, "-l", "\x1b[?1006l");
          await vi.waitFor(() => {
            expect(tmux("display-message", "-p", "-t", session, "#{mouse_sgr_flag}")).toBe("0");
            expect(snapshot?.modes.mouseEncoding).toBe(utf8 ? "utf8" : "default");
          });
          tmux("send-keys", "-t", session, "-l", "\x1b[?1005;1000;2004l");
          await vi.waitFor(() => {
            expect(
              tmux(
                "display-message",
                "-p",
                "-t",
                session,
                "#{bracket_paste_flag} #{mouse_any_flag} #{mouse_utf8_flag}",
              ),
            ).toBe("0 0 0");
            expect(snapshot?.modes).toMatchObject({
              bracketedPaste: false,
              mouseTracking: false,
              mouseProtocol: "none",
              mouseEncoding: "default",
            });
          });
        } finally {
          await owner?.dispose();
          await mirror.dispose();
        }
      },
      10000,
    );
  },
);

describe.skipIf(!available)("native pending-wrap cursor", () => {
  it.each([
    { cols: 3, wrap: true },
    { cols: 4, wrap: true },
    { cols: 80, wrap: true },
    { cols: 8, wrap: false },
    { cols: 12, wrap: true },
  ])(
    "continues native output after attachment at width $cols with wrap $wrap",
    async ({ cols, wrap }) => {
      const session = `pending-wrap-${cols}`;
      const script = join(directory, `${session}.mjs`);
      const scalarModes = cols === 12;
      const modeBytes = scalarModes ? "\x1b[?1h\x1b=\x1b[4h\x1b[?25l" : "";
      const initial = !wrap ? "A" : cols === 4 ? "AB界" : "A".repeat(cols);
      writeFileSync(
        script,
        `process.stdin.setRawMode(true); process.stdin.resume();
process.stdin.on('data', (data) => process.stdout.write(data));
process.stdout.write(${JSON.stringify(modeBytes + (wrap ? "" : "\x1b[?7l") + initial)});`,
      );
      tmux(
        "new-session",
        "-d",
        "-s",
        session,
        "-x",
        String(cols),
        "-y",
        "12",
        `${process.execPath} ${script}`,
      );
      tmux("set-option", "-t", session, "status", "off");
      await vi.waitFor(() => expect(tmux("capture-pane", "-p", "-t", session)).toBe(initial));
      expect(tmux("display-message", "-p", "-t", session, "#{cursor_x}")).toBe(
        String(wrap ? cols : 1),
      );
      expect(tmux("display-message", "-p", "-t", session, "#{wrap_flag}")).toBe(wrap ? "1" : "0");
      const mirror = new MirrorService({
        createIo: (target, handlers) =>
          new MirrorControlChannel({
            session: target,
            handlers,
            socketName: socket,
            configFile: "/dev/null",
          }),
      });
      let owner: SessionRuntimeTerminalReplicaOwner | undefined;
      let snapshot: TerminalReplicaSnapshot | null = null;
      try {
        const described = await mirror.describeSession(session);
        owner = new SessionRuntimeTerminalReplicaOwner(
          "00000000-0000-4000-8000-000000000001",
          session,
          described.panes[0]!.semanticPaneId,
          mirror,
          { incarnation: "pending-wrap:0", initialRevision: 0 },
        );
        await owner.subscribe((update) => {
          if (update.type === "terminal.seed") snapshot = update.snapshot;
          else if (update.type === "terminal.patch" && snapshot)
            snapshot = applyTerminalReplicaPatch(snapshot, update.patch);
        });
        expect(snapshot?.modes.wraparound).toBe(wrap);
        expect(
          tmux(
            "display-message",
            "-p",
            "-t",
            session,
            "#{keypad_cursor_flag} #{keypad_flag} #{insert_flag} #{cursor_flag}",
          ),
        ).toBe(scalarModes ? "1 1 1 0" : "0 0 0 1");
        expect(snapshot?.modes).toMatchObject({
          applicationCursor: scalarModes,
          applicationKeypad: scalarModes,
          insert: scalarModes,
        });
        expect(snapshot?.cursor.hidden).toBe(scalarModes);
        tmux("send-keys", "-t", session, "-l", "P");
        await vi.waitFor(
          () => {
            const expected = `${initial}${wrap ? "\n" : ""}P`;
            expect(tmux("capture-pane", "-p", "-t", session)).toBe(expected);
            expect(
              snapshot?.grid
                .map((row) =>
                  row.cells
                    .map((cell) => cell.grapheme || " ")
                    .join("")
                    .trimEnd(),
                )
                .join("\n")
                .trimEnd(),
            ).toBe(expected);
            expect(snapshot?.cursor).toMatchObject(wrap ? { x: 1, y: 1 } : { x: 2, y: 0 });
          },
          { timeout: 1000 },
        );
        const nextModes = !scalarModes;
        tmux(
          "send-keys",
          "-t",
          session,
          "-l",
          nextModes ? "\x1b[?1h\x1b=\x1b[4h\x1b[?25l" : "\x1b[?1l\x1b>\x1b[4l\x1b[?25h",
        );
        await vi.waitFor(() => {
          expect(
            tmux(
              "display-message",
              "-p",
              "-t",
              session,
              "#{keypad_cursor_flag} #{keypad_flag} #{insert_flag} #{cursor_flag}",
            ),
          ).toBe(nextModes ? "1 1 1 0" : "0 0 0 1");
          expect(snapshot?.modes).toMatchObject({
            applicationCursor: nextModes,
            applicationKeypad: nextModes,
            insert: nextModes,
          });
          expect(snapshot?.cursor.hidden).toBe(nextModes);
        });
      } finally {
        await owner?.dispose();
        await mirror.dispose();
      }
    },
    10000,
  );
});

describe.skipIf(!available)("native quiet alternate-screen capture after resize", () => {
  it.each(["top", "bottom", "off"])(
    "retains native rows with border status %s",
    async (border) => {
      const session = `quiet-${border}`;
      tmux(
        "new-session",
        "-d",
        "-s",
        session,
        "-x",
        "80",
        "-y",
        "15",
        `${process.execPath} ${fixture}`,
      );
      tmux("set-option", "-w", "-t", session, "pane-border-status", border);
      await vi.waitFor(() => expect(tmux("capture-pane", "-p", "-t", session)).toContain("ROW7:"));
      const mirror = new MirrorService({
        createIo: (target, handlers) =>
          new MirrorControlChannel({
            session: target,
            handlers,
            socketName: socket,
            configFile: "/dev/null",
          }),
      });
      let owner: SessionRuntimeTerminalReplicaOwner | undefined;
      try {
        const described = await mirror.describeSession(session);
        owner = new SessionRuntimeTerminalReplicaOwner(
          "00000000-0000-4000-8000-000000000001",
          session,
          described.panes[0]!.semanticPaneId,
          mirror,
          { incarnation: "quiet:0", initialRevision: 0 },
        );
        let latest: CanonicalTerminalReplicaUpdate | undefined;
        await owner.subscribe((update) => {
          latest = update;
        });
        // These deliberate native resize commands test capture fidelity. Client
        // sizing policy is exercised separately by geometry-ownership live tests.
        for (const cols of [40, 95, 32, 80]) {
          tmux("resize-window", "-t", session, "-x", String(cols));
          await vi.waitFor(
            () => {
              expect(latest?.type).toBe("terminal.seed");
              expect(latest?.cols).toBe(cols);
              if (latest?.type !== "terminal.seed") return;
              const native = tmux("capture-pane", "-p", "-t", session).split("\n");
              const rendered = latest.snapshot.grid.map((row) =>
                row.cells
                  .map((cell) => (cell.width === 0 ? "" : cell.grapheme || " "))
                  .join("")
                  .trimEnd(),
              );
              expect(latest.snapshot.rows).toBe(
                Number(tmux("display-message", "-p", "-t", session, "#{pane_height}")),
              );
              expect(rendered.join("\n").trimEnd()).toEqual(native.join("\n").trimEnd());
              expect(latest.snapshot.grid[1]?.cells[0]?.background).toEqual({
                kind: "indexed",
                index: 1,
              });
            },
            { timeout: 5000 },
          );
        }
      } finally {
        await owner?.dispose();
        await mirror.dispose();
      }
    },
    20000,
  );
});

describe.skipIf(!available)("native normal-screen bottom row and cursor", () => {
  it.each(["top", "bottom", "off"])(
    "preserves nested content through native zoom and resize with %s borders",
    async (border) => {
      const normal = join(directory, `normal-${border}.mjs`);
      const normalOutput =
        Array.from(
          { length: 80 },
          (_, i) => `${i % 2 === 0 ? "\x1b[32m漢 e\u0301\x1b[0m " : ""}line-${i}`,
        ).join("\r\n") + " BOTTOM";
      writeFileSync(
        normal,
        `process.on('SIGWINCH', () => {}); process.stdout.write(${JSON.stringify(normalOutput)}); setInterval(() => {}, 10000);`,
      );
      const session = `normal-${border}`;
      tmux(
        "new-session",
        "-d",
        "-s",
        session,
        "-x",
        "80",
        "-y",
        "25",
        `${process.execPath} ${normal}`,
      );
      tmux("set-option", "-w", "-t", session, "pane-border-status", border);
      tmux("split-window", "-v", "-t", session, `${process.execPath} ${normal}`);
      tmux("split-window", "-h", "-t", session, `${process.execPath} ${normal}`);
      const mirror = new MirrorService({
        createIo: (target, handlers) =>
          new MirrorControlChannel({
            session: target,
            handlers,
            socketName: socket,
            configFile: "/dev/null",
          }),
      });
      const owners: SessionRuntimeTerminalReplicaOwner[] = [];
      try {
        await vi.waitFor(() =>
          expect(tmux("capture-pane", "-p", "-t", session)).toContain("BOTTOM"),
        );
        const described = await mirror.describeSession(session);
        const runtimeIds = tmux("list-panes", "-t", session, "-F", "#{pane_id}").split("\n");
        for (const [index, pane] of described.panes.entries()) {
          const owner = new SessionRuntimeTerminalReplicaOwner(
            "00000000-0000-4000-8000-000000000001",
            session,
            pane.semanticPaneId,
            mirror,
            { incarnation: "normal:0", initialRevision: 0 },
          );
          owners.push(owner);
          let latest: CanonicalTerminalReplicaUpdate | undefined;
          await owner.subscribe((update) => {
            latest = update;
          });
          const runtimeId = runtimeIds[index]!;
          const transitions = [
            ["resize-window", "-t", session, "-x", "40", "-y", "25"],
            ["resize-pane", "-Z", "-t", runtimeId],
            ["resize-window", "-t", session, "-x", "95", "-y", "31"],
            ["resize-pane", "-Z", "-t", runtimeId],
            ["resize-window", "-t", session, "-x", "60", "-y", "19"],
          ];
          for (const transition of transitions) {
            tmux(...transition);
            await vi.waitFor(() => {
              expect(latest?.type).toBe("terminal.seed");
              if (latest?.type !== "terminal.seed") return;
              const [cols, nativeRows, x, y] = tmux(
                "display-message",
                "-p",
                "-t",
                runtimeId,
                "#{pane_width} #{pane_height} #{cursor_x} #{cursor_y}",
              )
                .split(" ")
                .map(Number);
              expect(latest.cols).toBe(cols);
              expect(latest.rows).toBe(nativeRows);
              expect(
                latest.snapshot.grid
                  .map((row) =>
                    row.cells
                      .map((cell) => (cell.width === 0 ? "" : cell.grapheme || " "))
                      .join("")
                      .trimEnd(),
                  )
                  .join("\n")
                  .trimEnd(),
              ).toBe(tmux("capture-pane", "-p", "-t", runtimeId));
              expect(latest.snapshot.cursor).toMatchObject({ x: Math.min(x!, cols! - 1), y });
              expect(latest.snapshot.history.length).toBeGreaterThan(0);
              expect(
                latest.snapshot.history.some((row) =>
                  row.cells.some(
                    (cell) =>
                      cell.grapheme === "漢" &&
                      cell.foreground.kind === "indexed" &&
                      cell.foreground.index === 2,
                  ),
                ),
              ).toBe(true);
              const nativeHistory = tmux(
                "capture-pane",
                "-p",
                "-S",
                "-2000",
                "-E",
                "-1",
                "-t",
                runtimeId,
              );
              expect(
                latest.snapshot.history
                  .map((row) =>
                    row.cells
                      .map((cell) => (cell.width === 0 ? "" : cell.grapheme || " "))
                      .join("")
                      .trimEnd(),
                  )
                  .join("\n")
                  .trimEnd(),
              ).toBe(nativeHistory);
              const offset = Math.min(3, latest.snapshot.history.length);
              const first = terminalSelectionCell(latest.snapshot, 0, 0, offset);
              const last = terminalSelectionCell(latest.snapshot, cols! - 1, offset - 1, offset);
              expect(first).not.toBeNull();
              expect(last).not.toBeNull();
              expect(extractTerminalSelection(latest.snapshot, first!, last!)?.text).toBe(
                nativeHistory.split("\n").slice(-offset).join("\n"),
              );
              expect(
                latest.snapshot.grid[y!]?.cells
                  .map((cell) => (cell.width === 0 ? "" : cell.grapheme || " "))
                  .join("")
                  .trimEnd(),
              ).toBe("line-79 BOTTOM");
            });
          }
        }
      } finally {
        for (const owner of owners) await owner.dispose();
        await mirror.dispose();
      }
    },
    20000,
  );
});

describe.skipIf(!available)("native cursor movement in independent client viewports", () => {
  it("retains cropped reading without history while another client follows the native cursor", async () => {
    const session = "cropped-reading";
    const script = join(directory, "cropped-reading.mjs");
    const output =
      "\x1b[?25h\x1b[2J" +
      Array.from(
        { length: 49 },
        (_, row) =>
          `\x1b[${row + 1};1H` + `ROW${String(row).padStart(2, "0")}|`.repeat(13).slice(0, 77),
      ).join("") +
      "\x1b[49;77H";
    writeFileSync(
      script,
      `process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on('data',()=>process.stdout.write('\\x1b[1;1H'));process.stdout.write(${JSON.stringify(output)});`,
    );
    tmux(
      "new-session",
      "-d",
      "-s",
      session,
      "-x",
      "77",
      "-y",
      "49",
      `${process.execPath} ${script}`,
    );
    tmux("set-option", "-t", session, "status", "off");
    tmux("set-option", "-w", "-t", session, "pane-border-status", "off");
    tmux("resize-window", "-t", session, "-x", "77", "-y", "49");
    const mirror = new MirrorService({
      createIo: (target, handlers) =>
        new MirrorControlChannel({
          session: target,
          handlers,
          socketName: socket,
          configFile: "/dev/null",
        }),
    });
    let owner: SessionRuntimeTerminalReplicaOwner | undefined;
    const clients: ReturnType<typeof createTerminalScrollback>[] = [];
    let snapshot: TerminalReplicaSnapshot | null = null;
    const listeners = new Set<() => void>();
    let revision = -1;
    try {
      await vi.waitFor(() =>
        expect(
          tmux("display-message", "-p", "-t", session, "#{cursor_x},#{cursor_y},#{history_size}"),
        ).toBe("76,48,0"),
      );
      const described = await mirror.describeSession(session);
      const paneId = described.panes[0]!.semanticPaneId;
      owner = new SessionRuntimeTerminalReplicaOwner(
        "00000000-0000-4000-8000-000000000001",
        session,
        paneId,
        mirror,
        { incarnation: "cropped:0", initialRevision: 0 },
      );
      await owner.subscribe((update) => {
        if (update.type === "terminal.seed") snapshot = update.snapshot;
        else if (update.type === "terminal.patch" && snapshot) {
          expect(update.baseRevision).toBe(revision);
          snapshot = applyTerminalReplicaPatch(snapshot, update.patch);
        }
        revision = update.revision;
        for (const listener of listeners) listener();
      });
      await vi.waitFor(() => expect(snapshot?.cursor).toMatchObject({ x: 76, y: 48 }));
      const nativeBefore = tmux("capture-pane", "-p", "-t", session);
      const source = {
        renderSource: {
          scrollbackDepth: () => snapshot!.history.length,
          paneCanonicalIdentity: () => ({ sourceEpoch: 1, incarnation: "cropped:0" }),
        },
        subscribePaneVersion: (_id: string, listener: () => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
      const small = { cols: 53, rows: 40 };
      const large = { cols: 77, rows: 49 };
      const first = createTerminalScrollback(
        source,
        () => terminalLiveViewportOrigin(snapshot!, small),
        (_id, origin) =>
          clampTerminalViewportOrigin(snapshot!, small, origin, snapshot!.history.length),
      );
      const second = createTerminalScrollback(source, () =>
        terminalLiveViewportOrigin(snapshot!, large),
      );
      clients.push(first, second);
      first.move(paneId, 3);
      expect(first.origin(paneId)).toEqual({ x: 24, y: 6 });
      expect(second.origin(paneId)).toBeNull();
      const readingRow = () => {
        const origin = first.origin(paneId)!;
        return snapshot!.grid[origin.y]!.cells.slice(origin.x, origin.x + small.cols)
          .map((cell) => cell.grapheme || " ")
          .join("");
      };
      const retainedRow = nativeBefore.split("\n")[6]!.slice(24, 77);
      expect(readingRow()).toBe(retainedRow);
      tmux("send-keys", "-t", session, "-l", "h");
      await vi.waitFor(() => expect(snapshot?.cursor).toMatchObject({ x: 0, y: 0 }));
      expect(snapshot!.history).toHaveLength(0);
      expect(first.origin(paneId)).toEqual({ x: 24, y: 6 });
      expect(readingRow()).toBe(retainedRow);
      expect(second.origin(paneId)).toBeNull();
      expect(terminalLiveViewportOrigin(snapshot!, large)).toEqual({ x: 0, y: 0 });
      expect(tmux("capture-pane", "-p", "-t", session)).toBe(nativeBefore);
      expect(tmux("display-message", "-p", "-t", session, "#{pane_width},#{pane_height}")).toBe(
        "77,49",
      );
      first.live(paneId);
      expect(first.origin(paneId)).toBeNull();
      expect(listeners.size).toBe(0);
    } finally {
      for (const client of clients) client.dispose();
      await owner?.dispose();
      await mirror.dispose();
    }
  }, 15000);
});

// Exercise application redraws, not just quiet captures: native zoom changes
// the PTY size while its SIGWINCH output races with the mirror's reseed.
describe.skipIf(!available)("native nested redraw synchronization", () => {
  it("matches native contents through repeated zoom and border changes", async () => {
    const session = "nested-redraw";
    const program = join(directory, "nested-redraw.mjs");
    writeFileSync(
      program,
      `const draw=()=>process.stdout.write('\\x1b[2J\\x1b[HTOP\\x1b['+process.stdout.rows+';1HBOTTOM');process.stdout.write('\\x1b[?1049h');process.on('SIGWINCH',draw);draw();setInterval(()=>{},10000);`,
    );
    tmux(
      "new-session",
      "-d",
      "-s",
      session,
      "-x",
      "132",
      "-y",
      "41",
      `${process.execPath} ${program}`,
    );
    tmux("set-option", "-w", "-t", session, "pane-border-status", "top");
    tmux("split-window", "-h", "-t", session, `${process.execPath} ${program}`);
    tmux("split-window", "-v", "-t", session, `${process.execPath} ${program}`);
    const target = tmux("display-message", "-p", "-t", session, "#{pane_id}");
    const mirror = new MirrorService({
      createIo: (name, handlers) =>
        new MirrorControlChannel({
          session: name,
          handlers,
          socketName: socket,
          configFile: "/dev/null",
        }),
    });
    let owner: SessionRuntimeTerminalReplicaOwner | undefined;
    let snapshot: TerminalReplicaSnapshot | undefined;
    let revision = 0;
    const faults: string[] = [];
    try {
      await vi.waitFor(() => expect(tmux("capture-pane", "-p", "-t", target)).toContain("BOTTOM"));
      const described = await mirror.describeSession(session);
      owner = new SessionRuntimeTerminalReplicaOwner(
        "00000000-0000-4000-8000-000000000001",
        session,
        described.panes[2]!.semanticPaneId,
        mirror,
        {
          incarnation: "redraw:0",
          initialRevision: 0,
          onFault: (error) => faults.push(String(error)),
        },
      );
      await owner.subscribe((update) => {
        if (update.type === "terminal.seed") snapshot = update.snapshot;
        else if (update.type === "terminal.patch" && snapshot) {
          expect(update.baseRevision).toBe(revision);
          snapshot = applyTerminalReplicaPatch(snapshot, update.patch);
        }
        revision = update.revision;
      });
      const coherent = async (stage: string) =>
        vi.waitFor(
          () => {
            expect(faults, `${stage}: replica faults`).toEqual([]);
            const [cols, rows] = tmux(
              "display-message",
              "-p",
              "-t",
              target,
              "#{pane_width} #{pane_height}",
            )
              .split(" ")
              .map(Number);
            const expected = tmux("capture-pane", "-p", "-t", target);
            expect(expected.split("\n").length, `${stage}: native redraw complete`).toBe(rows);
            expect(snapshot?.grid.length, `${stage}: replica height`).toBe(rows);
            expect(snapshot?.grid[0]?.cells.length, `${stage}: replica width`).toBe(cols);
            const actual = snapshot?.grid
              .map((row) =>
                row.cells
                  .map((cell) => (cell.width === 0 ? "" : cell.grapheme || " "))
                  .join("")
                  .trimEnd(),
              )
              .join("\n")
              .trimEnd();
            expect(actual, stage).toBe(expected);
          },
          { timeout: 3000, interval: 25 },
        );
      await coherent("bootstrap");
      for (let cycle = 0; cycle < 3; cycle++) {
        for (const border of ["top", "bottom", "off"]) {
          tmux("set-option", "-w", "-t", session, "pane-border-status", border);
          await coherent(`${cycle}/${border}/border`);
          tmux("resize-pane", "-Z", "-t", target);
          await coherent(`${cycle}/${border}/zoom`);
          tmux("resize-pane", "-Z", "-t", target);
          await coherent(`${cycle}/${border}/restore`);
        }
      }
    } finally {
      await owner?.dispose();
      await mirror.dispose();
      tmux("kill-session", "-t", session);
    }
  }, 30_000);
});

describe.skipIf(!available)("native history authority", () => {
  it.each(["limit", "clear", "large"])(
    "matches native history after %s",
    async (mode) => {
      const batch = mode === "large" ? 6000 : 40;
      const session = `history-${mode}`;
      const script = join(directory, `${session}.mjs`);
      writeFileSync(
        script,
        `let n=0;const draw=()=>{for(let i=0;i<${batch};i++)process.stdout.write('LINE-'+(++n)+' 界é\\r\\n');process.stdout.write('DONE-'+n);};process.stdin.setRawMode(true);process.stdin.on('data',draw);draw();`,
      );
      tmux("new-session", "-d", "-s", session, "-x", "40", "-y", "8");
      tmux("set-option", "-t", session, "status", "off");
      tmux("set-option", "-t", session, "history-limit", mode === "large" ? "10000" : "12");
      tmux("new-window", "-d", "-t", session, "-n", "history", `${process.execPath} ${script}`);
      const target = `${session}:history`;
      await vi.waitFor(() =>
        expect(tmux("capture-pane", "-p", "-t", target)).toContain(`DONE-${batch}`),
      );
      const mirror = new MirrorService({
        createIo: (name, handlers) =>
          new MirrorControlChannel({
            session: name,
            handlers,
            socketName: socket,
            configFile: "/dev/null",
          }),
      });
      let owner: SessionRuntimeTerminalReplicaOwner | undefined;
      let snapshot: TerminalReplicaSnapshot | null = null;
      let revision = -1;
      const text = () =>
        [...snapshot!.history, ...snapshot!.grid]
          .map((row) =>
            row.cells
              .map((cell) => (cell.width === 0 ? "" : cell.grapheme || " "))
              .join("")
              .trimEnd(),
          )
          .join("\n")
          .trimEnd();
      try {
        const described = await mirror.describeSession(session);
        const pane = described.panes.find((pane) => pane.windowName === "history");
        expect(pane).toBeDefined();
        owner = new SessionRuntimeTerminalReplicaOwner(
          "00000000-0000-4000-8000-000000000001",
          session,
          pane!.semanticPaneId,
          mirror,
          { incarnation: `${mode}:0`, initialRevision: 0 },
        );
        await owner.subscribe((update) => {
          if (update.type === "terminal.seed") snapshot = update.snapshot;
          else if (update.type === "terminal.patch" && snapshot) {
            expect(update.baseRevision).toBe(revision);
            snapshot = applyTerminalReplicaPatch(snapshot, update.patch);
          }
          revision = update.revision;
        });
        await vi.waitFor(() => {
          expect(snapshot).not.toBeNull();
          expect(text()).toBe(tmux("capture-pane", "-p", "-S", "-", "-t", target));
        });
        expect(
          Number(tmux("display-message", "-p", "-t", target, "#{history_size}")),
        ).toBeGreaterThan(0);
        if (mode === "clear") tmux("clear-history", "-t", target);
        else tmux("send-keys", "-t", target, "-l", "more");
        await vi.waitFor(
          () => {
            if (mode !== "clear") expect(text()).toContain(`DONE-${batch * 2}`);
            expect(snapshot!.history.length).toBe(
              Number(tmux("display-message", "-p", "-t", target, "#{history_size}")),
            );
            expect(text()).toBe(tmux("capture-pane", "-p", "-S", "-", "-t", target));
          },
          { timeout: 2500 },
        );
        if (mode === "clear") {
          tmux("send-keys", "-t", target, "-l", "more");
          await vi.waitFor(() => expect(text()).toContain("DONE-80"));
          tmux("clear-history", "-t", target);
          await vi.waitFor(() => expect(snapshot!.history.length).toBe(0), { timeout: 2500 });
          expect(text()).toBe(tmux("capture-pane", "-p", "-S", "-", "-t", target));
        }
      } finally {
        await owner?.dispose();
        await mirror.dispose();
      }
    },
    10000,
  );
});

describe.skipIf(!available)("native history reader continuity", () => {
  it.each([
    "retention",
    "reflow-content",
    "reflow",
    "height",
    "active-reflow",
    "active-trim-reflow",
  ])(
    "keeps two readers on retained text through native %s",
    async (scenario) => {
      const session = `history-readers-${scenario}`;
      const script = join(directory, `${session}.mjs`);
      writeFileSync(
        script,
        `let n=0;const draw=()=>{const count=n===0?120:5;for(let i=0;i<count;i++)process.stdout.write('ROW-'+(++n)+' 界é\\r\\n');process.stdout.write('DONE-'+n);};process.stdin.setRawMode(true);process.stdin.on('data',draw);${scenario.startsWith("active-") ? "process.on('SIGWINCH',draw);" : ""}draw();`,
      );
      tmux("new-session", "-d", "-s", session, "-x", "40", "-y", "8");
      tmux("set-option", "-t", session, "status", "off");
      tmux(
        "set-option",
        "-t",
        session,
        "history-limit",
        scenario === "active-reflow" ? "1000" : "100",
      );
      tmux("new-window", "-d", "-t", session, "-n", "history", `${process.execPath} ${script}`);
      const target = `${session}:history`;
      await vi.waitFor(() =>
        expect(tmux("capture-pane", "-p", "-t", target)).toContain("DONE-120"),
      );
      const mirror = new MirrorService({
        createIo: (name, handlers) =>
          new MirrorControlChannel({
            session: name,
            handlers,
            socketName: socket,
            configFile: "/dev/null",
          }),
      });
      let owner: SessionRuntimeTerminalReplicaOwner | undefined;
      let disposeClient = () => {};
      try {
        const described = await mirror.describeSession(session);
        const paneId = described.panes.find(
          (pane) => pane.windowName === "history",
        )!.semanticPaneId;
        const generation = "00000000-0000-4000-8000-000000000001";
        let deliver: ((update: CanonicalTerminalReplicaUpdate) => void) | undefined;
        const lane = createTerminalFastLane({
          address: { workspaceName: session, generation },
          source: {
            subscribe: (_address, listener) => {
              deliver = listener;
              return () => {
                deliver = undefined;
              };
            },
          },
          repair: {
            request: () => {
              throw new Error("unexpected replica repair");
            },
          },
          control: {
            owns: () => true,
            request: async () => true,
            write: async () => "ok",
            resize: async () => "ok",
          },
        });
        const adapter = new TerminalFastLaneRendererAdapter(lane);
        const copyAdapter = new TerminalFastLaneRendererAdapter(lane);
        const releaseCopy = copyAdapter.subscribePaneVersion(paneId, () => {});
        const release = adapter.subscribePaneVersion(paneId, () => {});
        const first = createTerminalScrollback(adapter);
        const second = createTerminalScrollback(adapter);
        disposeClient = () => {
          first.dispose();
          second.dispose();
          release();
          releaseCopy();
          copyAdapter.dispose();
          adapter.dispose();
          lane.dispose();
        };
        owner = new SessionRuntimeTerminalReplicaOwner(generation, session, paneId, mirror, {
          incarnation: "readers:0",
          initialRevision: 0,
        });
        let seedCount = 0;
        await owner.subscribe((update) => {
          if (update.type === "terminal.seed") seedCount++;
          deliver?.(update);
        });
        const snapshot = () => lane.paneState(paneId)!.snapshot!;
        const rowText = (row: TerminalReplicaSnapshot["history"][number]) =>
          row.cells
            .map((cell) => (cell.width === 0 ? "" : cell.grapheme || " "))
            .join("")
            .trimEnd();
        const text = () =>
          [...snapshot().history, ...snapshot().grid].map(rowText).join("\n").trimEnd();
        await vi.waitFor(() =>
          expect(text()).toBe(tmux("capture-pane", "-p", "-S", "-", "-t", target)),
        );
        const selectedSnapshot = copyAdapter.paneSelectionSnapshot(paneId)!;
        const selectedStart = { row: 0, col: 0 };
        const selectedEnd = { row: 0, col: selectedSnapshot.cols - 1 };
        const selectedText = extractTerminalSelection(selectedSnapshot, selectedStart, selectedEnd);
        expect(selectedText).not.toBeNull();
        const returnCopyLive = copyAdapter.retainPaneView(paneId)!;
        expect(returnCopyLive).toBeTypeOf("function");
        const initialSeeds = seedCount;
        const nativeSizes = [snapshot().history.length];
        first.move(paneId, 10);
        second.move(paneId, 5);
        const readingText = (reader: typeof first) => {
          const origin = reader.origin(paneId);
          expect(origin).not.toBeNull();
          return rowText(
            [...snapshot().history, ...snapshot().grid][snapshot().history.length + origin!.y]!,
          );
        };
        const held = [readingText(first), readingText(second)];
        expect(held[0]).not.toBe(held[1]);
        for (let cycle = 1; cycle <= 3; cycle++) {
          tmux("send-keys", "-t", target, "-l", "x");
          await vi.waitFor(
            () => {
              expect(text()).toContain(`DONE-${120 + cycle * 5}`);
              expect(text()).toBe(tmux("capture-pane", "-p", "-S", "-", "-t", target));
            },
            { timeout: 3000 },
          );
          expect(copyAdapter.paneSelectionSnapshot(paneId)).toBe(selectedSnapshot);
          expect(
            extractTerminalSelection(
              copyAdapter.paneSelectionSnapshot(paneId)!,
              selectedStart,
              selectedEnd,
            ),
          ).toEqual(selectedText);
          expect(adapter.paneSelectionSnapshot(paneId)).toBe(snapshot());
          nativeSizes.push(snapshot().history.length);
          expect([readingText(first), readingText(second)]).toEqual(held);
        }
        if (scenario !== "active-reflow") {
          expect(
            nativeSizes.some((size, index) => index > 0 && size < nativeSizes[index - 1]!),
          ).toBe(true);
          expect(seedCount).toBeGreaterThan(initialSeeds);
        }
        returnCopyLive();
        expect(copyAdapter.paneSelectionSnapshot(paneId)).toBe(snapshot());
        first.live(paneId);
        expect(readingText(second)).toBe(held[1]);
        first.move(paneId, Infinity);
        const oldest = readingText(first);
        tmux("send-keys", "-t", target, "-l", "x");
        await vi.waitFor(
          () => {
            expect(text()).toContain("DONE-140");
            expect(text()).toBe(tmux("capture-pane", "-p", "-S", "-", "-t", target));
          },
          { timeout: 3000 },
        );
        if (scenario === "active-reflow") expect(readingText(first)).toBe(oldest);
        else expect(readingText(first)).not.toBe(oldest);
        expect(readingText(first)).toBe(rowText(snapshot().history[0]!));
        expect(readingText(second)).toBe(held[1]);
        if (scenario === "height") {
          for (const height of [12, 5, 120, 8]) {
            tmux("resize-window", "-t", target, "-x", "40", "-y", String(height));
            await vi.waitFor(
              () => {
                expect(snapshot().rows).toBe(height);
                expect(text()).toBe(tmux("capture-pane", "-p", "-S", "-", "-t", target));
              },
              { timeout: 3000 },
            );
            expect(readingText(second)).toBe(held[1]);
          }
        }
        if (scenario.startsWith("reflow") || scenario.startsWith("active-")) {
          const logicalReadingText = () => {
            const rows = [...snapshot().history, ...snapshot().grid];
            const origin = second.origin(paneId);
            expect(origin).not.toBeNull();
            let index = snapshot().history.length + origin!.y;
            while (index > 0 && rows[index]!.wrapped) index--;
            let value = "";
            do {
              value += rows[index]!.cells.map((cell) =>
                cell.width === 0 ? "" : cell.grapheme || " ",
              ).join("");
              index++;
            } while (rows[index]?.wrapped);
            return value.trimEnd();
          };
          expect(logicalReadingText()).toBe(held[1]);
          for (const [step, width] of [8, 40].entries()) {
            tmux("resize-window", "-t", target, "-x", String(width), "-y", "8");
            await vi.waitFor(
              () => {
                expect(snapshot().cols).toBe(width);
                if (scenario.startsWith("active-"))
                  expect(text()).toContain(`DONE-${145 + step * 5}`);
                expect(text()).toBe(tmux("capture-pane", "-p", "-S", "-", "-t", target));
              },
              { timeout: 3000 },
            );
            if (scenario !== "reflow-content") {
              expect(tmux("capture-pane", "-p", "-J", "-S", "-", "-t", target)).toContain(held[1]);
              expect(logicalReadingText()).toBe(held[1]);
            }
          }
        }
      } finally {
        disposeClient();
        await owner?.dispose();
        await mirror.dispose();
      }
    },
    15000,
  );
});

describe.skipIf(!available)("native wrapped selection", () => {
  it("copies the same word separator as tmux copy mode", async () => {
    const session = "copy-wrapped-space";
    const script = join(directory, `${session}.mjs`);
    writeFileSync(
      script,
      `process.stdin.setRawMode(true);process.stdout.write('READY');process.stdin.on('data',()=>process.stdout.write(${JSON.stringify("\x1b[H\x1b[Jhello world\r\nNEXT")}));`,
    );
    tmux("new-session", "-d", "-s", session, "-x", "6", "-y", "8", `${process.execPath} ${script}`);
    tmux("set-option", "-t", session, "status", "off");
    tmux("set-window-option", "-t", session, "mode-keys", "vi");
    await vi.waitFor(() => expect(tmux("capture-pane", "-p", "-t", session)).toContain("READY"));
    tmux("clear-history", "-t", session);
    tmux("send-keys", "-t", session, "-l", "x");
    await vi.waitFor(() =>
      expect(tmux("capture-pane", "-p", "-J", "-t", session)).toContain("hello world"),
    );
    tmux("clear-history", "-t", session);
    expect(tmux("display-message", "-p", "-t", session, "#{history_size}")).toBe("0");
    const mirror = new MirrorService({
      createIo: (name, handlers) =>
        new MirrorControlChannel({
          session: name,
          handlers,
          socketName: socket,
          configFile: "/dev/null",
        }),
    });
    let owner: SessionRuntimeTerminalReplicaOwner | undefined;
    try {
      const described = await mirror.describeSession(session);
      owner = new SessionRuntimeTerminalReplicaOwner(
        "00000000-0000-4000-8000-000000000001",
        session,
        described.panes[0]!.semanticPaneId,
        mirror,
        { incarnation: "copy:0", initialRevision: 0 },
      );
      let snapshot: TerminalReplicaSnapshot | undefined;
      await owner.subscribe((update) => {
        if (update.type === "terminal.seed") snapshot = update.snapshot;
      });
      expect(snapshot!.grid[1]!.wrapped).toBe(true);
      const copied = extractTerminalSelection(snapshot!, { row: 0, col: 0 }, { row: 1, col: 4 });
      tmux("copy-mode", "-t", session);
      tmux("send-keys", "-X", "-t", session, "history-top");
      tmux("send-keys", "-X", "-t", session, "start-of-line");
      tmux("send-keys", "-X", "-t", session, "begin-selection");
      tmux("send-keys", "-X", "-t", session, "cursor-down");
      for (let column = 0; column < 4; column++)
        tmux("send-keys", "-X", "-t", session, "cursor-right");
      tmux("send-keys", "-X", "-t", session, "copy-selection-and-cancel");
      const native = tmux("show-buffer");
      expect(native).toBe("hello world");
      expect(copied).toEqual({ text: native, bytes: Buffer.byteLength(native) });
    } finally {
      await owner?.dispose();
      await mirror.dispose();
    }
  }, 10000);
});

describe.skipIf(!available || !nativeCapabilities.frozenCopy)(
  "native physical padding reflow",
  () => {
    it.each([false, true])(
      "preserves physical rows with preexisting extended padding %s",
      async (extendedPadding) => {
        const session = `physical-padding-reflow-${extendedPadding}`;
        const script = join(directory, `${session}.mjs`);
        writeFileSync(
          script,
          `process.stdout.write(${JSON.stringify((extendedPadding ? "\x1b[1;10Hé\x1b[H" : "") + "COPY-0  界é\r\nREADY")});setInterval(()=>{},10000);`,
        );
        tmux(
          "new-session",
          "-d",
          "-s",
          session,
          "-x",
          "40",
          "-y",
          "8",
          `${process.execPath} ${script}`,
        );
        tmux("set-option", "-t", session, "status", "off");
        await vi.waitFor(() =>
          expect(tmux("capture-pane", "-p", "-t", session)).toContain("READY"),
        );
        // Both seeds expose identical painted capture and cursor/history metadata.
        // Their first narrow reflow differs because compact/extended padding is hidden.
        expect(tmux("capture-pane", "-p", "-e", "-J", "-S", "-", "-t", session)).toBe(
          "COPY-0  界é\nREADY",
        );
        expect(
          tmux("display-message", "-p", "-t", session, "#{cursor_x}:#{cursor_y}:#{history_size}"),
        ).toBe("5:1:0");
        tmux("copy-mode", "-t", session);
        const ascii = (text: string) =>
          [...text].map((text) => ({ text, width: 1, padding: false }));
        let backing: readonly NativeReflowRow[] = [
          {
            cells: [
              ...ascii("COPY-0  "),
              { text: "界", width: 2, padding: false },
              { text: "!", width: extendedPadding ? 0 : 1, padding: true },
              { text: "é", width: 1, padding: false },
            ],
            extended: true,
            continues: false,
          },
          { cells: ascii("READY"), extended: false, continues: false },
          ...Array.from({ length: 6 }, () => ({ cells: [], extended: false, continues: false })),
        ];
        try {
          for (const cols of [3, 8, 3, 2, 5, 40, 1, 40]) {
            tmux("resize-window", "-t", session, "-x", String(cols), "-y", "8");
            backing = reflowNativeRows(backing, cols);
            while (backing.length < 8)
              backing = [...backing, { cells: [], extended: false, continues: false }];
            const captured = backing
              .map((row, index) => {
                const text = row.cells
                  .filter((cell) => !cell.padding)
                  .map((cell) => cell.text)
                  .join("")
                  .trimEnd();
                return `${index - (backing.length - 8)} ${text}`;
              })
              .join("\n")
              .trimEnd();
            expect(captured, `physical rows at ${cols} columns`).toBe(
              tmux("capture-pane", "-p", "-M", "-L", "-S", "-", "-t", session),
            );
            if (cols === 2) {
              const wide = backing.find((row) => row.cells.some((cell) => cell.text === "界"))!;
              const accent = backing.find((row) => row.cells.some((cell) => cell.text === "é"))!;
              expect(wide.cells).toHaveLength(1);
              expect(accent.cells[0]?.padding).toBe(true);
              expect(accent.cells[1]?.text).toBe("é");
            }
            tmux("send-keys", "-t", session, "-X", "history-top");
            tmux("send-keys", "-t", session, "-X", "start-of-line");
            let row = 0;
            let column = 0;
            for (let step = 0; step < 22; step++) {
              const [x, y, scroll] = tmux(
                "display-message",
                "-p",
                "-t",
                session,
                "#{copy_cursor_x}:#{copy_cursor_y}:#{scroll_position}",
              )
                .split(":")
                .map(Number);
              expect({ column, row }, `native cursor at ${cols} columns, step ${step}`).toEqual({
                column: x,
                row: backing.length - 8 - scroll! + y!,
              });
              const cells = backing[row]!.cells;
              let end = cells.length;
              while (end > 0 && cells[end - 1]!.text === " " && !cells[end - 1]!.padding) end--;
              if (column >= end && row < backing.length - 1) {
                row++;
                column = 0;
              } else if (column < end) {
                column++;
                while (column < end && cells[column]?.padding) column++;
              }
              tmux("send-keys", "-t", session, "-X", "cursor-right");
            }
          }
        } finally {
          tmux("kill-session", "-t", session);
        }
      },
    );
  },
);

describe.skipIf(!available)("native frozen copy-view resize", () => {
  it.skipIf(!nativeCapabilities.frozenCopy).each([3, 30])(
    "shares rows through native height changes with %s initial lines",
    async (lineCount) => {
      const session = `frozen-height-sharing-${lineCount}`;
      const script = join(directory, `${session}.mjs`);
      const initial =
        Array.from({ length: lineCount }, (_, i) => `HEIGHT-${i} 界é\r\n`).join("") + "READY";
      writeFileSync(
        script,
        `process.stdout.write(${JSON.stringify(initial)});setInterval(()=>{},10000);`,
      );
      tmux(
        "new-session",
        "-d",
        "-s",
        session,
        "-x",
        "40",
        "-y",
        "8",
        `${process.execPath} ${script}`,
      );
      tmux("set-option", "-t", session, "status", "off");
      const mirror = new MirrorService({ socketName: socket, configFile: "/dev/null" });
      let owner: SessionRuntimeTerminalReplicaOwner | undefined;
      try {
        await vi.waitFor(() =>
          expect(tmux("capture-pane", "-p", "-t", session)).toContain("READY"),
        );
        const described = await mirror.describeSession(session);
        owner = new SessionRuntimeTerminalReplicaOwner(
          "00000000-0000-4000-8000-000000000001",
          session,
          described.panes[0]!.semanticPaneId,
          mirror,
          { incarnation: "height:0", initialRevision: 0 },
        );
        let captured: TerminalReplicaSnapshot | undefined;
        await owner.subscribe((update) => {
          if (update.type === "terminal.seed") captured = update.snapshot;
        });
        let retained = captured!;
        tmux("copy-mode", "-t", session);
        for (const rows of [12, 5, 120, 8]) {
          const previousRows = [...retained.history, ...retained.grid];
          tmux("resize-window", "-t", session, "-y", String(rows));
          retained = reflowRetainedTerminalSnapshot(retained, 40, rows)!;
          expect(retained).not.toBeNull();
          const all = [...retained.history, ...retained.grid];
          for (let index = 0; index < previousRows.length; index++)
            expect(all[index]).toBe(previousRows[index]);
          const numbered = all
            .map(
              (row, index) =>
                `${index - retained.history.length} ${row.cells
                  .filter((cell) => cell.width !== 0)
                  .map((cell) => cell.grapheme || " ")
                  .join("")
                  .trimEnd()}`,
            )
            .join("\n")
            .trimEnd();
          expect(numbered, `native backing at height ${rows}`).toBe(
            tmux("capture-pane", "-p", "-M", "-L", "-S", "-", "-t", session),
          );
        }
      } finally {
        await owner?.dispose();
        await mirror.dispose();
        tmux("kill-session", "-t", session);
      }
    },
  );

  it.each([3, 30])(
    "matches native backing and keeps a reader anchored with %s initial lines",
    async (lineCount) => {
      const session = `frozen-copy-reflow-${lineCount}`;
      const script = join(directory, `${session}.mjs`);
      const initial =
        Array.from({ length: lineCount }, (_, i) => `COPY-${i}  界é\r\n`).join("") + "READY";
      writeFileSync(
        script,
        `process.stdout.write(${JSON.stringify(initial)});process.on('SIGWINCH',()=>process.stdout.write('LIVE-AFTER-RESIZE'));setInterval(()=>{},10000);`,
      );
      tmux(
        "new-session",
        "-d",
        "-s",
        session,
        "-x",
        "40",
        "-y",
        "8",
        `${process.execPath} ${script}`,
      );
      tmux("set-option", "-t", session, "status", "off");
      await vi.waitFor(() => expect(tmux("capture-pane", "-p", "-t", session)).toContain("READY"));
      const mirror = new MirrorService({
        createIo: (name, handlers) =>
          new MirrorControlChannel({
            session: name,
            handlers,
            socketName: socket,
            configFile: "/dev/null",
          }),
      });
      let owner: SessionRuntimeTerminalReplicaOwner | undefined;
      let disposeClient = () => {};
      try {
        const described = await mirror.describeSession(session);
        owner = new SessionRuntimeTerminalReplicaOwner(
          "00000000-0000-4000-8000-000000000001",
          session,
          described.panes[0]!.semanticPaneId,
          mirror,
          { incarnation: "frozen:0", initialRevision: 0 },
        );
        const paneId = described.panes[0]!.semanticPaneId;
        let deliver: ((update: CanonicalTerminalReplicaUpdate) => void) | undefined;
        const lane = createTerminalFastLane({
          address: { workspaceName: session, generation: "00000000-0000-4000-8000-000000000001" },
          source: {
            subscribe: (_address, listener) => {
              deliver = listener;
              return () => {
                deliver = undefined;
              };
            },
          },
          repair: {
            request: () => {
              throw new Error("unexpected frozen-view replica repair");
            },
          },
          control: {
            owns: () => true,
            request: async () => true,
            write: async () => "ok",
            resize: async () => "ok",
          },
        });
        const adapter = new TerminalFastLaneRendererAdapter(
          lane,
          1,
          null,
          null,
          async (_pane, expected) => {
            const result = await owner!.captureNativeBacking();
            return result.status === "captured" &&
              result.authority.revision === expected.revision &&
              result.authority.stateHash === expected.stateHash
              ? result.snapshot
              : null;
          },
        );
        const unsubscribe = adapter.subscribePaneVersion(paneId, () => {});
        const reader = createTerminalScrollback(adapter);
        disposeClient = () => {
          reader.dispose();
          unsubscribe();
          adapter.dispose();
          lane.dispose();
        };
        let captured: TerminalReplicaSnapshot | undefined;
        await owner.subscribe((update) => {
          if (update.type === "terminal.seed") captured = update.snapshot;
          deliver?.(update);
        });
        const backing = await owner.captureNativeBacking();
        if (backing.status === "unsupported") {
          expect(process.env.TMUX_IDE_REQUIRE_NATIVE_CAPABILITIES).not.toBe("1");
          // Existing stock tmux retains compatibility mode; exact hidden-cell
          // qualification is exercised with the bundled tmux on PATH.
          const release = adapter.retainPaneView(paneId)!;
          await vi.waitFor(() =>
            expect(adapter.paneRetainedBackingStatus(paneId)).toBe("compatible"),
          );
          release();
          return;
        }
        expect(backing.status).toBe("captured");
        if (backing.status !== "captured")
          throw new Error(`Backing unavailable: ${backing.status}`);
        expect(retainNativeTerminalBacking(captured!, backing.snapshot)).toBe(true);
        let retained = captured!;
        if (lineCount === 3) expect(retained.history).toHaveLength(0);
        const returnLive = adapter.retainPaneView(paneId)!;
        expect(returnLive).toBeTypeOf("function");
        await vi.waitFor(() => expect(adapter.paneRetainedBackingStatus(paneId)).toBe("native"));
        reader.move(paneId, 0);
        const readingLineId = () => {
          const source = adapter.paneSelectionSnapshot(paneId)!;
          const origin = reader.origin(paneId);
          expect(origin).not.toBeNull();
          const rows = [...source.history, ...source.grid];
          let index = source.history.length + origin!.y;
          let text = "";
          do {
            text += projectTerminalTextRow(rows[index]!).text;
            index++;
          } while (rows[index]?.wrapped);
          // Match the unique record at the reading origin. Full native text is
          // compared separately below: physical-row extraction trims trailing
          // spaces, including a wrapped row that is only one space wide.
          return text.match(/^COPY-\d+/)?.[0] ?? text.trimEnd();
        };
        const heldLine = readingLineId();
        expect(heldLine).toMatch(/^COPY-/);
        const text = () =>
          [...retained.history, ...retained.grid]
            .map((row) => projectTerminalTextRow(row).text)
            .join("\n")
            .trimEnd();
        const numbered = () =>
          [...retained.history, ...retained.grid]
            .map(
              (row, index) =>
                `${index - retained.history.length} ${projectTerminalTextRow(row).text}`,
            )
            .join("\n")
            .trimEnd();
        tmux("copy-mode", "-t", session);
        expect(text()).toBe(tmux("capture-pane", "-p", "-M", "-S", "-", "-t", session));
        for (const [cols, rows] of [
          [8, 8],
          [3, 8],
          [2, 8],
          [5, 8],
          [40, 8],
          [1, 8],
          [40, 8],
          [40, 12],
          [40, 5],
          [40, 120],
          [40, 8],
        ]) {
          tmux("resize-window", "-t", session, "-x", String(cols), "-y", String(rows));
          const beforeResize = retained;
          const next = reflowRetainedTerminalSnapshot(retained, cols!, rows!);
          expect(next).not.toBeNull();
          retained = next!;
          if (beforeResize.cols === cols) {
            const previousRows = [...beforeResize.history, ...beforeResize.grid];
            const nextRows = [...retained.history, ...retained.grid];
            for (let index = 0; index < Math.min(previousRows.length, nextRows.length); index++)
              expect(nextRows[index]).toBe(previousRows[index]);
          }
          expect(text(), `${cols}x${rows}`).toBe(
            tmux("capture-pane", "-p", "-M", "-S", "-", "-t", session),
          );
          expect(numbered(), `${cols}x${rows} numbered`).toBe(
            tmux("capture-pane", "-p", "-M", "-L", "-S", "-", "-t", session),
          );
          expect(text()).not.toContain("LIVE-AFTER-RESIZE");
          await vi.waitFor(() => {
            expect(adapter.paneSelectionSnapshot(paneId)).toEqual(retained);
            expect(readingLineId()).toBe(heldLine);
          });
        }
        expect(tmux("display-message", "-p", "-t", session, "#{pane_in_mode}")).toBe("1");
        await vi.waitFor(() =>
          expect(tmux("capture-pane", "-p", "-J", "-S", "-", "-t", session)).toContain(
            "LIVE-AFTER-RESIZE",
          ),
        );
        returnLive();
        reader.live(paneId);
        expect(reader.origin(paneId)).toBeNull();
        expect(adapter.paneSelectionSnapshot(paneId)).toBe(lane.paneState(paneId)!.snapshot);
      } finally {
        disposeClient();
        await owner?.dispose();
        await mirror.dispose();
      }
    },
    10000,
  );
});
