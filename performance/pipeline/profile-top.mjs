// Summarise a .cpuprofile: self time by function and by inclusive "bucket".
import { readFileSync } from "node:fs";
const profile = JSON.parse(readFileSync(process.argv[2], "utf8"));
const limit = Number(process.argv[3] ?? 25);
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const dt = profile.timeDeltas;
const self = new Map();
const total = new Map();
let all = 0;
profile.samples.forEach((id, i) => {
  const ms = (dt[i + 1] ?? dt[i] ?? 0) / 1000;
  all += ms;
  const n = byId.get(id);
  const key = (f) => `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${f.lineNumber + 1}`;
  self.set(key(n.callFrame), (self.get(key(n.callFrame)) ?? 0) + ms);
  const seen = new Set();
  for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
    const k = key(byId.get(cur).callFrame);
    if (seen.has(k)) continue;
    seen.add(k);
    total.set(k, (total.get(k) ?? 0) + ms);
  }
});
const top = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k, v]) => `${v.toFixed(0).padStart(7)} ms ${(100 * v / all).toFixed(1).padStart(5)}%  ${k}`).join("\n");
console.log(`total sampled ${all.toFixed(0)} ms\n-- self --\n${top(self)}\n-- inclusive --\n${top(total)}`);
