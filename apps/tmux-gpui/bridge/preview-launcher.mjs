import { fileURLToPath } from "node:url";
import { runPreview } from "./preview-processes.mjs";

const browse = process.argv[4] === "--browse";
if (process.argv.length !== (browse ? 5 : 4)) {
  console.error("Usage: preview-launcher.mjs NATIVE_BINARY CONNECTION.json [--browse]");
  process.exitCode = 2;
} else {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    process.exitCode = await runPreview({
      native: {
        command: process.argv[2],
        args: [browse ? "--tmux-browser-stdio" : "--tmux-live-stdin"],
      },
      helper: {
        command: process.execPath,
        args: [
          ...(import.meta.url.endsWith(".bundle.mjs") ? [] : ["--import", "tsx"]),
          fileURLToPath(
            new URL(
              `${browse ? "browser" : "live"}.${import.meta.url.endsWith(".bundle.mjs") ? "bundle.mjs" : "ts"}`,
              import.meta.url,
            ),
          ),
          process.argv[3],
        ],
      },
      signal: controller.signal,
      duplex: browse,
    });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
