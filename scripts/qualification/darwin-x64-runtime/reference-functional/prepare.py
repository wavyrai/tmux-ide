"""Stage the existing four reference grid cases externally; no execution."""
import pathlib,json,hashlib,shutil
HERE=pathlib.Path(__file__).resolve().parent

def sha(p):return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def once(s,a,b):assert s.count(a)==1,('Source seam changed',a);return s.replace(a,b)
def prepare(binding,output):
 p=binding['paths'];output=pathlib.Path(output).resolve();assert not output.exists();output.mkdir(mode=0o700)
 source=pathlib.Path(p['source']);test=source/'packages/daemon/src/terminal/mirror/native-frozen-grid-live.test.ts'
 expected=json.loads((HERE/'pins.json').read_text());assert sha(test)==expected['testSourceSha256']
 for name in ['receipts','temp','home','cache']:(output/name).mkdir(mode=0o700)
 (output/'node_modules').symlink_to(source/'node_modules',target_is_directory=True)
 s=test.read_text();s="import {createReferenceOwner} from './reference-owner.mjs';\n"+s
 for name in ['native-grid-capture.ts','native-frozen-grid.ts','native-grid-projection.ts']:s=s.replace('"./'+name+'"',json.dumps(str(test.parent/name)))
 start=s.index('    const tmux = (...args: string[]) =>');end=s.index('    try {',start)
 s=s[:start]+"    const owner = createReferenceOwner(executable!, socket, directory);\n    const tmux = owner.tmux;\n"+s[end:]
 start=s.index('      spawnSync(executable!, ["-S", socket, "kill-server"]');end=s.index('      rmSync(directory',start)
 s=s[:start]+'      await owner.cleanup();\n'+s[end:]
 s=once(s,'      rmSync(directory, { recursive: true, force: true });','      // Preserve the private fixture and any lingering socket pathname for audit; never remove a replacement owner.')
 (output/'reference-grid-live.test.ts').write_text(s)
 for name in ['reference-owner.mjs','cleanup.mjs']:
  text=(HERE/(name+'.in')).read_text()
  for key,value in {'__SOURCE__':str(source),'__REFERENCE__':p['reference'],'__REFERENCE_SHA__':sha(p['reference']),'__RECEIPTS__':str(output/'receipts')}.items():
   assert "'" not in value and '\n' not in value;text=text.replace(key,value)
  (output/name).write_text(text)
 shutil.copyfile(HERE/'process-cpu.mjs',output/'process-cpu.mjs')
 config={'root':str(output),'cacheDir':str(output/'cache'),'test':{'environment':'node','maxWorkers':1,'include':['reference-grid-live.test.ts']}}
 (output/'vitest.config.mjs').write_text('export default '+json.dumps(config)+';\n')
 return {'testSourceSha256':sha(test),'referenceSha256':sha(p['reference']),'output':str(output),'expectedTests':4,'executionAuthorized':False,'files':{x.name:sha(x) for x in output.iterdir() if x.is_file()}}
