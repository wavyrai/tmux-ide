"""Deterministic path-only adapter for accepted Mac coherence overlays; no workload execution."""
import pathlib,json,hashlib
HERE=pathlib.Path(__file__).resolve().parent

def sha(p):return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def once(text,old,new):
 assert text.count(old)==1,('Closed source seam changed',old)
 return text.replace(old,new)

def adapt_attach(text):
 text="import {createAttachDiagnostics,clientFormat} from './attach-diagnostics.mjs';\n"+text
 text=once(text,'    let ptyExited = false;','    let ptyExited = false;\n    const attachDiagnostics = createAttachDiagnostics();')
 text=once(text,'          onData: () => undefined,','          onData: (chunk) => attachDiagnostics.data(chunk),')
 text=once(text,'          onExit: () => {\n            ptyExited = true;','          onExit: (event) => {\n            attachDiagnostics.exited(event);\n            ptyExited = true;')
 text=once(text,'      const slowBaseline = decoders.at(-1)!.commits;',"""      await waitFor("owned PTY attachment", () => attachDiagnostics.observe(
        tmux("list-clients", "-F", clientFormat),
        {pid: pty!.pid, session, cols: 100, rows: 30},
      ), errors);
      const slowBaseline = decoders.at(-1)!.commits;""")
 text=once(text,'    } finally {\n      if (!fleet && allocation)','    } finally {\n      attachDiagnostics.cleanupStarted();\n      if (!fleet && allocation)')
 text=once(text,'      const report = {',"""      try {
        writeFileSync(join(output, `clients-${count}-attach.json`), JSON.stringify(attachDiagnostics.snapshot(), null, 2), {flag: "wx", mode: 0o600});
      } catch (error) { errors.push(error as Error); }
      const report = {""")
 return text

def stage(binding,mode,output):
 assert mode in ['native','stock']
 p=binding['paths'];output=pathlib.Path(output).resolve();assert not output.exists();output.mkdir(mode=0o700)
 accepted=json.loads((HERE/'accepted-sources.json').read_text())[mode]
 for name,row in accepted.items():
  original=HERE/'accepted'/mode/name;assert sha(original)==row['sha256']
  text=original.read_text()
  if name=='coherence-canonical.ts':text=adapt_attach(text)
  if name=='daemon.ts':
   old='"/Users/thijs/Developer/tmux-ide/.tasks/current-native-coherence-progress-66eb424f9e054d108e3c801cd415f9ec/source"'
   text=once(text,old,json.dumps(p['source']))
  if name=='owned-harness.mjs':
   old='"/Users/thijs/Developer/tmux-ide/.tasks/current-native-coherence-progress-66eb424f9e054d108e3c801cd415f9ec/source/scripts/lib/owned-ssh-fixture.mjs"'
   text=once(text,old,'"./source/scripts/lib/owned-ssh-fixture.mjs"')
  if name=='admission.mjs' and mode=='stock':
   text=once(text,'"/opt/homebrew/Cellar/tmux/3.7c/bin/tmux"',json.dumps(p['stock']))
  (output/name).write_text(text)
 (output/'package.json').write_text(json.dumps({'type':'module'})+'\n')
 for name in ['supervise.mjs','retire-server.mjs','attach-diagnostics.mjs']:(output/name).write_bytes((HERE/name).read_bytes())
 (output/'source').symlink_to(p['source'],target_is_directory=True)
 for name in ['home','temp','pinned-bin']:(output/name).mkdir(mode=0o700)
 binary=p[mode];(output/'pinned-bin/tmux').symlink_to(binary);(output/'pinned-bin/node').symlink_to(p['node'])
 closure=output/'bound-inputs.json';closure.write_text(json.dumps(binding,sort_keys=True))
 files={str(x):sha(x) for x in output.iterdir() if x.is_file()}
 d={'version':1,'mode':'native-enabled' if mode=='native' else 'stock-observation-off','source':p['source'],'commit':binding['sourceCommit'],'tree':binding['sourceTree'],'cli':p['cli'],'cliSha256':sha(p['cli']),'native':binary,'nativeSha256':sha(binary),'componentClosure':str(closure),'componentClosureSha256':sha(closure),'node':str(pathlib.Path(p['node']).resolve()),'overlay':files,'nativeObservation':'enabled' if mode=='native' else 'disabled','workload':{'clients':[2,4,8],'records':500,'resizes':20,'stalledConsumers':1},'performanceClaim':False}
 (output/'admission.json').write_text(json.dumps(d,indent=2));(output/'admission.json').chmod(0o600)
 tsx=pathlib.Path(p['source'])/'node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/loader.mjs';assert tsx.is_file()
 return {'cwd':p['source'],'argv':[p['node'],'--import',str(tsx),str(output/'coherence-canonical.ts'),str(output/'results'),str(output/'admission.json')],'environment':{'HOME':str(output/'home'),'TMPDIR':str(output/'temp'),'PATH':str(output/'pinned-bin')+':/usr/bin:/bin:/usr/sbin:/sbin','LC_ALL':'C','TZ':'UTC'},'mode':mode,'descriptorSha256':sha(output/'admission.json'),'executionAuthorized':False}
