#!/usr/bin/env node
// Stands in for the native binary under preview-launcher: relays the bridge's
// stdout to the measuring harness over a unix socket and the harness's commands
// back to the bridge. Its own probe file records what the GUI process receives.
import { connect } from "node:net";

const socket = connect(process.env.FAKE_GUI_SOCKET);
process.stdin.pipe(socket);
socket.pipe(process.stdout);
socket.on("close", () => process.exit(0));
process.stdin.on("end", () => socket.end());
