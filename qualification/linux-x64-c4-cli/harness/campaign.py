"""Draft bounded supervisor. Requires a separately reviewed frozen spec; no retries."""
import os,sys,json,time,subprocess,pathlib,hashlib
from cpu_accounting import total_cpu
HERE=pathlib.Path(__file__).resolve().parent
if sys.argv[1:2]!=['--approved-campaign'] or len(sys.argv)!=3:raise SystemExit('Expected --approved-campaign frozen-spec.json')
spec_bytes=pathlib.Path(sys.argv[2]).read_bytes()
spec=json.loads(spec_bytes)
# A full artifact/dependency freeze is mandatory, not just the CLI digest.
def verify():
 assert pathlib.Path(sys.argv[2]).read_bytes()==spec_bytes,'Frozen spec changed'
 subprocess.run([spec['node'],str(HERE/'verify.mjs'),sys.argv[2]],check=True,timeout=60)
 for name,digest in spec['closure'].items():
  assert hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest()==digest,('changed',name)
verify()
root=pathlib.Path(spec['output']);root.mkdir(mode=0o700)
orders=[['reference','disabled','enabled-no-reader','candidate32'],['candidate32','enabled-no-reader','disabled','reference'],['enabled-no-reader','reference','candidate32','disabled']]
if spec['lane']=='idle':orders=[['candidate32']]
def throttling():
 values=dict(line.split() for line in pathlib.Path('/sys/fs/cgroup/cpu.stat').read_text().splitlines())
 assert 'nr_throttled' in values and 'throttled_usec' in values
 return {key:int(values[key]) for key in ['nr_throttled','throttled_usec']}
results=[]
for round_number,order in enumerate(orders,1):
 for mode in order:
  case=dict(spec,mode=mode,output=str(root/f'{round_number}-{mode}'))
  if mode=='reference':case.update(binary=spec['referenceBinary'],binarySha256=spec['referenceSha256'])
  path=root/f'{round_number}-{mode}.json';path.write_text(json.dumps(case));os.chmod(path,0o600)
  log=open(root/f'{round_number}-{mode}.log','xb')
  throttle_before=throttling()
  child=subprocess.Popen([spec['node'],str(HERE/'case.mjs'),'--approved-case',str(path)],stdout=log,stderr=subprocess.STDOUT,start_new_session=True,env={'PATH':spec['systemPath'],'HOME':spec['cleanHome'],'LC_ALL':'C','TZ':'UTC'})
  deadline=time.monotonic()+(240 if spec['lane']=='idle' else 180)
  terminal=None;timedout=False
  while terminal is None:
   pid,status,usage=os.wait4(child.pid,os.WNOHANG)
   if pid:terminal=(status,usage);break
   if time.monotonic()>=deadline:
    timedout=True
    # Request fixture cancellation first; terminal result is never accepted after timeout.
    os.kill(child.pid,15)
    end=time.monotonic()+20
    while time.monotonic()<end:
     pid,status,usage=os.wait4(child.pid,os.WNOHANG)
     if pid:terminal=(status,usage);break
     time.sleep(.05)
    if terminal is None:
     os.killpg(child.pid,9)
     end=time.monotonic()+5
     while time.monotonic()<end:
      pid,status,usage=os.wait4(child.pid,os.WNOHANG)
      if pid:terminal=(status,usage);break
      time.sleep(.05)
    break
   time.sleep(.02)
  log.close()
  row={'mode':mode,'round':round_number,'timeout':timedout,'terminalKnown':terminal is not None}
  if terminal is not None:
   status,usage=terminal;child.returncode=os.waitstatus_to_exitcode(status)
   row.update(exit=child.returncode,fixtureInclusiveCpuSeconds=usage.ru_utime+usage.ru_stime)
  result_path=pathlib.Path(case['output'])/'result.json'
  if result_path.exists():
   data=json.loads(result_path.read_text());row['case']=data
   if terminal is not None and 'serverCpuSeconds' in data and 'orphanAppCpuSeconds' in data:
    own=data['fixtureSelfCpuSeconds'];assert row['fixtureInclusiveCpuSeconds']>=own
    row['totalCpuSeconds']=total_cpu(row['fixtureInclusiveCpuSeconds'],data)
  row['cgroupThrottling']={'before':throttle_before,'after':throttling()}
  results.append(row);(root/'results.json').write_text(json.dumps(results,indent=2))
  if timedout or terminal is None or child.returncode!=0 or not result_path.exists():raise SystemExit('Retained failed case; no retries. Inspect ownership/cleanup receipts.')
  assert row['cgroupThrottling']['before']==row['cgroupThrottling']['after'],'Cgroup CPU throttling invalidates quiet campaign'
  assert data['error'] is None and not any('error' in item for item in data['cleanup'])
verify()
(root/'verified-at-end.json').write_text(json.dumps(spec['closure'],indent=2))
if spec['lane']=='cpu':
 import statistics
 grouped={mode:[r for r in results if r['mode']==mode] for mode in orders[0]}
 assert all(len(rows)==3 for rows in grouped.values())
 med={mode:{'cpu':statistics.median(r['totalCpuSeconds'] for r in rows),'elapsed':statistics.median(r['case']['elapsedSeconds'] for r in rows)} for mode,rows in grouped.items()}
 baseline=med['disabled'];candidate=med['candidate32']
 assert baseline['cpu']>0 and baseline['elapsed']>0
 deltas={key:100*(candidate[key]/baseline[key]-1) for key in ('cpu','elapsed')}
 summary={'median':med,'candidatePercentOverDisabled':deltas,'passed':all(x<=10 for x in deltas.values()),'reference':'contextual only; native-grid lacks identity prefix','limits':'Same artifact whole daemon; fixture self subtracted, reaped descendant startup included, fresh orphan server and PTY app cumulative ps CPU included.'}
 (root/'summary.json').write_text(json.dumps(summary,indent=2))
 if not summary['passed']:raise SystemExit('Retained completed campaign fails unchanged10% CPU/elapsed gate')
