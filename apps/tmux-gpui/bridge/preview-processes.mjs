import process from "node:process";
import { setTimeout, clearTimeout } from "node:timers";
import { createPreviewChannel } from "./preview-channel.mjs";
import { spawn } from "node:child_process";

// Own only these two children. In particular, never signal the daemon or tmux.
export async function runPreview({
  helper,
  native,
  signal,
  graceMs = 1500,
  duplex = false,
  direct = duplex && process.platform !== "win32",
}) {
  const children = [];
  const waits = [];
  let stopping = false;
  let failed = false;
  let escalation;
  let channel;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
    escalation = setTimeout(() => {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    }, graceMs);
  };
  const start = (spec, stdio) => {
    const child = spawn(spec.command, spec.args, { stdio, env: spec.env ?? process.env });
    children.push(child);
    waits.push(
      new Promise((resolve) => {
        child.once("error", () => {
          failed = true;
          stop();
        });
        child.once("close", (code) => resolve(code));
      }),
    );
    return child;
  };
  if (signal?.aborted) return 1;
  signal?.addEventListener("abort", stop, { once: true });
  try {
    if (direct && duplex) channel = await createPreviewChannel({ signal });
    if (stopping || signal?.aborted) return 1;
    const viewer = start(
      native,
      channel
        ? [channel.viewer, channel.viewer, "inherit"]
        : ["pipe", duplex ? "pipe" : "inherit", "inherit"],
    );
    // Closing an idle viewer must retire its helper even when no data is flowing.
    viewer.once("exit", stop);
    const source = start(
      helper,
      channel
        ? [channel.helper, channel.helper, "inherit"]
        : [duplex ? "pipe" : "ignore", "pipe", "inherit"],
    );
    if (channel) await channel.close();
    else {
      viewer.stdin.on("error", () => stop());
      source.stdout.pipe(viewer.stdin);
      if (duplex) {
        source.stdin.on("error", () => stop());
        viewer.stdout.pipe(source.stdin);
      }
    }
    const [viewerCode, helperCode] = await Promise.all(waits);
    return failed || signal?.aborted ? 1 : (viewerCode ?? 1) || (helperCode ?? (stopping ? 0 : 1));
  } catch {
    stop();
    await Promise.all(waits);
    return 1;
  } finally {
    await channel?.close();
    clearTimeout(escalation);
    signal?.removeEventListener("abort", stop);
  }
}
