/** Test-only broker/production-Rust connection. Never creates a Node terminal replica. */
import assert from "node:assert/strict";
import process from "node:process";
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { stopFixtureChild } from "./fixture-child.mjs";

export const isNativeTerminalEvent = (value) =>
  value?.type === "native-terminal-open" || value?.type === "native-terminal-close";

export function startNativeJourney(browser, { worker = false, onState = () => {} } = {}) {
  const binary = process.env.TMUX_GPUI_JOURNEY_PROBE;
  assert(
    binary && isAbsolute(binary),
    "Set TMUX_GPUI_JOURNEY_PROBE to the absolute Rust example path",
  );
  const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
  let state = null;
  let failure;
  let stopping = false;
  let stderr = "";
  const states = [];
  const commands = [];
  const opens = [];
  const fail = (error) => {
    failure ??= error;
  };
  const send = (value) => {
    if (failure) throw failure;
    child.stdin.write(JSON.stringify(value) + "\n");
  };
  child.on("error", fail);
  child.stdin.on("error", (error) => {
    if (!stopping) fail(error);
  });
  child.stderr.on("data", (data) => {
    stderr = (stderr + data).slice(-4096);
  });
  child.on("exit", (code) => {
    if (!stopping) fail(new Error(`Native journey stopped (${code}): ${stderr}`));
  });
  const readers = [];
  const lines = (stream, consume) => {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    const read = (chunk) => {
      try {
        buffer += decoder.write(chunk);
        assert(buffer.length <= 8 * 1024 * 1024, "Fixture pipe exceeded bound");
        for (let end; (end = buffer.indexOf("\n")) >= 0; ) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          consume(JSON.parse(line));
        }
      } catch (error) {
        fail(error);
      }
    };
    stream.on("data", read);
    readers.push(() => stream.off("data", read));
  };
  lines(browser.stdout, (event) => {
    if (event.version === 1 && event.connection && event.sequence !== undefined) {
      assert.equal(event.snapshot, null, "Broker must not publish terminal cells");
      assert.equal(event.inputReady, false, "Rust owns terminal input readiness");
    }
    if (!worker && !isNativeTerminalEvent(event)) return;
    if (event.type === "native-terminal-open") {
      // Save public identity only: the one-use capability stays on the private pipe.
      opens.push({ id: event.id, request: event.request, session: event.liveSessionId });
      if (opens.length > 64) opens.shift();
    }
    send(worker ? { type: "broker", data: event } : event);
  });
  lines(child.stdout, (event) => {
    if (event.type === "probe-command") {
      commands.push({
        type: event.command.type,
        request: event.command.request,
        revision: event.command.revision,
        presenceRevision: event.command.presenceRevision,
        inputReady: event.command.inputReady,
      });
      if (commands.length > 64) commands.shift();
      browser.stdin.write(JSON.stringify(event.command) + "\n");
    } else if (event.type === "probe-state") {
      state = worker ? event.state : event;
      onState(state);
      states.push(event);
      if (states.length > 128) states.shift();
    } else if (event.type === "probe-closed" && state?.id === event.id) {
      state = null;
    }
  });
  return {
    get state() {
      if (failure) throw failure;
      return state;
    },
    get opens() {
      return opens;
    },
    get diagnostic() {
      return stderr;
    },
    get commands() {
      return commands;
    },
    get states() {
      return states;
    },
    send: worker ? (data) => send({ type: "command", data }) : send,
    assertHealthy() {
      if (failure) throw failure;
    },
    async stop() {
      stopping = true;
      for (const remove of readers) remove();
      await stopFixtureChild(child);
    },
  };
}
