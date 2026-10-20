import process from "node:process";
import console from "node:console";
// Real private tmux/daemon replacement, retaining the same browser and selected pane.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { readFile, stat, mkdir, writeFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { stopFixtureChild } from "../../../apps/tmux-gpui/bridge/fixture-child.mjs";

import { createHash } from "node:crypto";
process.umask(0o077);
let currentInfo;
const root = resolve(import.meta.dirname, "../../..");
const output = resolve(process.argv[2] ?? "");
assert.ok(output.startsWith(join(root, ".tasks/native-reliability-mission/nr06-packaged-diagnostics/")));
await assert.rejects(stat(output));
const pinned = JSON.parse(await readFile(join(root,"apps/tmux-gpui/evidence/nr08-packaged-ssh-09e7bd45-2026-10-18/artifacts.json"),"utf8"));
pinned["bin/cli.js"] = "f09acb9b1a4ae9349b7d10858234995066085ff8e9403150cbb70002a9fea428";
const digest = async p => createHash("sha256").update(await readFile(p)).digest("hex");
for (const [p, hash] of Object.entries(pinned)) assert.equal(await digest(join(root,p)),hash);
const browserPath = join(root,Object.keys(pinned).find(p=>p.endsWith("bridge/browser.bundle.mjs")));
const packagedNode = join(root,Object.keys(pinned).find(p=>p.endsWith("Resources/node")));
const cli = join(root,".tasks/native-reliability-mission/nr07-guidance-runtime/cli.mjs");
process.env.PATH=join(root,".tasks/tmux38-compat/tmux-3.8")+":/usr/bin:/bin:/usr/sbin:/sbin";
const receipt={passed:false,cleanup:false,observations:[],scope:"actual private owner to packaged bridge diagnostics; no native export or GUI"};
let fatal;
const scratch = await createScratchFleet({
  sessions: 1,
  windowsPerSession: 1,
  slug: "gpui-auto-recovery",
});
const env = { ...process.env };
for (const key of Object.keys(env))
  if (key.startsWith("TMUX_IDE_") || key === "TMUX" || key === "TMUX_TMPDIR") delete env[key];
Object.assign(env, scratch.environment);
env.TMUX_IDE_TMUX_SOCKET_PATH = scratch.socketPath;
delete env.TMUX_PANE;
delete env.NODE_OPTIONS;
delete env.NODE_PATH;
let daemon,
  browser,
  latest,
  buffer = "",
  stderr = "";
