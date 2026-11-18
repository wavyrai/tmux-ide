// Imported first by bin/cli.ts so an unsupported Node.js stops with a clear
// message before any command code runs.
import { unsupportedNodeMessage } from "./node-requirement.ts";

const message = unsupportedNodeMessage(process.versions);
if (message !== null) {
  process.stderr.write(message);
  process.exit(1);
}
