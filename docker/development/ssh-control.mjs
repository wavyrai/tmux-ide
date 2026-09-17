/** Private bounded stop channel: controls only the live listener's retained child. */
import process from "node:process";
import { createServer, createConnection } from "node:net";
import { lstatSync, chmodSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
function socketIdentity(path) {
  const stat = lstatSync(path);
  if (!stat.isSocket() || stat.uid !== process.getuid() || stat.mode & 0o077)
    throw new Error("Unverified SSH control socket");
  return `${stat.dev}:${stat.ino}`;
}
export async function createSshControl(path, nonce, stop) {
  const peers = new Set();
  const waiting = new Set();
  let requested = false;
  const server = createServer((socket) => {
    if (peers.size >= 4) {
      socket.destroy();
      return;
    }
    peers.add(socket);
    socket.setTimeout(10000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("close", () => {
      peers.delete(socket);
      waiting.delete(socket);
    });
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (data.length > 512) {
        socket.destroy();
        return;
      }
      if (!data.endsWith("\n")) return;
      let request;
      try {
        request = JSON.parse(data);
      } catch {
        socket.destroy();
        return;
      }
      if (
        !request ||
        request.operation !== "stop" ||
        request.nonce !== nonce ||
        Object.keys(request).length !== 2
      ) {
        socket.destroy();
        return;
      }
      socket.removeAllListeners("data");
      waiting.add(socket);
      if (!requested) {
        requested = true;
        stop();
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  chmodSync(path, 0o600);
  const identity = socketIdentity(path);
  return {
    async finish() {
      if (socketIdentity(path) !== identity) throw new Error("SSH control socket changed");
      const response = `${JSON.stringify({ version: 1, scope: "ssh-listener", stopped: true, childrenMayRemain: true })}\n`;
      for (const socket of peers) {
        if (waiting.has(socket)) socket.end(response);
        else socket.destroy();
      }
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
export async function requestSshStop(path, nonce) {
  const identity = socketIdentity(path);
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const fail = () => {
      socket.destroy();
      reject(new Error("SSH listener stop unavailable"));
    };
    socket.setTimeout(10000, fail);
    socket.on("error", fail);
    socket.on("close", () => reject(new Error("SSH listener stop unavailable")));
    let data = "";
    socket.once("connect", () => {
      try {
        if (socketIdentity(path) !== identity) return fail();
        socket.write(`${JSON.stringify({ operation: "stop", nonce })}\n`);
      } catch {
        fail();
      }
    });
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (data.length > 4096) fail();
    });
    socket.on("end", () => {
      try {
        const value = JSON.parse(data);
        if (
          value.version !== 1 ||
          value.scope !== "ssh-listener" ||
          value.stopped !== true ||
          value.childrenMayRemain !== true
        )
          return fail();
        socket.destroy();
        resolve(value);
      } catch {
        fail();
      }
    });
  });
}

/** Called after the private response. Observe retirement; never remove stale evidence. */
export async function waitForSshRetirement(root, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const present = ["admission.json", "serve.json", "control.sock", "sshd.pid"].some((name) => {
      try {
        lstatSync(`${root}/${name}`);
        return true;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    });
    if (!present) return;
    if (Date.now() >= deadline) throw new Error("SSH listener retirement remains incomplete");
    await delay(Math.min(10, deadline - Date.now()));
  }
}
/** Do not create a listener process until exclusive control socket creation succeeds. */
export async function startControlledSshListener(path, nonce, start) {
  let child;
  let requested = false;
  const control = await createSshControl(path, nonce, () => {
    requested = true;
    child?.kill("SIGTERM");
  });
  try {
    if (!requested) child = start();
  } catch (error) {
    await control.finish();
    throw error;
  }
  return { control, child };
}
