from metadata_stream import MetadataStream
from bounded_io import readline,wait4,prove_absent,retire_socket
from owned_cleanup import cleanup_owned
import os,sys,time,tempfile,subprocess,json,re,resource,statistics,hashlib,shutil
B='/private/tmp/tmux-ide-native-arm-888c15d4/.tasks/qualification/bundle/tmux'
N=1500
if sys.argv[1:] != ['--approved-metadata']:raise SystemExit('Expected reviewed --approved-metadata command')
from cpu_diagnostics import readiness_diagnostics, descendant_snapshot
from pathlib import Path
HERE=Path(__file__).resolve().parent
def verify_sources(destination):
 subprocess.run(['/opt/homebrew/Cellar/node/26.8.2/bin/node',str(HERE/'verify.mjs')],check=True)
 manifest=json.loads((HERE/'source-at-prepare.json').read_text())
 for path,digest in manifest['hashes'].items():
  assert hashlib.sha256(Path(path).read_bytes()).hexdigest()==digest,('source changed',path)
 (HERE/destination).write_text(json.dumps(manifest,indent=2))
if (HERE/'metadata-results.json').exists():raise SystemExit('Refusing to overwrite existing measurement results')
verify_sources('metadata-source-at-start.json')
reference=json.loads((HERE/'reference.json').read_text())
assert hashlib.sha256(Path(reference['binary']).read_bytes()).hexdigest()==reference['sha256']
INSTRUMENTED=B
out=[]
def cpu(pid):
 s=subprocess.check_output(['ps','-o','time=','-p',str(pid)],text=True,timeout=5).strip();m,s=s.split(':');return int(m)*60+float(s)
def childcpu():
 r=resource.getrusage(resource.RUSAGE_CHILDREN);return r.ru_utime+r.ru_stime
