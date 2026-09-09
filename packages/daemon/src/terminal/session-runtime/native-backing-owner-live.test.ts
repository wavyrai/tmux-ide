import { Hono } from "hono";
import { createServer, type Server } from "node:http";
import { mountTerminalNativeBackingRoute } from "../../command-center/resources/terminal-native-backing-route.ts";
import { readNativeBacking } from "../protocol/native-backing-client.ts";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MirrorControlChannel } from "../mirror/control-channel.ts";
import { MirrorService } from "../mirror/mirror-service.ts";
import { SessionRuntimeTerminalReplicaOwner } from "./terminal-replica-owner.ts";

const experimentalTmux = process.env.TMUX_IDE_NATIVE_GRID_TMUX;
for (const target of [
  { name: "system fallback", executable: "tmux", native: false },
  ...(experimentalTmux
    ? [{ name: "experimental native grid", executable: experimentalTmux, native: true }]
    : []),
]) {
  const available = spawnSync(target.executable, ["-V"], { stdio: "ignore" }).status === 0;
  describe.skipIf(!available)(`native backing revision admission: ${target.name}`, () => {
    it.each(
      target.native
        ? ["plain", "wide", "history", "wrapped", "one-column", "alternate", "erased-tail"]
        : ["plain"],
    )(
      "qualifies %s content without changing system tmux",
      async (mode) => {
        const socketName = `zz-backing-owner-${process.pid}-${randomUUID().slice(0, 8)}`;
        const directory = mkdtempSync(join(tmpdir(), "tmux-backing-owner-"));
        const tmux = (...args: string[]) =>
          execFileSync(target.executable, ["-L", socketName, "-f", "/dev/null", ...args], {
            encoding: "utf8",
            env: { ...process.env, TMUX: "" },
          }).trimEnd();
        const script = join(directory, "paint.mjs");
        const content =
          mode === "erased-tail"
            ? "\x1b[48;5;17m\x1b[2J\x1b[HREADY"
            : mode === "alternate"
              ? "\x1b[?1049hALT-READY"
              : mode === "wide" || mode === "one-column"
                ? "\x1b[31m界e\u0301\x1b[0mREADY"
                : mode === "history"
                  ? Array.from({ length: 40 }, (_, i) => `HISTORY-${i}\r\n`).join("") + "READY"
                  : mode === "wrapped"
                    ? "A".repeat(50) + "READY"
                    : "READY";
        writeFileSync(
          script,
          `process.stdin.setRawMode(true);process.stdin.on('data',data=>process.stdout.write(data));process.stdout.write(${JSON.stringify(content)});setInterval(()=>{},10000);`,
        );
        const mirror = new MirrorService({
          createIo: (session, handlers) =>
            new MirrorControlChannel({
              session,
              handlers,
              socketName,
              configFile: "/dev/null",
              executable: target.executable,
            }),
        });
        let owner: SessionRuntimeTerminalReplicaOwner | undefined;
        let server: Server | undefined;
        try {
          tmux(
            "new-session",
            "-d",
            "-s",
            "backing",
            "-x",
            mode === "one-column" ? "1" : "40",
            "-y",
            "8",
            `${process.execPath} ${script}`,
          );
          tmux("set-option", "-t", "backing", "status", "off");
          await vi.waitFor(() =>
            expect(tmux("capture-pane", "-p", "-J", "-t", "backing")).toContain("READY"),
          );
          const described = await mirror.describeSession("backing");
          owner = new SessionRuntimeTerminalReplicaOwner(
            randomUUID(),
            "backing",
            described.panes[0]!.semanticPaneId,
            mirror,
            { incarnation: "backing:0", initialRevision: 0 },
          );
          await owner.subscribe(() => undefined);
          const result = await owner.captureNativeBacking();
          if (!target.native) {
            expect(result.status).toBe("unsupported");
            expect((await owner.captureNativeBacking()).status).toBe("unsupported");
            return;
          }
          if (mode === "erased-tail") {
            // ANSI -J bootstrap omits allocated BCE tails. V2 must expose
            // that mismatch rather than qualifying incomplete painted truth.
            expect(result.status).toBe("mismatch");
            return;
          }
          expect(result.status).toBe("captured");
          if (result.status !== "captured")
            throw new Error(`Native admission failed: ${result.status}`);
          const { incarnation, revision, stateHash } = owner.qualificationSnapshot();
          expect(result.authority).toMatchObject({ incarnation, revision, stateHash });
          expect(result.isCurrent()).toBe(true);
          const app = new Hono();
          mountTerminalNativeBackingRoute(app, {
            generation: result.authority.generation,
            ownerToken: "test-owner",
            resolveSession: (workspace) => (workspace === "backing" ? "backing" : null),
            capture: () => owner!.captureNativeBacking(),
          });
          server = createServer(async (request, response) => {
            const result = await app.request(`http://127.0.0.1${request.url}`, {
              headers: { authorization: request.headers.authorization ?? "" },
            });
            response.writeHead(result.status, Object.fromEntries(result.headers));
            response.end(Buffer.from(await result.arrayBuffer()));
          });
          await new Promise<void>((resolve, reject) => {
            server!.once("error", reject);
            server!.listen(0, "127.0.0.1", resolve);
          });
          const address = server.address();
          if (!address || typeof address === "string")
            throw new Error("Missing test server address");
          const transported = await readNativeBacking({
            baseUrl: `http://127.0.0.1:${address.port}`,
            ownerToken: "test-owner",
            workspaceName: "backing",
            paneId: result.authority.semanticPaneId,
            expected: {
              generation: result.authority.generation,
              incarnation: result.authority.incarnation,
              revision: result.authority.revision,
              stateHash: result.authority.stateHash,
            },
            signal: new AbortController().signal,
          });
          expect(transported).toEqual(result.snapshot);

          if (mode === "history") expect(result.snapshot.history).toBeGreaterThan(30);
          tmux("send-keys", "-t", "backing", "-l", "X");
          await vi.waitFor(() => expect(result.isCurrent()).toBe(false));
          await vi.waitFor(async () =>
            expect((await owner!.captureNativeBacking()).status).toBe("captured"),
          );
        } finally {
          if (server) {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server!.close(() => resolve()));
          }
          await owner?.dispose();
          await mirror.dispose();
          spawnSync(target.executable, ["-L", socketName, "kill-server"], { stdio: "ignore" });
          rmSync(directory, { recursive: true, force: true });
        }
      },
      10000,
    );
  });
}
