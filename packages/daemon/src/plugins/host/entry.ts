// Standalone entry for the plugin host, used when the daemon runs from source.
// The published CLI starts the same code with `tmux-ide __plugin-host`.
import { runPluginHost } from "./main.ts";

await runPluginHost();
