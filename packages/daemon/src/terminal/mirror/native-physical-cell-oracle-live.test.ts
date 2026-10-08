import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { expect, it, vi } from "vitest";
import type { TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import { applyTerminalReplicaPatch } from "@tmux-ide/core";
import { SessionRuntimeTerminalReplicaOwner } from "../session-runtime/terminal-replica-owner.ts";
import { MirrorControlChannel } from "./control-channel.ts";
import { MirrorService } from "./mirror-service.ts";
import {
  INITIAL_BYTES,
  TAB_INITIAL_BYTES,
  TAB_EDIT_BYTES,
  knownTabFrame,
  EDIT_BYTES,
  comparePhysicalFrame,
  knownFrame,
  readDeliveredFrame,
  readPhysicalFrame,
} from "./__tests__/native-physical-cell-oracle.ts";

const binary = process.env.TMUX_IDE_BOUNDARY_TEST_BINARY;
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

it.each(["foreground", "background", "attributes", "text", "width"] as const)(
  "independent physical oracle rejects a changed %s field",
  (field) => {
    const truth = knownFrame("initial");
    const wrong = structuredClone(truth);
    const cell = field === "text" ? wrong.cells[2]![7]! : wrong.cells[0]![1]!;
    if (field === "width") cell.width = 1;
    else if (field === "attributes") cell.attributes = [];
    else if (field === "text")
      cell.text = " "; // Erased tail must not become an explicit space.
    else cell[field] = "default";
    expect(() => comparePhysicalFrame(wrong, truth)).toThrow(`.${field} mismatch`);
    expect(() => comparePhysicalFrame(truth, knownFrame("initial"))).not.toThrow();
  },
);

// Authored raw records, not a round trip through the production encoder.
function rawBlankFixture() {
  return {
    header: {
      version: 2,
      cols: 8,
      rows: 4,
      history: 0,
      hscrolled: 0,
      limit: 2000,
      cursor: [0, 0],
      currentAttributes: [0, 8, 8, 8],
    },
    rows: Array.from({ length: 4 }, (_, row) => ({
      row,
      flags: 0,
      used: 0,
      cells: Array.from({ length: 8 }, () => [64, 1, "20", 0, 8, 8, 8, 0, 64]),
    })),
  };
}
it.each([
  "row-flags",
  "string-color",
  "float-width",
  "missing-cell",
  "unknown-attributes",
  "underline-color",
  "link",
  "rendition",
  "cursor",
  "invalid-utf8",
])("raw oracle fails closed on %s", (mutation) => {
  const raw = rawBlankFixture();
  expect(() =>
    readPhysicalFrame([raw.header, ...raw.rows].map((record) => JSON.stringify(record)).join("\n")),
  ).not.toThrow();
  const cell = raw.rows[0]!.cells[0]!;
  if (mutation === "row-flags") Reflect.deleteProperty(raw.rows[0]!, "flags");
  else if (mutation === "string-color") cell[4] = "8";
  else if (mutation === "float-width") cell[1] = 1.5;
  else if (mutation === "missing-cell") {
    raw.rows[0]!.used = 8;
    raw.rows[0]!.cells.pop();
  } else if (mutation === "unknown-attributes") cell[3] = 0x2000;
  else if (mutation === "underline-color") cell[6] = 1;
  else if (mutation === "link") cell[7] = 2;
  else if (mutation === "rendition") raw.header.currentAttributes = [1, 8, 8, 8];
  else if (mutation === "cursor") raw.header.cursor = [9, 0];
  else {
    cell[0] = 0;
    cell[2] = "ff";
  }
  expect(() =>
    readPhysicalFrame([raw.header, ...raw.rows].map((record) => JSON.stringify(record)).join("\n")),
  ).toThrow();
});
it("rejects delivered attribute bits outside the declared oracle vocabulary", () => {
  expect(() =>
    readDeliveredFrame({
      cols: 8,
      rows: 4,
      history: [],
      cursor: { x: 0, y: 0 },
      grid: [
        {
          wrapped: false,
          cells: [
            {
              grapheme: "",
              width: 1,
              attributes: 256,
              foreground: { kind: "default" },
              background: { kind: "default" },
            },
          ],
        },
      ],
    }),
  ).toThrow("delivered attributes");
});

it("accepts only exact fully unallocated default rows", () => {
  const raw = rawBlankFixture();
  raw.rows[2]!.cells = [];
  const serialize = () =>
    [raw.header, ...raw.rows].map((record) => JSON.stringify(record)).join("\n");
  expect(readPhysicalFrame(serialize()).cells[2]).toEqual(knownTabFrame("initial").cells[2]);
  raw.rows[2]!.used = 1;
  expect(() => readPhysicalFrame(serialize())).toThrow("row used");
});
it("normalizes sparse default tails without hiding painted-cell mismatches", () => {
  const raw = rawBlankFixture();
  raw.rows[1]!.used = 1;
  raw.rows[1]!.cells = [
    [0, 1, "43", 0, 8, 8, 8, 0, 0],
    [64, 1, "20", 0, 8, 8, 8, 0, 64],
  ];
  const serialize = () =>
    [raw.header, ...raw.rows].map((record) => JSON.stringify(record)).join("\n");
  expect(readPhysicalFrame(serialize()).cells[1]).toEqual(knownTabFrame("edited").cells[1]);
  raw.rows[1]!.cells[1]![5] = 1;
  expect(() =>
    comparePhysicalFrame(readPhysicalFrame(serialize()), {
      ...knownTabFrame("edited"),
      cells: [
        knownTabFrame("initial").cells[2]!,
        knownTabFrame("edited").cells[1]!,
        knownTabFrame("initial").cells[2]!,
        knownTabFrame("initial").cells[3]!,
      ],
      cursor: [0, 0],
      wrapped: [false, false, false, false],
    }),
  ).toThrow(".background mismatch");
});
it.each(["span", "owner-bytes", "continuation", "continuation-style"])(
  "rejects malformed tab %s",
  (mutation) => {
    const raw = rawBlankFixture();
    raw.rows[0]!.cells[1] = [128, 6, "202020202020", 0, 8, 16777233, 8, 0, 136];
    for (let x = 2; x < 7; x++) raw.rows[0]!.cells[x] = [4, 1, "21", 0, 8, 8, 8, 0, 4];
    const serialize = () =>
      [raw.header, ...raw.rows].map((record) => JSON.stringify(record)).join("\n");
    expect(() => readPhysicalFrame(serialize())).not.toThrow();
    if (mutation === "span") raw.rows[0]!.cells[1]![1] = 7;
    else if (mutation === "owner-bytes") raw.rows[0]!.cells[1]![2] = "09";
    else if (mutation === "continuation") raw.rows[0]!.cells[2]![0] = 0;
    else raw.rows[0]!.cells[2]![5] = 1;
    expect(() => readPhysicalFrame(serialize())).toThrow();
  },
);
it.each(["tab-cell", "pending-cursor"])("detects incorrect %s independently", (field) => {
  const truth = knownTabFrame("initial"),
    wrong = structuredClone(truth);
  if (field === "tab-cell") wrong.cells[0]![3]!.text = " ";
  else wrong.cursor = [7, 0];
  expect(() => comparePhysicalFrame(wrong, truth)).toThrow(
    field === "tab-cell" ? ".text mismatch" : "cursor mismatch",
  );
});

it.skipIf(!binary).each(["cells", "tab-wrap"] as const)(
  "compares %s with independent native cell truth",
  async (scenario) => {
    const initialBytes = scenario === "cells" ? INITIAL_BYTES : TAB_INITIAL_BYTES;
    const editBytes = scenario === "cells" ? EDIT_BYTES : TAB_EDIT_BYTES;
    expect(isAbsolute(binary!)).toBe(true);
    const expectedCapability = process.env.TMUX_IDE_ORACLE_EXPECT_NATIVE;
    expect(["0", "1"]).toContain(expectedCapability);
    const root = mkdtempSync(join(tmpdir(), "tmux-physical-oracle-"));
    const socket = `zz-physical-oracle-${process.pid}-${randomUUID().slice(0, 8)}`;
    const env = { ...process.env, HOME: root, TMUX: "", LC_ALL: "en_US.UTF-8" };
    const commands: Array<{
      args: string[];
      status: number | null;
      stdout: string;
      stderr: string;
    }> = [];
    const runResult = (...args: string[]) => {
      const result = spawnSync(binary!, ["-L", socket, "-f", "/dev/null", ...args], {
        encoding: "utf8",
        timeout: 5000,
        env,
      });
      commands.push({ args, status: result.status, stdout: result.stdout, stderr: result.stderr });
      return result;
    };
    const run = (...args: string[]) => {
      const result = runResult(...args);
      if (result.status !== 0) throw new Error(`tmux ${args.join(" ")}: ${result.stderr}`);
      return result.stdout.trimEnd();
    };
    const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    const trace: Record<string, unknown>[] = [];
    let mirror: MirrorService | undefined;
    let owner: SessionRuntimeTerminalReplicaOwner | undefined;
    let snapshot: TerminalReplicaSnapshot | null = null;
    let failure: string | undefined;
    let serverPid = "";
    let native = false;
    const faults: string[] = [];
    const sources = [
      "native-physical-cell-oracle-live.test.ts",
      "__tests__/native-physical-cell-oracle.ts",
      "native-grid-capture.ts",
      "native-grid-projection.ts",
      "session-channel.ts",
    ].map((name) => ({ name, sha256: digest(readFileSync(new URL(name, import.meta.url))) }));
    const identity = {
      binary,
      sha256: digest(readFileSync(binary!)),
      version: execFileSync(binary!, ["-V"], { encoding: "utf8" }).trim(),
      gitHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      node: process.version,
      sources,
      sourceReceipt: process.env.TMUX_IDE_ORACLE_SOURCE_RECEIPT
        ? JSON.parse(readFileSync(process.env.TMUX_IDE_ORACLE_SOURCE_RECEIPT, "utf8"))
        : null,
    };
    try {
      run("new-session", "-d", "-s", "physical", "-x", "8", "-y", "4", "sleep 60");
      run("set-option", "-t", "physical", "status", "off");
      run("resize-window", "-t", "physical", "-x", "8", "-y", "4");
      serverPid = run("display-message", "-p", "#{pid}");
      const script = join(root, "paint.cjs");
      writeFileSync(
        script,
        `process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write(${JSON.stringify(initialBytes)});process.stdin.on('data',data=>{for(const byte of data)if(byte===120)process.stdout.write(${JSON.stringify(editBytes)});});\n`,
      );
      run("respawn-pane", "-k", "-t", "physical", `${quote(process.execPath)} ${quote(script)}`);
      const nativeText = (stage: "initial" | "edited") =>
        scenario === "tab-wrap"
          ? stage === "initial"
            ? "A\tB"
            : "A\tB\nC"
          : stage === "initial"
            ? "A界é R\nABCDEF\nZ\nREADY"
            : "A界é R\nAB CDEF\nZ\nDONE";
      await vi.waitFor(
        () => expect(run("capture-pane", "-p", "-t", "physical")).toBe(nativeText("initial")),
        { timeout: 4500, interval: 20 },
      );
      const probe = runResult("capture-pane", "-p", "-R", "-S", "-", "-t", "physical");
      native = probe.status === 0;
      expect(native).toBe(expectedCapability === "1");
      if (!native) expect(probe.stderr).toMatch(/unknown flag.*R/u);
      trace.push({
        phase: "capability",
        native,
        physicalGrid: native ? "supported" : "unsupported",
        stockAssertions: "text, cursor, explicitly available modes",
      });
      mirror = new MirrorService({
        executable: binary!,
        socketName: socket,
        configFile: "/dev/null",
        createIo: (session, handlers) =>
          new MirrorControlChannel({
            executable: binary!,
            socketName: socket,
            configFile: "/dev/null",
            session,
            handlers,
          }),
      });
      const described = await mirror.describeSession("physical");
      owner = new SessionRuntimeTerminalReplicaOwner(
        randomUUID(),
        "physical",
        described.panes[0]!.semanticPaneId,
        mirror,
        {
          incarnation: randomUUID(),
          initialRevision: 0,
          onFault: (fault) => faults.push(String(fault)),
        },
      );
      if (identity.sourceReceipt !== null) {
        expect(identity.sourceReceipt.binarySha256 ?? identity.sourceReceipt.files?.tmux).toBe(
          identity.sha256,
        );
      }
      if (!native && scenario === "tab-wrap") {
        let publications = 0;
        await expect(
          owner.subscribe(() => {
            publications++;
          }),
        ).rejects.toThrow("exact snapshot of saved tab cells");
        expect(publications).toBe(0);
        expect(faults).toHaveLength(1);
        trace.push({
          phase: "stock-tab-unavailable",
          published: publications,
          rawText: run("capture-pane", "-p", "-t", "physical"),
          rawPaintedCapture: run("capture-pane", "-p", "-e", "-J", "-t", "physical"),
          limitation:
            "Stock ANSI capture loses stored tab widths, so paint placement cannot be reconstructed",
        });
        return;
      }
      await owner.subscribe((update) => {
        if (update.type === "terminal.seed") snapshot = update.snapshot;
        else if (update.type === "terminal.patch" && snapshot)
          snapshot = applyTerminalReplicaPatch(snapshot, update.patch);
      });
      const assertCheckpoint = async (stage: "initial" | "edited") => {
        // The OSC title is emitted after every fixture byte, including final
        // cursor positioning. Text alone is not a trailing-escape barrier.
        await vi.waitFor(
          () =>
            expect(run("display-message", "-p", "-t", "physical", "#{pane_title}")).toBe(
              `tm04-${stage}`,
            ),
          { timeout: 4500, interval: 20 },
        );
        await vi.waitFor(
          () => expect(run("capture-pane", "-p", "-t", "physical")).toBe(nativeText(stage)),
          { timeout: 4500, interval: 20 },
        );
        const raw = native ? run("capture-pane", "-p", "-R", "-S", "-", "-t", "physical") : null;
        const expected = scenario === "cells" ? knownFrame(stage) : knownTabFrame(stage);
        // Canonical cursor is the visible cell; tmux exports an offscreen
        // end-column cursor for pending wrap. Continuation below verifies it.
        const deliveredExpected =
          scenario === "tab-wrap" && stage === "initial"
            ? { ...expected, cursor: [7, 0] }
            : expected;
        if (raw !== null) comparePhysicalFrame(readPhysicalFrame(raw), expected);
        const metadata = run(
          "display-message",
          "-p",
          "-t",
          "physical",
          "#{cursor_x}|#{cursor_y}|#{alternate_on}|#{cursor_flag}|#{keypad_cursor_flag}|#{keypad_flag}|#{bracket_paste_flag}|#{wrap_flag}",
        ).split("|");
        expect(metadata.slice(0, 6)).toEqual([
          String(expected.cursor[0]),
          String(expected.cursor[1]),
          "0",
          "1",
          "0",
          "0",
        ]);
        expect(metadata[7]).toBe("1");
        const bracketedPaste = metadata[6] === "" ? "unknown" : metadata[6];
        expect(["0", "unknown"]).toContain(bracketedPaste);
        await vi.waitFor(
          () => {
            expect(snapshot).not.toBeNull();
            if (native) comparePhysicalFrame(readDeliveredFrame(snapshot!), deliveredExpected);
            else {
              const text = snapshot!.grid
                .map((row) =>
                  row.cells
                    .map((cell) => (cell.width === 0 ? "" : cell.grapheme || " "))
                    .join("")
                    .trimEnd(),
                )
                .join("\n")
                .trimEnd();
              expect(text).toBe(
                scenario === "tab-wrap"
                  ? stage === "initial"
                    ? "A      B"
                    : "A      B\nC"
                  : nativeText(stage),
              );
              expect(snapshot!.cursor).toMatchObject({
                x: deliveredExpected.cursor[0],
                y: deliveredExpected.cursor[1],
              });
            }
            expect(snapshot!.modes).toMatchObject({
              alternateScreen: false,
              applicationCursor: false,
              applicationKeypad: false,
              wraparound: true,
            });
          },
          { timeout: 2500, interval: 20 },
        );
        trace.push({
          phase: stage,
          raw,
          expected,
          deliveredExpected,
          delivered: readDeliveredFrame(snapshot!),
          metadata: {
            cursor: metadata.slice(0, 2),
            alternate: metadata[2],
            cursorVisible: metadata[3],
            applicationCursor: metadata[4],
            applicationKeypad: metadata[5],
            bracketedPaste,
            wraparound: metadata[7],
          },
        });
      };
      await assertCheckpoint("initial");
      run("send-keys", "-t", "physical", "-l", "x");
      await assertCheckpoint("edited");
      expect(faults).toEqual([]);
    } catch (error) {
      failure = error instanceof Error ? error.stack : String(error);
      throw error;
    } finally {
      const cleanupErrors: string[] = [];
      let ownerDisposed = false,
        mirrorDisposed = false;
      try {
        await owner?.dispose();
        ownerDisposed = true;
      } catch (error) {
        cleanupErrors.push(`owner: ${String(error)}`);
      }
      try {
        await mirror?.dispose();
        mirrorDisposed = true;
      } catch (error) {
        cleanupErrors.push(`mirror: ${String(error)}`);
      }
      runResult("kill-server");
      const absent = runResult("has-session").status;
      const receipt = {
        schema: 1,
        identity,
        serverPid,
        socket,
        root,
        fixture: { scenario, initial: initialBytes, edit: editBytes },
        native,
        trace,
        commands,
        faults,
        failure,
        cleanup: {
          serverAbsent: absent === 1,
          status: absent,
          ownerDisposed,
          mirrorDisposed,
          errors: cleanupErrors,
        },
      };
      writeFileSync(join(root, "receipt.json"), JSON.stringify(receipt, null, 2));
      process.stdout.write(`Physical cell oracle receipt: ${join(root, "receipt.json")}\n`);
      expect(absent).toBe(1);
      expect(cleanupErrors).toEqual([]);
    }
  },
  15000,
);
