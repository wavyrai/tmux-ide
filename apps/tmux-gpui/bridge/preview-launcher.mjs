import { nativeSnapshotEncoding } from "./native-capabilities.mjs";
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
    const encoding = await nativeSnapshotEncoding(process.argv[2], {
      signal: controller.signal,
      damage: browse,
    });
    process.exitCode = await runPreview({
      native: {
        env: { ...process.env, TMUX_IDE_GUI_NATIVE_ENCODING: encoding },
        command: process.argv[2],
        args: [browse ? "--tmux-browser-stdio" : "--tmux-live-stdin"],
      },
      helper: {
        env: {
          ...process.env,
          TMUX_IDE_GUI_NATIVE_ENCODING: encoding,
          TMUX_IDE_GUI_HELPER_ENCODING: browse ? "legacy" : encoding,
        },
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
