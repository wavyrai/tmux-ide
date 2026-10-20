from pathlib import Path
r=Path.cwd(); s=(r/'apps/tmux-gpui/bridge/local-setup-empty-smoke.mjs').read_text()
s=s.replace('"./fixture-child.mjs"',repr(str(r/'apps/tmux-gpui/bridge/fixture-child.mjs')))
s=s.replace('fileURLToPath(new URL("../../../node_modules", import.meta.url))',repr(str(r/'node_modules')))
s=s.replace('fileURLToPath(new URL("../../../apps/tmux-gpui/bridge/browser.ts", import.meta.url))',repr(str(r/'apps/tmux-gpui/bridge/browser.ts')))
s=s.replace('import.meta.resolve("tsx")',repr(str(r/'node_modules/tsx/dist/loader.mjs')))
s=s.replace('await mkdtemp("/tmp/tmi-empty-setup-")','await mkdtemp("/Volumes/Samsung_T5/tmi-recovery-")')
s=s.replace('Date.now() + 60000','Date.now() + 100000')
s=s.replace('const identities = new Set();','''const identities = new Set();
const ownedPids = new Set();
const sourcePids = new Set();
const recovery = {};
const protectedCli = await readFile('''+repr(str(r/'bin/cli.js'))+''');
function alive(pid) { try { process.kill(pid, 0); return true; } catch(e) { assert.equal(e.code, "ESRCH"); return false; } }
''')
s=s.replace('identities.add(record.instanceId);','identities.add(record.instanceId); ownedPids.add(record.pid);')
s=s.replace('    inputVerified = true;', '''    inputVerified = true;
    const original = { ...record };
    await verify(original);
    const sourceIdentity = () => tmux("list-panes", "-t", `=${userSessions[0]}`, "-F", "#{session_id}|#{window_id}|#{pane_id}|#{pane_pid}|#{pid}").trim();
    recovery.sourceBefore = sourceIdentity();
    for (const line of recovery.sourceBefore.split("\\n")) { const parts=line.split("|"); sourcePids.add(Number(parts[3])); sourcePids.add(Number(parts[4])); }
    assert.ok([...sourcePids].every(pid => Number.isSafeInteger(pid) && pid > 1 && alive(pid)));
    recovery.old = { pid:original.pid, instanceId:original.instanceId };
    process.kill(original.pid, "SIGKILL");
    await until(() => !alive(original.pid));
    assert.equal((await readRecord()).instanceId, original.instanceId, "Real crash must leave original record");
    assert.equal(sourceIdentity(), recovery.sourceBefore);
    recovery.authenticStaleRecord = true;
    send({type:"home", request:latest.request+1});
    await until(() => latest.home?.phase === "unavailable" && latest.localSetup?.phase === "available");
    send({type:"refresh", request:latest.request+1});
    await until(() => latest.home?.phase === "unavailable" && latest.localSetup?.phase === "available");
    await delay(750);
    assert.equal((await readRecord()).instanceId, original.instanceId);
    assert.equal(alive(original.pid),false);
    assert.equal(identities.size,1);
    assert.equal(latest.inputReady,false);
    assert.equal(latest.localSessionCreate,null);
    assert.equal(sourceIdentity(), recovery.sourceBefore);
    recovery.readOnlyRefreshNoStart = true;
    send({type:"local-setup", request:latest.request});
    await until(() => latest.home?.phase === "live" && latest.sessions.length === 1 && record?.instanceId !== original.instanceId);
    await verify(record);
    recovery.replacement = {pid:record.pid,instanceId:record.instanceId};
    assert.notEqual(record.pid,original.pid);
    assert.equal(sourceIdentity(), recovery.sourceBefore);
    recovery.sourceSurvived = true;
    send({type:"session",request:latest.request+1,id:latest.sessions[0].id});
    await until(() => latest.panes.length > 0 && latest.sessionCatalogComplete);
    send({type:"pane",request:latest.request+1,id:latest.panes[0].id});
    await until(() => latest.snapshot && latest.inputReady && latest.selectedPane);
    const recoveredMarker = "NR07_RECOVERED_INPUT_OK";
    send({type:"input",request:latest.request,id:latest.selectedPane,input:{kind:"paste",data:`printf '${recoveredMarker}\\\\n'`}});
    send({type:"input",request:latest.request,id:latest.selectedPane,input:{kind:"key",data:"Enter"}});
    await until(() => tmux("capture-pane","-p","-t",nativePane).split("\\n").some(line=>line.trim()===recoveredMarker));
    recovery.freshInput = true;
''')
s=s.replace('assert.equal(identities.size, 1);','assert.equal(identities.size, 2);')
a=s.index('  try {\n    if (browser) await stopFixtureChild(browser);',s.index('} finally {'))
b=s.index('  const result = {',a)
s=s[:a]+'''  try { if (browser) await stopFixtureChild(browser); } catch(e) { failures.push(`Browser cleanup: ${e.message}`); }
  try {
    const owned = await readRecord();
    if (owned && alive(owned.pid)) {
      const base=await verify(owned);
      const response=await fetch(`${base}/api/v2/action/daemon.shutdown`,{method:"POST",redirect:"error",headers:{"content-type":"application/json",authorization:`Bearer ${owned.authToken}`},body:JSON.stringify({reason:"private-recovery-fixture-cleanup",expectedInstanceId:owned.instanceId}),signal:AbortSignal.timeout(3000)});
      assert.equal(response.status,200);
    }
    const end=Date.now()+5000;
    while ([...ownedPids].some(alive) && Date.now()<end) await delay(25);
    assert.ok([...ownedPids].every(pid=>!alive(pid)),"Observed owned daemon remains");
  } catch(e) { failures.push(`Daemon cleanup: ${e.message}`); }
  try {
    await fleet.dispose();
    const end=Date.now()+5000;
    while ([...sourcePids].some(alive) && Date.now()<end) await delay(25);
    assert.ok([...sourcePids].every(pid=>!alive(pid)),"Observed source process remains");
    assert.deepEqual(await readFile('''+repr(str(r/'bin/cli.js'))+'''),protectedCli,"Protected CLI changed");
    cleanupPassed=[...ownedPids,...sourcePids].every(pid=>!alive(pid)) && (!browser || browser.exitCode !== null || browser.signalCode !== null);
    assert.ok(cleanupPassed);
  } catch(e) { failures.push(`Source cleanup: ${e.message}`); }
'''+s[b:]
s=s.replace('    passed: failures.length === 0,','    passed: failures.length === 0,\n    recovery,\n    observedOwnedPids:[...ownedPids], observedSourcePids:[...sourcePids],\n    physicalNativeGui:false,')
s=s.replace('verifiedDaemonPresent: identities.size === 1','verifiedDaemonPresent: identities.size === 2')
(r/'.tasks/native-reliability-mission/nr07-recovery/run.mjs').write_text(s)
