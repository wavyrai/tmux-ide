import { describe, expect, it } from "vitest";
import { TerminalReplicaRowSchemaZ } from "@tmux-ide/contracts";
import {
  createProjectedTerminalReplicaRowBuilder,
  createOwnedTerminalReplicaRowBuilder,
  freezeOwnedTerminalReplicaRow,
  isSchemaValidProjectedTerminalReplicaRow,
} from "./terminal-replica-owned-row.ts";

type Scalars = Parameters<ReturnType<typeof createProjectedTerminalReplicaRowBuilder>["append"]>;
const ordinary: Scalars = ["X", 1, 0, "default", 0, "default", 0];
function row(values: Scalars[], wrapped = false) {
  const builder = createProjectedTerminalReplicaRowBuilder();
  for (const value of values) builder.append(...value);
  return builder.finish(wrapped);
}

describe("projected row validity follows the public strict schema", () => {
  it("agrees on scalar boundaries, default unused values and mixed invalid rows", () => {
    const cases: Scalars[] = [ordinary];
    for (const width of [-0, 0, 1, 2, 3, -1, 0.5, NaN, Infinity])
      cases.push(["X", width as 1, 0, "default", 0, "default", 0]);
    for (const attributes of [-1, -0, 0, 255, 256, 0.5, NaN, Infinity])
      cases.push(["X", 1, attributes, "default", 0, "default", 0]);
    for (const grapheme of ["", " ", "é", "界", "\ud800", "X".repeat(4097)])
      cases.push([grapheme, 1, 0, "default", 0, "default", 0]);
    for (const kind of ["default", "indexed", "rgb"] as const) {
      for (const value of [-1, -0, 0, 255, 256, 0xffffff, 0x1000000, 0.5, NaN, Infinity]) {
        cases.push(["X", 1, 0, kind, value, "default", 0]);
        cases.push(["X", 1, 0, "default", 0, kind, value]);
      }
    }
    for (const values of cases) {
      for (const wrapped of [false, true]) {
        for (const cells of [[values], [ordinary, values, ordinary]]) {
          const projected = row(cells, wrapped);
          expect(isSchemaValidProjectedTerminalReplicaRow(projected)).toBe(
            TerminalReplicaRowSchemaZ.safeParse(projected).success,
          );
        }
      }
    }
    expect(isSchemaValidProjectedTerminalReplicaRow(row([]))).toBe(true);
  });

  it("does not confer schema validity through ordinary immutable copying", () => {
    const projected = row([ordinary]);
    const foreign = structuredClone(projected);
    expect(isSchemaValidProjectedTerminalReplicaRow(foreign)).toBe(false);
    expect(isSchemaValidProjectedTerminalReplicaRow(freezeOwnedTerminalReplicaRow(foreign))).toBe(
      false,
    );
    const builder = createOwnedTerminalReplicaRowBuilder();
    builder.append(projected.cells[0]!);
    expect(isSchemaValidProjectedTerminalReplicaRow(builder.finish(foreign, false))).toBe(false);
    expect(freezeOwnedTerminalReplicaRow(projected)).toBe(projected);
    expect(isSchemaValidProjectedTerminalReplicaRow(projected)).toBe(true);
  });
});
