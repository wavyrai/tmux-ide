"""Exact host-namespace cgroup/ancestor admission; no workload or budget changes."""
import json,os,pathlib,time
from admit_topology import admit
P=pathlib.Path

def snapshot(root=P('/sys/fs/cgroup'),raw=None):
 raw=P('/proc/self/cgroup').read_text().strip() if raw is None else raw
 assert raw.startswith('0::/') and '\n' not in raw
 relative=P(raw[3:]);assert '..' not in relative.parts
 current=root.joinpath(*relative.parts[1:]);rows=[]
 while True:
  quota=current/'cpu.max'
  value=quota.read_text().strip() if quota.exists() else None
  assert (value is None and current==root) or (value is not None and value.split()[0]=='max'),'CPU quota or missing controller: '+str(current)
  values=dict(line.split() for line in (current/'cpu.stat').read_text().splitlines())
  counters={k:int(values[k]) for k in ['nr_throttled','throttled_usec'] if k in values}
  if value is not None:assert len(counters)==2
  rows.append({'path':str(current),'inode':current.stat().st_ino,'cpuMax':value,'throttling':counters})
  if current==root:break
  current=current.parent
 return {'cgroup':raw,'ancestors':rows}

def capture(destination):
 topology=admit('0,2');value=snapshot()
 assert value['cgroup']==topology['cgroupPath']
 record={'monotonic':time.monotonic(),'topology':topology,'cgroup':value,'loadavg':P('/proc/loadavg').read_text(),'cpuPressure':P('/proc/pressure/cpu').read_text(),'cpuStat':[x for x in P('/proc/stat').read_text().splitlines() if x.startswith('cpu')]}
 P(destination).write_text(json.dumps(record,indent=2));return value
