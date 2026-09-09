import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyTerminalReplicaPatch,
  blankTerminalReplicaSnapshot,
  hashTerminalReplicaSnapshot,
} from "./terminal-replica.ts";
import {
  decodeVerifiedCompactSemanticTerminalUpdateCooperatively as decode,
  encodeCompactSemanticTerminalUpdate,
} from "./terminal-delivery.ts";

const yieldControl = async () => {};

async function decodedBlank() {
  const input = blankTerminalReplicaSnapshot(8, 2);
  return (
    await decode(
      encodeCompactSemanticTerminalUpdate({ frame: "seed", revision: 0, snapshot: input }),
      null,
      hashTerminalReplicaSnapshot(input),
      { yieldControl },
    )
  ).canonicalSnapshot!;
}

describe("compact baseline index lifetime", () => {
  it("reuses a row that entered the current baseline after the first index was built", async () => {
    let baseline = await decodedBlank();
    for (let revision = 1; revision <= 3; revision += 1) {
      const row = structuredClone(baseline.grid[0]!);
      row.cells[0]!.grapheme = "X";
      const patch = { rows: [{ index: 1, row }], cursor: { ...baseline.cursor, x: revision } };
      const expected = applyTerminalReplicaPatch(baseline, patch);
      let counts: { allocatedCells: number; reusedRows: number } | undefined;
      const result = await decode(
        encodeCompactSemanticTerminalUpdate({
          frame: "patch",
          baseRevision: revision - 1,
          revision,
          patch,
        }),
        baseline,
        hashTerminalReplicaSnapshot(expected),
        {
          yieldControl,
          onComplete: (profile) => {
            counts = profile;
          },
        },
      );
      expect(result.canonicalSnapshot).toEqual(expected);
      expect(counts).toMatchObject(
        revision === 1
          ? { allocatedCells: 8, reusedRows: 0 }
          : { allocatedCells: 0, reusedRows: 1 },
      );
      if (revision > 1) expect(result.canonicalSnapshot!.grid[1]).toBe(baseline.grid[1]);
      baseline = result.canonicalSnapshot!;
    }
  });

  it("checks history when a same-hash grid candidate has different bytes", async () => {
    const blank = blankTerminalReplicaSnapshot(1, 1);
    const row = (grapheme: string) => ({
      wrapped: false,
      cells: [{ ...blank.grid[0]!.cells[0]!, grapheme }],
    });
    // These encoded rows collide in the raw FNV32 cache, but differ canonically.
    const input = { ...blank, grid: [row("dkzbb9")], history: [row("1mu5745")] };
    const baseline = (
      await decode(
        encodeCompactSemanticTerminalUpdate({ frame: "seed", revision: 0, snapshot: input }),
        null,
        hashTerminalReplicaSnapshot(input),
        { yieldControl },
      )
    ).canonicalSnapshot!;
    const patch = { rows: [{ index: 0, row: baseline.history[0]! }] };
    const expected = applyTerminalReplicaPatch(baseline, patch);
    let counts: { allocatedCells: number; reusedRows: number } | undefined;
    const result = await decode(
      encodeCompactSemanticTerminalUpdate({ frame: "patch", baseRevision: 0, revision: 1, patch }),
      baseline,
      hashTerminalReplicaSnapshot(expected),
      {
        yieldControl,
        onComplete: (profile) => {
          counts = profile;
        },
      },
    );
    expect(result.canonicalSnapshot).toEqual(expected);
    expect(result.canonicalSnapshot!.grid[0]).toBe(baseline.history[0]);
    expect(counts).toMatchObject({ allocatedCells: 0, reusedRows: 1 });
  });

  // An isolated Node process provides explicit GC without sharing Vitest's
  // retained assertions, module jobs or heap with the weak-reference probe.
  let directory: string;
  let probe: string;
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "tmux-compact-lifetime-"));
    probe = join(directory, "probe.mjs");
    const replica = fileURLToPath(new URL("./terminal-replica.ts", import.meta.url));
    const delivery = fileURLToPath(new URL("./terminal-delivery.ts", import.meta.url));
    await build({
      stdin: {
        contents: `
import {blankTerminalReplicaSnapshot,hashTerminalReplicaSnapshot,applyTerminalReplicaPatch} from ${JSON.stringify(replica)};
import {encodeCompactSemanticTerminalUpdate,decodeVerifiedCompactSemanticTerminalUpdateCooperatively as decode} from ${JSON.stringify(delivery)};
const yieldControl=async()=>{};
const blank=blankTerminalReplicaSnapshot(8,1);
function row(label){const r=structuredClone(blank.grid[0]);r.cells[0].grapheme=label;return r;}
async function setup(){
 const chain=process.argv[2]==='chain';
 const input={...blank,grid:[row('A')],history:chain?[row('B')]:Array.from({length:2000},(_,i)=>row('old-'+i))};
 let state=(await decode(encodeCompactSemanticTerminalUpdate({frame:'seed',revision:0,snapshot:input}),null,hashTerminalReplicaSnapshot(input),{yieldControl})).canonicalSnapshot;
 const anchor=state.grid[0];const refs=[];let revision=0;
 async function patch(p){const next=applyTerminalReplicaPatch(state,p);state=(await decode(encodeCompactSemanticTerminalUpdate({frame:'patch',baseRevision:revision,revision:++revision,patch:p}),state,hashTerminalReplicaSnapshot(next),{yieldControl})).canonicalSnapshot;}
 if(chain){
  for(let i=0;i<50;i++){
   await patch({rows:[{index:0,row:state.history[0]}],history:[row('next-'+i)]});
   await patch({rows:[],cursor:{...state.cursor,x:0}});
   refs.push(new WeakRef(state.history[0]));
  }
 }else{
  refs.push(new WeakRef(state.history[1000]));
  await patch({rows:[],historyDelta:{trim:2000,append:[]}});
 }
 return {anchor,refs,current:chain?null:state};
}
const result=await setup();
for(let i=0;i<12;i++){await new Promise(r=>setImmediate(r));global.gc();}
console.log(JSON.stringify({anchor:result.anchor.cells[0].grapheme,retained:result.refs.filter(r=>r.deref()).length,history:result.current?.history.length??null}));
`,
        resolveDir: process.cwd(),
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: probe,
    });
  });
  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it.each(["trim", "chain"])(
    "releases obsolete rows after %s while one old row remains alive",
    (mode) => {
      const result = JSON.parse(
        execFileSync(process.execPath, ["--expose-gc", probe, mode], {
          encoding: "utf8",
          timeout: 15_000,
        }),
      );
      expect(result).toEqual({ anchor: "A", retained: 0, history: mode === "trim" ? 0 : null });
    },
  );
});
