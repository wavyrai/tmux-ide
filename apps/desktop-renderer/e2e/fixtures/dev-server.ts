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
import { startGenerationGateway } from "../../scripts/generation-gateway.ts";

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

export async function startDevServer(
  daemon: RunningDaemon,
  options: { readonly daemonInfoPath?: string } = {},
): Promise<RunningDevServer> {
  const port = await reservePort();
  const gateway = options.daemonInfoPath
    ? await startGenerationGateway(options.daemonInfoPath, {
        protocolVersion: daemon.record.protocolVersion,
        productVersion: daemon.record.productVersion,
        ...(daemon.record.environmentId ? { environmentId: daemon.record.environmentId } : {}),
      })
    : null;
  const daemonOrigin = gateway?.origin ?? daemon.baseUrl;
  const ownerToken = gateway?.bearer ?? daemon.record.authToken;
  const harness = spawnHarnessChild({
    command: "npx",
    args: ["vite", "--host", "127.0.0.1"],
    cwd: rendererRoot,
    env: {
      ...process.env,
      TMUX_IDE_DEV_SERVER_PORT: String(port),
      VITE_TMUX_IDE_DEV_HOST: "1",
      VITE_TMUX_IDE_DEV_GATEWAY: "1",
      TMUX_IDE_DEV_DAEMON_URL: daemonOrigin,
      TMUX_IDE_DEV_OWNER_TOKEN: ownerToken,
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

  // Gateway mode deliberately keeps the private daemon origin OUT of browser
  // authority: HTTP and WebSockets stay same-origin and Vite adds the owner
  // bearer while proxying. Catch a regression back to direct-daemon CSP here.
  const csp = headers.get("content-security-policy") ?? "";
  if (csp.includes(daemon.baseUrl) || !csp.includes(`ws://127.0.0.1:${port}`)) {
    throw new Error(
      `the gateway CSP exposes daemon authority or refuses its own HMR socket\n${csp}`,
    );
  }

  return {
    pageUrl: `${origin}/?devHost=1`,
    origin,
    output: harness.output,
    stop: async () => {
      await harness.stop();
      await gateway?.stop();
    },
  };
}