orders=[['candidate-0','candidate-16','candidate-32'],['candidate-32','candidate-16','candidate-0'],['candidate-16','candidate-0','candidate-32']]
for round in range(3):
 for mode in orders[round]:
  B=reference['binary'] if mode=='reference' else INSTRUMENTED
  root=tempfile.mkdtemp(prefix='tmux-attribution-perf-');socket=root+'/owned.sock';reader=None;ready=None;ready_descendants=None;ready_elapsed=None
  app=root+'/app.py';open(app,'w').write('import os,tty\ntty.setraw(0)\nn=0\nos.write(1,b"\\x1b[2J\\x1b[HCOUNT:0")\nwhile True:\n b=os.read(0,4096)\n assert all(c==120 for c in b)\n n+=len(b)\n os.write(1,("\\x1b[H\\x1b[2KCOUNT:"+str(n)).encode())\n')
  def run(*args):return subprocess.check_output([B,'-u','-S',socket,*args],text=True,stderr=subprocess.PIPE,timeout=5)
  row=None;failure=None;pid=None;start=None;descendants=set();socket_witness=None
  try:
   run('-f','/dev/null','new-session','-d','-s','probe','python3 '+app)
   socket_stat=os.lstat(socket);socket_witness=(socket_stat.st_dev,socket_stat.st_ino,socket_stat.st_uid)
   pid,start=run('display-message','-p','#{pid}\t#{start_time}').strip().split('\t')
   descendants.update(p['pid'] for p in descendant_snapshot(int(pid))['processes'])
   for _ in range(100):
    if 'COUNT:0' in run('capture-pane','-p','-t','probe'):break
    time.sleep(.01)
   else:raise Exception('app not ready')
   if mode.startswith(('baseline-','candidate-')):
    spawned_at=time.perf_counter()
    reader=subprocess.Popen(['/opt/homebrew/Cellar/node/26.8.2/bin/node',str(HERE/(mode.split('-')[0]+'.mjs')),B,socket,pid,start,mode.split('-')[1],'latency'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=open(root+'/reader.err','w'),text=True)
    telemetry=MetadataStream(reader.stdout)
    ready=telemetry.reply();assert ready['ready']
    ready_elapsed=time.perf_counter()-spawned_at
    ready_descendants=descendant_snapshot(reader.pid)
    descendants.update(p['pid'] for p in ready_descendants['processes'])
   elif mode=='enabled':run('tmux-ide-events','-e')
   server0=cpu(pid);children0=childcpu();t0=time.perf_counter();prev=0
   for i in range(N):
    capture=run('send-keys','-t','probe','-l','x',';','capture-pane','-p','-t','probe')
    match=re.search(r'COUNT:(\d+)',capture);assert match,capture
    count=int(match[1]);assert prev<=count<=i+1,(prev,count,i);prev=count
   elapsed=time.perf_counter()-t0;workcpu=childcpu()-children0
   # final verification capture adds one command+effect in enabled modes.
   for _ in range(100):
    capture=run('capture-pane','-p','-t','probe');count=int(re.search(r'COUNT:(\d+)',capture)[1])
    if count==N:break
    time.sleep(.01)
   assert count==N,(count,N)
   servercpu=cpu(pid)-server0;reader_cpu=0;stats=None
   if reader:
    for _ in range(100):
     reader.stdin.write('stats\n');reader.stdin.flush();stats=telemetry.reply()
     if stats['records']>=4*N+2:break
     time.sleep(.02)
    assert stats['records']==4*N+2,stats
    assert stats['kinds']['1']==N and stats['kinds']['5']==N and stats['kinds']['2']==N+1 and stats['kinds']['6']==N+1 and stats['gaps']==0,stats
    descendants.update(p['pid'] for p in descendant_snapshot(reader.pid)['processes'])
    reader.stdin.write('stop\n');reader.stdin.flush();stats=telemetry.reply()
    _,status,usage=wait4(reader.pid);reader.returncode=os.waitstatus_to_exitcode(status);assert reader.returncode==0
    reader_cpu=usage.ru_utime+usage.ru_stime
    assert stats['enricherPending']==0 and stats['retained']==256 and stats['journalCursor']==2*N+1 and stats['published']==2*N+1 and stats['last']==str(4*N+2),stats
   elif mode=='enabled':
    cap=json.loads(run('tmux-ide-events','-V'));batch=json.loads(run('tmux-ide-events','-r','-E',cap['journalEpoch'],'-a','0','-n','64'))
    assert int(batch['newest'])==4*N+2,batch
    assert batch['gap'] is not None if 4*N+2>4096 else batch['gap'] is None
   row=dict(binary=B,binary_sha256=hashlib.sha256(Path(B).read_bytes()).hexdigest(),round=round+1,mode=mode,n=N,elapsed=elapsed,workload_cpu=workcpu,server_cpu=servercpu,reader_cpu_including_startup=reader_cpu,total_cpu=workcpu+servercpu+reader_cpu,count=count,stats=stats)
   telemetry.finish()
   assert len(telemetry.latencies)==4*N+2
   assert all(sample['milliseconds']>=0 for sample in telemetry.latencies),'Clock domain mismatch or invalid native timestamp'
   assert sum(sample['kind']<=4 for sample in telemetry.latencies)==2*N+1
   row['latency_samples']=telemetry.latencies;row['batch_period_ms']=telemetry.periods;row['observed_batches']=telemetry.batches
   row['diagnosticOnlyCpu']=True
   row['cpu_diagnostics']=readiness_diagnostics(ready,stats,reader_cpu,ready_elapsed,ready_descendants) if reader else None
  except BaseException as exc:
   failure=repr(exc)
  finally:
   cleanup=cleanup_owned(reader,run,pid,start,socket)
   try:
    prove_absent(([pid] if pid is not None else [])+list(descendants)+([reader.pid] if reader else []))
    retire_socket(socket,socket_witness)
    cleanup.append({'absenceProved':True,'descendantPids':sorted(descendants)})
   except BaseException as error:cleanup.append({'error':'retirement absence uncertain: '+repr(error)})
   if row is None:row=dict(round=round+1,mode=mode,n=N,binary=B)
   row.update(error=failure,cleanup=cleanup)
   out.append(row)
   open(HERE/'metadata-results.json','w').write(json.dumps(dict(binary=B,sha256=hashlib.sha256(open(B,'rb').read()).hexdigest(),runs=out),indent=2))
   print(json.dumps({k:v for k,v in row.items() if k not in ['latency_samples','batch_period_ms']}),flush=True)
   if failure or any('error' in item for item in cleanup):raise SystemExit('Retained failed run or cleanup')
   shutil.rmtree(root)

verify_sources("metadata-source-at-end.json")
