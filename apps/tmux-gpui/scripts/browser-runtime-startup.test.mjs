import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, realpath, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBrowserRuntime } from "./browser-runtime-load.mjs";
const execute = promisify(execFile);
const payload = process.env.TMUX_IDE_BROWSER_TEST_PAYLOAD;

test(
  "signed engine loads HTTP with the managed app identity and a persistent profile",
  {
    skip: !payload || process.platform !== "darwin",
    timeout: 35000,
  },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "browser-startup-test-")));
    try {
      const cache = join(root, "cache");
      await mkdir(cache, { mode: 0o700 });
      const app = await loadBrowserRuntime({
        destinationRoot: cache,
        archivePath: join(payload, "browser-runtime.tar.gz"),
        metadata: JSON.parse(await readFile(join(payload, "candidate.json"), "utf8")),
      });
      const probe = join(root, "probe.cjs");
      await writeFile(
        probe,
        `
const {app,BrowserWindow}=require('electron');
const http=require('node:http');
app.setName('tmux-ide-browser');
app.setPath('userData',${JSON.stringify(join(root, "profile"))});
app.whenReady().then(async()=>{
 let requests=0;
 const server=http.createServer((req,res)=>{requests++;res.end('<title>Managed startup</title><p>Ready</p>')});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const window=new BrowserWindow({show:false,paintWhenInitiallyHidden:true,width:640,height:480,
 webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false,
 offscreen:{useSharedTexture:true,sharedTexturePixelFormat:'argb',deviceScaleFactor:1}}});
 window.webContents.on('paint',e=>e.texture?.release());
 await window.loadURL('http://127.0.0.1:'+server.address().port+'/');
 if(!requests)throw Error('No HTTP request');
 console.log('MANAGED_PERSISTENT_LOAD_OK');
 window.destroy();server.close();app.quit();
}).catch(error=>{console.error(error);app.exit(1)});
`,
      );
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.NODE_OPTIONS;
      const result = await execute(join(app, "Contents/MacOS/terminal-browser"), [probe], {
        env,
        timeout: 20000,
        killSignal: "SIGKILL",
        maxBuffer: 65536,
      });
      assert.match(result.stdout, /MANAGED_PERSISTENT_LOAD_OK/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
