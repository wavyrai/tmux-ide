// Transitional terminal picker; the same scoped catalog will back the native UI.
import { createInterface } from "node:readline/promises";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createPreviewCatalog } from "./catalog.ts";
import { hostSchema, readPrivateConfig } from "./config.ts";

async function main() {
  if (process.argv.length !== 4 || !process.stdin.isTTY)
    throw new Error(
      "Usage: select-preview.ts NATIVE_BINARY PRIVATE_HOST.json (interactive terminal)",
    );
  const catalog = createPreviewCatalog(hostSchema.parse(readPrivateConfig(process.argv[3]!)));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let directory: string | undefined;
  try {
    const sessions = await catalog.sessions();
    if (!sessions.length) throw new Error("No live sessions on the selected server");
    // Render remote labels as quoted strings: terminal control characters stay escaped.
    sessions.forEach((s, i) =>
      console.log(`${i + 1}. ${JSON.stringify(s.sessionName)} (${s.paneCount} panes)`),
    );
    const choose = async (label: string, count: number) => {
      const answer = (await rl.question(label)).trim();
      if (!/^[1-9][0-9]*$/.test(answer)) throw new Error("Invalid selection");
      const index = Number(answer) - 1;
      if (!Number.isSafeInteger(index) || index >= count) throw new Error("Invalid selection");
      return index;
    };
    const session = sessions[await choose("Session: ", sessions.length)]!;
    const panes = await catalog.panes(session.liveSessionId);
    if (!panes.length) throw new Error("Selected session has no available panes");
    panes.forEach((p, i) => console.log(`${i + 1}. ${JSON.stringify(p.semanticPaneId)}`));
    const pane = panes[await choose("Pane: ", panes.length)]!;
    rl.close();
    catalog.dispose();
    directory = await mkdtemp(join(tmpdir(), "tmux-gpui-selection-"));
    const config = join(directory, "connection.json");
    await writeFile(config, JSON.stringify(pane), { mode: 0o600 });
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("preview-launcher.mjs", import.meta.url)),
        resolve(process.argv[2]!),
        config,
      ],
      { stdio: "inherit" },
    );
    const stop = () => child.kill("SIGTERM");
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      const [code] = await once(child, "close");
      process.exitCode = typeof code === "number" ? code : 1;
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  } finally {
    rl.close();
    catalog.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
main().catch(() => {
  console.error(
    "Could not open the selected pane. Check the private host configuration and current daemon identity.",
  );
  process.exitCode = 1;
});