let phase = "startup";
const until = async (predicate) => {
  const deadline = Date.now() + 45000;
  while (!(await predicate())) {
    if (fatal) throw fatal;
    assert.ok(
      Date.now() < deadline,
      `Recovery deadline; phase=${phase}; status=${latest?.status}; diagnostics=${stderr}`,
    );
    await delay(25);
  }
};
const start = async () => {
  daemon = spawn(packagedNode, [cli, "--headless"], {
    env,
    cwd: scratch.root,
    stdio: "ignore",
  });
  daemon.on("error",()=>{fatal=new Error("Owned daemon spawn failed");});
  await until(async () => {
    assert.equal(daemon.exitCode, null, "private daemon exited");
    try {
      return (
        JSON.parse(await readFile(join(scratch.daemonInfoDir, "daemon.json"), "utf8")).pid ===
        daemon.pid
      );
    } catch {
      return false;
    }
  });
  currentInfo = JSON.parse(await readFile(join(scratch.daemonInfoDir, "daemon.json"), "utf8"));
};
async function verifyDiagnostics(label) {
  assert.equal(currentInfo.pid,daemon.pid);
  assert.equal(currentInfo.bindHostname,"127.0.0.1");
  const response=await fetch(`http://127.0.0.1:${currentInfo.port}/identity`,{redirect:"error",signal:AbortSignal.timeout(2500)});
  assert.equal(response.status,200);
  let body="";for await(const chunk of response.body){body+=Buffer.from(chunk).toString("utf8");assert.ok(Buffer.byteLength(body)<=16384);}
  let identity;try{identity=JSON.parse(body);}catch{throw new Error("Identity response invalid");}
  for(const key of ["pid","instanceId","environmentId","startedAt","protocolVersion"]) assert.equal(identity[key],currentInfo[key]);
  const version=execFileSync(env.TMUX_IDE_TMUX_BIN,["-S",scratch.socketPath,"display-message","-p","-t",scratch.initialPanes[0].paneId,"#{version}"],{env,encoding:"utf8",timeout:4000}).trim();
  assert.equal(version,"3.8");
  await until(()=>latest?.inputReady && latest?.snapshot && latest.diagnostics?.daemonVersion===identity.productVersion && latest.diagnostics?.tmuxVersion===version);
  receipt.observations.push({label,instanceId:identity.instanceId,pid:identity.pid,daemonVersion:identity.productVersion,tmuxVersion:version,published:latest.diagnostics,request:latest.request,inputReady:latest.inputReady});
}
const send = (value) => browser.stdin.write(JSON.stringify(value) + "\n");
try {
  await start();
  const browserEnv = { ...env };
  browser = spawn(
    packagedNode,
    [browserPath, "--local"],
    {
      env: browserEnv,
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  browser.on("error",()=>{fatal=new Error("Owned browser spawn failed");});
  for(const stream of [browser.stdin,browser.stdout,browser.stderr]) stream.on("error",()=>{fatal=new Error("Owned stream failed");});
  browser.stderr.on("data", (b) => {
    stderr = (stderr + b.toString()).slice(-8000);
  });
  browser.stdout.on("data", (b) => {
    try {
    buffer += b.toString();
    assert.ok(Buffer.byteLength(buffer)<=8*1024*1024,"Publication cap");
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      latest = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
    }
    } catch { fatal=new Error("Invalid bounded publication"); }
  });
  await until(() =>
    latest?.fleet?.groups.some(
      (g) =>
        g.id === "local" &&
        g.sessions.some((s) => s.name === scratch.sessionNames[0] && s.selection),
    ),
  );
  const session = latest.fleet.groups
    .find((g) => g.id === "local")
    .sessions.find((s) => s.name === scratch.sessionNames[0]);
  assert.ok(session?.selection, "Only the owned scratch session may be selected");
  send({ type: "fleet-session", request: 1, selection: session.selection });
  await until(() => latest?.request === 1 && latest?.panes.length);
  const pane = latest.panes[0].id;
  send({ type: "pane", request: 2, id: pane });
  await until(() => latest?.request === 2 && latest.snapshot && latest.inputReady);
  await verifyDiagnostics("initial");
  const initialInstance=currentInfo.instanceId;
  const sessionId = latest.selectedSession;
  const tabId = latest.sessionTabs?.active;
  assert.ok(tabId, "Initial retained tab admitted");
  phase = "retirement";
  await stopFixtureChild(daemon);
  daemon = undefined;
  currentInfo = null;
  await until(() => !latest.snapshot && !latest.inputReady);
  assert.equal(latest.diagnostics,null);
  receipt.observations.push({label:"retired",diagnostics:null});
  // Disconnected input must be discarded, never replayed into fresh authority.
  send({
    type: "input",
    request: 2,
    id: pane,
    input: { kind: "text", data: "echo MUST_NOT_REPLAY_1702" },
  });
  send({ type: "input", request: 2, id: pane, input: { kind: "key", data: "Enter" } });
  // No refresh or reselect is sent during recovery.
  phase = "restart";
  await start();
  phase = "automatic restoration";
  await until(() => latest?.snapshot && latest.inputReady && latest.selectedPane === pane);
  assert.notEqual(currentInfo.instanceId,initialInstance);
  await verifyDiagnostics("replacement");
  assert.equal(latest.selectedSession, sessionId);
  assert.equal(latest.request, 2);
  await until(() => latest.sessionTabs?.rows.some((row) => row.id === tabId && row.available));
  assert.equal(latest.sessionTabs.active, tabId);
  phase = "restored input";
  console.log(
    JSON.stringify({
      phase,
      grid: scratch.windowGrid(scratch.sessionNames[0]),
      snapshot: { cols: latest.snapshot.cols, rows: latest.snapshot.rows },
    }),
  );
  send({
    type: "input",
    request: 2,
    id: pane,
    input: { kind: "text", data: "echo RECOVERY_LIVE_OK\n" },
  });
  send({ type: "input", request: 2, id: pane, input: { kind: "key", data: "Enter" } });
  await until(() =>
    scratch
      .capturePane(scratch.sessionNames[0])
      .split("\n")
      .some((line) => line.trim() === "RECOVERY_LIVE_OK"),
  );
  assert.ok(
    !scratch.capturePane(scratch.sessionNames[0]).includes("MUST_NOT_REPLAY_1702"),
    "Interrupted input must not replay",
  );
  phase = "navigation cancels recovery";
  await stopFixtureChild(daemon);
  daemon = undefined;
  currentInfo = null;
  await until(() => !latest.snapshot && !latest.inputReady);
  assert.equal(latest.diagnostics,null);
  receipt.observations.push({label:"retired",diagnostics:null});
  send({ type: "home", request: 3 });
  await until(() => latest.request === 3 && latest.surface === "home");
  await start();
  await delay(2500);
  assert.equal(latest.surface, "home");
  assert.equal(latest.request, 3);
  assert.equal(latest.snapshot, null);
  assert.equal(latest.inputReady, false);
  assert.equal(latest.diagnostics,null);
  receipt.observations.push({label:"home",diagnostics:null});
  receipt.passed=true;
  console.log(
    JSON.stringify({
      passed: true,
      sameBrowser: true,
      samePane: true,
      automaticRecovery: true,
      realSsh: false,
    }),
  );
 } catch(error) {
  receipt.failure=error instanceof Error ? error.message.split("; status=")[0] : "Fixture failed";
} finally {
  try {
    await stopFixtureChild(browser);await stopFixtureChild(daemon);
    assert.ok(!browser||browser.exitCode!==null||browser.signalCode!==null);
    assert.ok(!daemon||daemon.exitCode!==null||daemon.signalCode!==null);
    await scratch.dispose();
    await assert.rejects(stat(scratch.socketPath),{code:"ENOENT"});
    receipt.cleanup=true;
  } catch {receipt.cleanupFailure="Owned cleanup failed";}
  receipt.hashesUnchanged=true;
  for(const [p,hash] of Object.entries(pinned)) if(await digest(join(root,p))!==hash)receipt.hashesUnchanged=false;
  receipt.inputs=pinned;receipt.harnessSha256=await digest(import.meta.filename);
  await writeFile(output,JSON.stringify(receipt,null,2)+"\n",{mode:0o600,flag:"wx"});
  console.log(JSON.stringify({passed:receipt.passed,cleanup:receipt.cleanup,hashesUnchanged:receipt.hashesUnchanged,output}));
  if(!receipt.passed||!receipt.cleanup||!receipt.hashesUnchanged)process.exitCode=1;
}
