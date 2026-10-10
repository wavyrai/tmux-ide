// Diagnostic fixture only: transparent browser transport, never a release entry point.
import process from "node:process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { openSync, writeSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import { setTimeout, clearTimeout } from "node:timers";
import { stopFixtureChild } from "./fixture-child.mjs";

const LIMIT = 8 * 1024 * 1024;
const identity = (value) =>
  typeof value === "string" ? createHash("sha256").update(value).digest("hex").slice(0, 24) : null;
const integer = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
export function traceMetadata(direction, value) {
  if (direction === "command") {
    const type = ["presence", "session", "pane", "home", "refresh"].includes(value.type)
      ? value.type
      : "other";
    return {
      direction,
      type,
      request: integer(value.request),
      ...(type === "presence"
        ? { active: value.active === true, revision: integer(value.revision) }
        : {}),
      ...(["session", "pane"].includes(type) ? { id: identity(value.id) } : {}),
    };
  }
  return {
    direction,
    sequence: integer(value.sequence),
    request: integer(value.request),
    surface: ["home", "workspace"].includes(value.surface) ? value.surface : "unknown",
    catalogComplete: value.sessionCatalogComplete === true,
    preferred: identity(value.preferredPane),
    session: identity(value.selectedSession),
    pane: identity(value.selectedPane),
    preferredMember:
      Array.isArray(value.panes) &&
      value.panes.some((p) => p.id === value.preferredPane && typeof p.windowId === "string"),
    paneCount: Array.isArray(value.panes) ? value.panes.length : null,
    frame: value.snapshot != null,
    inputReady: value.inputReady === true,
    presenceRevision: integer(value.presenceRevision),
  };
}

export async function runBrowserTraceFixture({
  executable,
  args,
  tracePath,
  input = process.stdin,
  output = process.stdout,
  signal,
}) {
  const fd = openSync(tracePath, "wx", 0o600);
  let bytes = 0,
    ordinal = 0,
    failure = false,
    stopping = false,
    deadline;
  const child = spawn(executable, args, { stdio: ["pipe", "pipe", "inherit"] });
  const closed = new Promise((resolve) =>
    child.once("close", (code, sig) => resolve({ code, sig })),
  );
  let retirement;
  let retirementFinished;
  const retired = new Promise((resolve) => {
    retirementFinished = resolve;
  });
  const stop = () => {
    stopping = true;
    retirement ??= stopFixtureChild(child)
      .catch(() => {
        failure = true;
      })
      .finally(() => {
        publications.destroy();
        retirementFinished({ code: null });
      });
  };
  const fail = () => {
    failure = true;
    stop();
  };
  const tap = (direction) => {
    let pending = Buffer.alloc(0);
    return new Transform({
      transform(chunk, _encoding, done) {
        try {
          pending = Buffer.concat([pending, chunk]);
          let end;
          while ((end = pending.indexOf(10)) >= 0) {
            if (end > LIMIT) throw new Error("Trace line limit");
            const value = JSON.parse(pending.subarray(0, end).toString("utf8"));
            if (!value || typeof value !== "object" || Array.isArray(value))
              throw new Error("Trace object required");
            pending = pending.subarray(end + 1);
            const record = Buffer.from(
              JSON.stringify({ ordinal: ++ordinal, ...traceMetadata(direction, value) }) + "\n",
            );
            bytes += record.length;
            if (bytes > 1024 * 1024) throw new Error("Trace capacity");
            writeSync(fd, record);
          }
          if (pending.length > LIMIT) throw new Error("Trace line limit");
          done(null, chunk);
        } catch {
          done(new Error("Fixture trace rejected transport"));
        }
      },
      flush(done) {
        done(pending.length ? new Error("Fixture trace incomplete line") : undefined);
      },
    });
  };
  const commands = tap("command"),
    publications = tap("publication");
  for (const stream of [commands, publications, child.stdin, child.stdout])
    stream.on("error", fail);
  child.once("error", fail);
  input.on("error", fail);
  output.on("error", fail);
  const eof = () => {
    deadline = setTimeout(() => {
      failure = true;
      stop();
    }, 3000);
  };
  input.once("end", eof);
  signal?.addEventListener("abort", stop, { once: true });
  input.pipe(commands).pipe(child.stdin);
  child.stdout.pipe(publications).pipe(output, { end: false });
  const drained = new Promise((resolve) => {
    publications.once("end", resolve);
    publications.once("error", resolve);
    publications.once("close", resolve);
  });
  if (signal?.aborted) stop();
  try {
    const result = await Promise.race([closed, retired]);
    await retirement;
    const drainDeadline = setTimeout(() => {
      failure = true;
      publications.destroy();
    }, 2000);
    try {
      await drained;
    } finally {
      clearTimeout(drainDeadline);
    }
    return failure ? 1 : (result.code ?? (stopping ? 0 : 1));
  } finally {
    clearTimeout(deadline);
    input.unpipe(commands);
    child.stdout.unpipe(publications);
    input.off("end", eof);
    input.off("error", fail);
    output.off("error", fail);
    signal?.removeEventListener("abort", stop);
    commands.destroy();
    publications.destroy();
    closeSync(fd);
  }
}
