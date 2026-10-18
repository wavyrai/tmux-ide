// REVIEW BEFORE EXECUTION. Source-built historical artifact, not published-release proof.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopFixtureChild } from '../../../apps/tmux-gpui/bridge/fixture-child.mjs';
const task = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(task, '../../..');
const cli = path.join(task, 'source/bin/cli-v3.mjs');
const node = path.join(repo, '.tasks/tmux38-release-20261018/TmuxIDE.app/Contents/Resources/node');
const tmuxDir = path.join(repo, '.tasks/tmux38-compat/tmux-3.8');
const sha = async p => createHash('sha256').update(await readFile(p)).digest('hex');
assert.equal(await sha(cli), '928005012711bcbf1430ae9d29ac1dca08c8468aed07e558eb9fd8fa1277c39e');
const protectedBefore = await sha(path.join(repo, 'bin/cli.js'));
const output = await mkdtemp(path.join(task, 'launch-'));
const root = await mkdtemp(path.join(tmpdir(), 'nr08-v3-'));
const receipt = { scope: 'Historical source-built non-hermetic v3 owner smoke; no SSH or installed-release qualification', root, passed: false, cleanup: false };
let stderrDiagnostic = '';
let authToken, child, fatal, stdoutBytes = 0, stderrBytes = 0;
const env = { PATH: `${path.dirname(node)}:${tmuxDir}:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: 'en_US.UTF-8', TERM: 'xterm-256color', HOME: path.join(root,'home'), XDG_CONFIG_HOME:path.join(root,'config'), XDG_CACHE_HOME:path.join(root,'cache'), XDG_DATA_HOME:path.join(root,'data'), TMPDIR:root, TMUX:'', TMUX_PANE:'', TMUX_IDE_TMUX_BIN:path.join(tmuxDir,'tmux'), TMUX_IDE_RUNTIME_MODE:'test', TMUX_IDE_HOME:path.join(root,'state'), TMUX_IDE_REGISTRY_DIR:path.join(root,'registry'), TMUX_IDE_DAEMON_INFO_DIR:path.join(root,'info'), TMUX_TMPDIR:path.join(root,'tmux-tmp'), TMUX_IDE_TMUX_SOCKET_NAME:`nr08-v3-${randomUUID()}`, TMUX_IDE_CLEANUP_TOKEN:randomUUID() };
// Pinned historical runner intentionally strips TMUX_TMPDIR; stock tmux uses /tmp.
const socketPath=path.join('/tmp',`tmux-${process.getuid()}`,env.TMUX_IDE_TMUX_SOCKET_NAME);
const alternateSocketPath=path.join(env.TMUX_TMPDIR,`tmux-${process.getuid()}`,env.TMUX_IDE_TMUX_SOCKET_NAME);
receipt.namespace={mode:'test',home:env.HOME,state:env.TMUX_IDE_HOME,info:env.TMUX_IDE_DAEMON_INFO_DIR,socketName:env.TMUX_IDE_TMUX_SOCKET_NAME,socketPath,alternateSocketPath,tmuxTmpdirStrippedByPinnedRunner:true};
const exists = async p => { try { await lstat(p); return true; } catch(e) { if(e.code==='ENOENT') return false; throw e; } };
async function probe(record, endpoint, auth=false) {
  const response = await fetch(`http://127.0.0.1:${record.port}${endpoint}`, { redirect:'error', signal:AbortSignal.timeout(1500), headers:auth?{Authorization:`Bearer ${record.authToken}`}:{}});
  assert.equal(response.status,200,`probe ${endpoint} status`);
  let body = ''; for await (const chunk of response.body) { body += Buffer.from(chunk).toString('utf8'); assert.ok(Buffer.byteLength(body)<=65536,'probe body cap'); }
  return JSON.parse(body);
}
try {
  for(const key of ['HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','TMUX_IDE_HOME','TMUX_IDE_REGISTRY_DIR','TMUX_IDE_DAEMON_INFO_DIR','TMUX_TMPDIR']) await mkdir(env[key],{mode:0o700});
  const recordPath=path.join(env.TMUX_IDE_DAEMON_INFO_DIR,'daemon.json');
  assert.equal(await exists(recordPath),false);
  assert.equal(await exists(socketPath),false); assert.equal(await exists(alternateSocketPath),false); receipt.socketAbsentBefore=true;
  child=spawn(node,[cli,'--headless','--json'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  child.on('error',()=>{fatal='child spawn error';});
  child.stdout.on('error',()=>{fatal='stdout stream error';});
  child.stderr.on('error',()=>{fatal='stderr stream error';});
  child.stdout.on('data',b=>{stdoutBytes+=b.length;if(stdoutBytes>262144)fatal='stdout cap';});
  child.stderr.on('data',b=>{stderrBytes+=b.length; if(stderrBytes<=262144) stderrDiagnostic+=b.toString('utf8'); if(stderrBytes>262144)fatal='stderr cap';});
  // Never persist potentially credential-bearing child output or raw daemon record.
  receipt.childPid=child.pid;
  let record;
  const deadline=Date.now()+15000;
  while(Date.now()<deadline) {
    assert.ok(!fatal,fatal); assert.equal(child.exitCode,null,'owner exited before readiness'); assert.equal(child.signalCode,null);
    if(await exists(recordPath)) {
      const st=await lstat(recordPath); assert.ok(st.isFile()&&!st.isSymbolicLink()); assert.equal(st.uid,process.getuid()); assert.equal(st.mode&0o077,0); assert.ok(st.size<=16384);
      record=JSON.parse(await readFile(recordPath,'utf8')); break;
    }
    await new Promise(r=>setTimeout(r,50));
  }
  assert.ok(record,'private record readiness timeout');
  assert.equal(record.pid,child.pid); assert.equal(record.protocolVersion,3); assert.equal(record.bindHostname,'127.0.0.1'); assert.ok(Number.isInteger(record.port)&&record.port>0&&record.port<65536); assert.ok(typeof record.authToken==='string'&&record.authToken.length>0);
  authToken=record.authToken;
  const identity=await probe(record,'/identity');
  for(const key of ['pid','protocolVersion','instanceId','startedAt','environmentId','productVersion']) assert.equal(identity[key],record[key],`identity ${key}`);
  assert.equal(identity.ok,true);
  const health=await probe(record,'/health'); assert.equal(health.ok,true); assert.equal(health.protocolVersion,3); assert.equal(health.productVersion,record.productVersion);
  await probe(record,'/api/sessions',true);
  receipt.identity={pid:identity.pid,protocolVersion:identity.protocolVersion,productVersion:identity.productVersion,instanceId:identity.instanceId,environmentId:identity.environmentId,startedAt:identity.startedAt};
  receipt.authenticatedSessionsRead=true; receipt.publicIdentityAndHealth=true;
  assert.equal(await exists(socketPath),false,'unexpected tmux server creation');
  assert.ok(!fatal,fatal);
  receipt.passed=true;
} catch(e) { receipt.failure=String(e?.message??e).replaceAll(env.TMUX_IDE_CLEANUP_TOKEN,'[redacted]').replaceAll(authToken??'__absent_auth_token__','[redacted]').slice(0,1000); }
finally {
  try { await stopFixtureChild(child); assert.ok(!child||child.exitCode!==null||child.signalCode!==null,'owned child still running'); receipt.childExit={code:child?.exitCode,signal:child?.signalCode}; assert.equal(await exists(socketPath),false,'unexpected socket retained'); assert.equal(await exists(alternateSocketPath),false); receipt.socketAbsentAfter=true; receipt.cleanup=true; } catch(e) { receipt.cleanupFailure=String(e?.message??e).slice(0,500); }
  receipt.startupDiagnostic={codes:[...new Set(stderrDiagnostic.match(/\b(?:ERR_[A-Z_]+|MODULE_NOT_FOUND)\b/g)??[])], modules:[...stderrDiagnostic.matchAll(/Cannot find (?:package|module) ['"]([^'"]+)['"]/g)].map(m=>path.basename(m[1]).replace(/[^a-zA-Z0-9_.@-]/g,'').slice(0,120)), locations:[...stderrDiagnostic.matchAll(/(?:file:\/\/)?[^\s()]+\.(?:mjs|cjs|js|ts):[0-9]+(?::[0-9]+)?/g)].map(m=>path.basename(m[0])).filter(x=>/^[a-zA-Z0-9_.-]+:[0-9]+(?::[0-9]+)?$/.test(x)).slice(0,12)};
  receipt.stdoutBytes=stdoutBytes; receipt.stderrBytes=stderrBytes;
  receipt.cliSha256=await sha(cli); receipt.protectedCliUnchanged=protectedBefore===await sha(path.join(repo,'bin/cli.js'));
  if(receipt.cleanup) await rm(root,{recursive:true,force:true});
  await writeFile(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({output,passed:receipt.passed,cleanup:receipt.cleanup,protectedCliUnchanged:receipt.protectedCliUnchanged}));
  process.exitCode=receipt.passed&&receipt.cleanup&&receipt.protectedCliUnchanged?0:1;
}
