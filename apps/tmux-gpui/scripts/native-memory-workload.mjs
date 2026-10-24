// Bounded synthetic Kitty workload. No shell input or desktop automation.
import { once } from "node:events";
import { readFile, appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
export const LIMITS = Object.freeze({
  images: 12,
  variants: 3,
  width: 64,
  height: 64,
  chunk: 4096,
  historyLinesPerTick: 4,
});
const HD_LIMITS = Object.freeze({
  ...LIMITS,
  images: 3,
  variants: 2,
  width: 1920,
  height: 1080,
});
export function limitsFor(profile = "small") {
  if (profile === "small") return LIMITS;
  if (profile === "hd") return HD_LIMITS;
  throw Error("Unknown bounded image profile");
}
export const PHASES = Object.freeze([
  { name: "baseline", seconds: 20 },
  { name: "images-and-history", seconds: 60 },
  { name: "reuse", seconds: 20 },
  { name: "delete", seconds: 1 },
  { name: "idle", seconds: 90 },
]);
const apc = (body) => `\x1b_G${body}\x1b\\`;
export function phaseAt(second, phases = PHASES) {
  let start = 0;
  for (const phase of phases) {
    if (second < start + phase.seconds) return { name: phase.name, tick: second - start };
    start += phase.seconds;
  }
  return { name: "complete", tick: 0 };
}
export function imageBytes(id, variant, profile = "small") {
  const limits = limitsFor(profile);
  if (
    !Number.isInteger(id) ||
    id < 1 ||
    id > limits.images ||
    !Number.isInteger(variant) ||
    variant < 0 ||
    variant >= limits.variants
  )
    throw Error("Unbounded image identity");
  const bytes = Buffer.alloc(limits.width * limits.height * 4);
  for (let n = 0; n < bytes.length; n += 4) {
    bytes[n] = (id * 19 + variant * 67) % 256;
    bytes[n + 1] = (n / 4 + id * 7) % 256;
    bytes[n + 2] = (variant * 101 + 40) % 256;
    bytes[n + 3] = 255;
  }
  return bytes;
}
export function imageCommands(id, variant, profile = "small") {
  const limits = limitsFor(profile);
  const data = imageBytes(id, variant, profile).toString("base64"),
    parts = [];
  for (let i = 0; i < data.length; i += limits.chunk)
    parts.push(
      apc(
        `${i === 0 ? `a=T,f=32,s=${limits.width},v=${limits.height},i=${id},p=1,c=8,r=4,q=2,` : ""}m=${i + limits.chunk < data.length ? 1 : 0};${data.slice(i, i + limits.chunk)}`,
      ),
    );
  return parts;
}
export function workloadTick(phase, tick, profile = "small") {
  const limits = limitsFor(profile);
  if (!Number.isInteger(tick) || tick < 0 || tick > 600) throw Error("Unbounded tick");
  if (phase === "images-and-history") {
    const id = (tick % limits.images) + 1,
      variant = Math.floor(tick / limits.images) % limits.variants;
    return {
      image: { id, variant, bytes: limits.width * limits.height * 4 },
      chunks: [
        "\x1b[H",
        ...imageCommands(id, variant, profile),
        "\x1b[8;1H",
        apc(`a=p,i=${id},p=2,c=8,r=4,q=2`),
        "\x1b[999;1H",
        ...Array.from(
          { length: limits.historyLinesPerTick },
          (_, n) => `MEMORY HISTORY ${tick}:${n}\r\n`,
        ),
      ],
    };
  }
  if (phase === "reuse") {
    const id = (tick % limits.images) + 1;
    return { image: null, chunks: ["\x1b[H", apc(`a=p,i=${id},p=1,c=8,r=4,q=2`)] };
  }
  if (phase === "delete" && tick === 0)
    return {
      image: null,
      chunks: Array.from({ length: limits.images }, (_, i) => apc(`a=d,d=I,i=${i + 1},q=2`)),
    };
  return { image: null, chunks: [] };
}
async function main() {
  if (process.env.TMUX_IDE_MEMORY_FIXTURE !== "1" || !process.stdout.isTTY)
    throw Error("Explicit owned TTY fixture required");
  const [armPath, logPath, smoke, profile = "small"] = process.argv.slice(2);
  limitsFor(profile);
  if (!armPath?.startsWith("/") || !logPath?.startsWith("/"))
    throw Error("Absolute fixture paths required");
  const phases = smoke === "smoke" ? PHASES.map((p) => ({ ...p, seconds: 1 })) : PHASES;
  process.stdout.write("MEMORY FIXTURE READY — select this pane, then arm the runner\r\n");
  let armed = false;
  for (let n = 0; n < 180 && !armed; n++) {
    try {
      armed = JSON.parse(await readFile(armPath, "utf8")).armed === true;
    } catch {}
    if (!armed) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!armed) throw Error("Fixture was not armed within 180 seconds");
  const started = performance.now();
  let previous = null;
  for (let second = 0; ; second++) {
    const phase = phaseAt(second, phases);
    if (phase.name !== previous) {
      previous = phase.name;
      await appendFile(
        logPath,
        JSON.stringify({
          type: "phase",
          phase: phase.name,
          time: Date.now(),
          elapsedMs: performance.now() - started,
        }) + "\n",
      );
    }
    if (phase.name === "complete") break;
    const op = workloadTick(phase.name, phase.tick, profile);
    for (const chunk of op.chunks)
      if (!process.stdout.write(chunk)) await once(process.stdout, "drain");
    await appendFile(
      logPath,
      JSON.stringify({
        type: "written",
        phase: phase.name,
        tick: phase.tick,
        time: Date.now(),
        image: op.image,
        encodedBytes: op.chunks.reduce((n, s) => n + Buffer.byteLength(s), 0),
      }) + "\n",
    );
    await new Promise((r) =>
      setTimeout(r, Math.max(0, started + (second + 1) * 1000 - performance.now())),
    );
  }
  process.stdout.write("\r\nMEMORY WORKLOAD COMPLETE\r\n");
  // Keep the exact pane lifetime alive until the owning fleet is disposed.
  setInterval(() => {}, 1000);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
