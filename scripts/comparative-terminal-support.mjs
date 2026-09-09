import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(new URL("../packages/daemon/package.json", import.meta.url));
export const REPORT_VERSION = 2;
export const nowMs = () => Number(process.hrtime.bigint()) / 1e6;
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
export function artifact(path) {
  if (!isAbsolute(path)) throw new Error(`An explicit absolute binary path is required: ${path}`);
  const resolved = realpathSync(path);
  if (!statSync(resolved).isFile()) throw new Error(`Not a file: ${path}`);
  return {
    path,
    resolved,
    bytes: statSync(resolved).size,
    sha256: createHash("sha256").update(readFileSync(resolved)).digest("hex"),
  };
}
export function isolatedEnv(base, root) {
  const env = Object.fromEntries(
    Object.entries(base).filter(([key]) => !/^(?:TMUX(?:_|$)|TMUX_IDE_|HERDR_|XDG_)/u.test(key)),
  );
  return {
    ...env,
    HOME: root,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_RUNTIME_DIR: `${root}/run`,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    SHELL: "/bin/sh",
  };
}
export function canonicalMarker(lines) {
  const markers = lines.flatMap((line) => {
    const match = /CBENCH:(\d{6}):(\d+)x(\d+):END/u.exec(line);
    return match
      ? [{ sequence: Number(match[1]), cols: Number(match[2]), rows: Number(match[3]) }]
      : [];
  });
  return markers.length === 1 ? markers[0] : null;
}
export function createScreen(cols, rows, reply, observe) {
  const { Terminal } = require("@xterm/headless-stock");
  const terminal = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
  terminal.onData(reply);
  let pending = Promise.resolve();
  return {
    write(data) {
      pending = pending.then(
        () =>
          new Promise((resolve) =>
            terminal.write(data, () => {
              const lines = Array.from(
                { length: terminal.rows },
                (_, index) => terminal.buffer.active.getLine(index)?.translateToString(true) ?? "",
              );
              observe(canonicalMarker(lines), nowMs());
              resolve();
            }),
          ),
      );
      return pending;
    },
    resize(width, height) {
      terminal.resize(width, height);
    },
    drain() {
      return pending;
    },
    dispose() {
      terminal.dispose();
    },
  };
}
export function validateOptions(options) {
  tuiRendererConfiguration(options.tuiRenderer);
  if (options.inputMode !== undefined && !["key", "line"].includes(options.inputMode))
    throw new Error("Invalid inputMode: expected key or line");
  if (
    !Array.isArray(options.targets) ||
    !options.targets.length ||
    options.targets.some((target) => !["tmux", "tmux-ide", "herdr"].includes(target))
  )
    throw new Error("targets must name tmux, tmux-ide, or herdr");
  for (const [key, min, max] of [
    ["cols", 40, 240],
    ["rows", 10, 100],
    ["samples", 1, 500],
    ["rounds", 1, 20],
  ]) {
    if (!Number.isSafeInteger(options[key]) || options[key] < min || options[key] > max)
      throw new Error(`Invalid ${key}`);
  }
  if (
    options.resizeSamples !== undefined &&
    (!Number.isSafeInteger(options.resizeSamples) ||
      options.resizeSamples < 0 ||
      options.resizeSamples > 100)
  )
    throw new Error("Invalid resizeSamples");
  if (options.resources !== undefined && typeof options.resources !== "boolean")
    throw new Error("Invalid resources");
  const needed = new Set(
    options.targets.flatMap((target) =>
      target === "tmux-ide" ? ["tmux", "cli", "tui"] : [target],
    ),
  );
  return Object.fromEntries(
    [...needed].map((key) => [key, artifact(options.binaries?.[key] ?? "")]),
  );
}

/** Requested mode is separate from artifact provenance and detected host capabilities. */
export function tuiRendererConfiguration(mode = "release-default") {
  if (mode === "release-default") return { mode, environment: {} };
  if (!["standard", "framed", "scroll-preview"].includes(mode))
    throw new Error(
      "Invalid tuiRenderer: expected release-default, standard, framed, or scroll-preview",
    );
  return {
    mode,
    environment: {
      TMUX_IDE_FRAME_OUTPUT: mode === "standard" ? "0" : "1",
      TMUX_IDE_NATIVE_SCROLL_PROTOTYPE: mode === "scroll-preview" ? "1" : "0",
    },
  };
}

/** Uses the owning child/PTY handle, never a PID discovered from unrelated processes. */
export async function retireOwnedProcess(owner, waitForExit) {
  if (owner.exited()) return "already-exited";
  owner.signal("SIGTERM");
  if (await waitForExit()) return "terminated";
  if (!owner.exited()) owner.signal("SIGKILL");
  if (!(await waitForExit())) throw new Error("Owned process did not exit after SIGKILL");
  return "killed";
}

/** Command is permanently scoped to the newly-created private socket by the caller. */
export async function retirePrivateTmux(command, expectedPid, session) {
  if (!expectedPid) await command("has-session", "-t", `=${session}`);
  const readPid = async () => {
    const pid = Number((await command("display-message", "-p", "#{pid}")).trim());
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error("No private tmux PID; cleanup refused");
    return pid;
  };
  const observed = await readPid();
  const ownedPid = expectedPid || observed;
  if (observed !== ownedPid || (await readPid()) !== ownedPid)
    throw new Error("Private tmux PID changed; cleanup refused");
  await command("kill-server");
  return { pid: ownedPid, recoveredIdentity: !expectedPid };
}

/** Rotate and reverse whole rounds so the same product is not always in the middle. */
export function comparativeTargetOrder(targets, round) {
  const offset = round % targets.length;
  const order = [...targets.slice(offset), ...targets.slice(0, offset)];
  return Math.floor(round / targets.length) % 2 ? order.reverse() : order;
}
