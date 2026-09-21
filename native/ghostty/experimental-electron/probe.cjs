// Isolated native-renderer qualification host. Never loaded by the shipped app.
const { app, BrowserWindow } = require("electron");
const { resolve } = require("node:path");
const assert = require("node:assert/strict");
const { setTimeout: delay } = require("node:timers/promises");
const { writeFileSync } = require("node:fs");

const addonPath = process.env.TMUX_IDE_GHOSTTY_ADDON;
if (!addonPath) throw new Error("Set TMUX_IDE_GHOSTTY_ADDON to the experimental native addon.");
const native = require(resolve(addonPath));
let window;
let surface;
let stream;
let disposed = false;
let canonicalGeometry;
const input = { events: 0, bytes: 0 };
const checks = {};
function dispose() {
  if (disposed) return;
  disposed = true;
  stream?.dispose();
  if (surface !== undefined) native.dispose(surface);
  surface = undefined;
}
app.on("window-all-closed", () => app.quit());
app.on("before-quit", dispose);
function feed(bytes) {
  if (disposed) return;
  const buffer = Buffer.from(bytes);
  for (let offset = 0; offset < buffer.length; offset += 1024 * 1024)
    native.feed(surface, buffer.subarray(offset, offset + 1024 * 1024));
}
app
  .whenReady()
  .then(async () => {
    window = new BrowserWindow({
      width: 1000,
      height: 700,
      backgroundColor: "#101114",
      title: "tmux-ide · native Ghostty experiment",
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    await window.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(`<!doctype html>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>html{background:#101114;color:#a9abb3;font:13px -apple-system,BlinkMacSystemFont,sans-serif}body{margin:0}header{height:48px;box-sizing:border-box;padding:15px 18px;border-bottom:1px solid #30323a}</style>
<header>tmux-ide · native libghostty / Metal · isolated read-only stream experiment</header>`),
    );
    surface = native.create(window.getNativeWindowHandle(), (bytes) => {
      // Probe is read-only. Record counts only, never typed contents. Production
      // integration must route through the existing input-ownership capability.
      input.events++;
      input.bytes += bytes.byteLength;
    });
    const resize = () => {
      if (disposed) return;
      const [width, height] = window.getContentSize();
      if (canonicalGeometry) {
        const metrics = native.metrics(surface);
        const scale = metrics.scale || 1;
        native.resize(
          surface,
          0,
          48,
          (canonicalGeometry.cols * metrics.cellWidthPx) / scale,
          (canonicalGeometry.rows * metrics.cellHeightPx) / scale,
        );
        const after = native.metrics(surface);
        if (after.columns !== canonicalGeometry.cols || after.rows !== canonicalGeometry.rows)
          throw new Error(
            "Native grid does not match canonical daemon geometry: " + JSON.stringify(after),
          );
      } else native.resize(surface, 0, 48, width, Math.max(1, height - 48));
    };
    window.on("resize", resize);
    window.on("closed", dispose);
    resize();
    if (process.env.TMUX_IDE_GHOSTTY_STREAM_MODULE) {
      const { connectNativePane } = require(resolve(process.env.TMUX_IDE_GHOSTTY_STREAM_MODULE));
      stream = await connectNativePane({
        daemonInfoPath: process.env.TMUX_IDE_GHOSTTY_DAEMON_INFO,
        workspaceName: process.env.TMUX_IDE_GHOSTTY_WORKSPACE,
        paneId: process.env.TMUX_IDE_GHOSTTY_PANE,
        onSeed: feed,
        onOutput: feed,
        onGeometry: (geometry) => {
          canonicalGeometry = geometry;
          resize();
          console.log(JSON.stringify({ event: "canonical-geometry", ...geometry }));
        },
        onError: (error) => {
          console.error("Native stream failed:", error.message);
          app.exit(1);
        },
      });
    } else {
      const lines = [
        "\x1b[2J\x1b[H\x1b[36mNative libghostty · external I/O · Metal\x1b[0m",
        "No child shell or PTY is created by this terminal surface.",
        "This diagnostic fixture is not a daemon integration test.",
        "",
      ];
      for (let i = 0; i < 500; i++)
        lines.push(`GHOSTTY_HISTORY_${String(i).padStart(4, "0")}  Scroll and select this text.`);
      feed(Buffer.from(lines.join("\r\n") + "\r\n"));
    }
    if (!process.env.TMUX_IDE_GHOSTTY_STREAM_MODULE && process.env.TMUX_IDE_GHOSTTY_PROBE_RESULT) {
      assert.match(native.readText(surface), /GHOSTTY_HISTORY_0499/);
      native.scroll(surface, 10000);
      for (let i = 0; i < 100 && !native.readText(surface).includes("Native libghostty"); i++)
        await delay(20);
      assert.match(native.readText(surface), /Native libghostty/);
      checks.nativeScrollReachesOldest = true;
      native.scroll(surface, -10000);
      for (let i = 0; i < 100 && !native.readText(surface).includes("GHOSTTY_HISTORY_0499"); i++)
        await delay(20);
      assert.match(native.readText(surface), /GHOSTTY_HISTORY_0499/);
      checks.nativeScrollReturnsToLive = true;
      native.visibility(surface, false);
      native.visibility(surface, true);
      checks.visibilityRoundTrip = true;
    }
    assert.equal(native.metrics(surface).foregroundPid, 0);
    console.log(
      JSON.stringify({ event: "native-ready", metrics: native.metrics(surface), checks }),
    );
    if (process.env.TMUX_IDE_GHOSTTY_PROBE_RESULT) {
      await delay(2500);
      if (disposed) return;
      const image = await window.webContents.capturePage();
      writeFileSync(process.env.TMUX_IDE_GHOSTTY_PROBE_RESULT + ".png", image.toPNG());
      writeFileSync(
        process.env.TMUX_IDE_GHOSTTY_PROBE_RESULT + ".json",
        JSON.stringify(
          {
            metrics: native.metrics(surface),
            input,
            checks,
            text: native.readText ? native.readText(surface) : null,
            memory: app.getAppMetrics().map(({ type, memory }) => ({ type, memory })),
            note: "Chromium capture may omit native NSView compositing; inspect native window separately.",
          },
          null,
          2,
        ),
      );
      app.quit();
    }
  })
  .catch((error) => {
    console.error(error);
    dispose();
    app.exit(1);
  });
