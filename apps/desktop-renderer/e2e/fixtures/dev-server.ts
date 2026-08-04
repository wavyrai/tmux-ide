/**
 * The Vite dev server that serves the renderer to the browser, pointed at the
 * daemon this test started.
 *
 * `TMUX_IDE_DEV_SERVER_PORT` moves the server AND its CSP together; `vite
 * --port` would move only the server and leave a CSP naming 5173, which refuses
 * the page's own HMR socket. The port is reserved from the OS so parallel runs
 * (and a developer's own 5173) cannot collide.
 */
import { createServer } from "node:net";

import { pollUntil, spawnHarnessChild } from "./harness-process.ts";
import { rendererRoot, type RunningDaemon } from "./daemon.ts";

const VITE_READY_TIMEOUT_MS = 60_000;

export interface RunningDevServer {
  /** The app URL with the development-host opt-in already on it. */
  readonly pageUrl: string;
  readonly origin: string;
  readonly output: () => string;
  readonly stop: () => Promise<void>;
}

export function reservePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        fail(new Error("could not reserve an ephemeral port"));
        return;
      }
      const { port } = address;
      server.close(() => done(port));
    });
  });
}

export async function startDevServer(daemon: RunningDaemon): Promise<RunningDevServer> {
  const port = await reservePort();
  const harness = spawnHarnessChild({
    command: "npx",
    args: ["vite", "--host", "127.0.0.1"],
    cwd: rendererRoot,
    env: {
      ...process.env,
      TMUX_IDE_DEV_SERVER_PORT: String(port),
      VITE_TMUX_IDE_DEV_HOST: "1",
      VITE_TMUX_IDE_DEV_DAEMON_URL: daemon.baseUrl,
      VITE_TMUX_IDE_DEV_OWNER_TOKEN: daemon.record.authToken,
    },
  });

  const origin = `http://127.0.0.1:${port}`;
  const headers = await pollUntil<Headers>({
    probe: async () => {
      if (harness.child.exitCode !== null) {
        throw new Error(`vite exited (${harness.child.exitCode})\n${harness.output()}`);
      }
      const response = await fetch(`${origin}/`);
      return response.ok ? response.headers : null;
    },
    detail: "the vite dev server to answer",
    timeoutMs: VITE_READY_TIMEOUT_MS,
  });

  // Without this line every daemon fetch and WebSocket from the page is refused
  // by the dev CSP and the app silently falls back to its preview surface — a
  // failure that would otherwise surface as an inscrutable "no fleet" timeout.
  const csp = headers.get("content-security-policy") ?? "";
  if (!csp.includes(daemon.baseUrl)) {
    throw new Error(`the dev CSP does not admit the daemon origin ${daemon.baseUrl}\n${csp}`);
  }

  return {
    pageUrl: `${origin}/?devHost=1`,
    origin,
    output: harness.output,
    stop: harness.stop,
  };
}
