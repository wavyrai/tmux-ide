"""Read-only admission inside a --cgroupns=host container; no affinity mutation."""
import pathlib,os,json,sys

def cpus(value):
 result=set()
 for part in value.strip().split(','):
  if not part:continue
  bounds=part.split('-');a=int(bounds[0]);b=int(bounds[-1]);assert 0<=a<=b
  result.update(range(a,b+1))
 return result

def admit(expected):
 assert os.uname().machine=='x86_64'
 selected=cpus(expected);assert len(selected)==2
 assert set(os.sched_getaffinity(0))==selected,'CPU affinity differs from reviewed two-CPU topology'
 identities=[]
 for cpu in sorted(selected):
  t=pathlib.Path('/sys/devices/system/cpu')/('cpu'+str(cpu))/'topology'
  identities.append((int((t/'physical_package_id').read_text()),int((t/'core_id').read_text())))
 assert len(set(identities))==2,'Selected logical CPUs share one physical core'
 raw=pathlib.Path('/proc/self/cgroup').read_text().strip();assert raw.startswith('0::/') and '\n' not in raw
 relative=pathlib.PurePosixPath(raw[3:]);assert '..' not in relative.parts
 root=pathlib.Path('/sys/fs/cgroup');current=root.joinpath(*relative.parts[1:]);rows=[]
 while True:
  p=current/'cpu.max'
  if p.exists():
   value=p.read_text().strip();assert value.split()[0]=='max','CFS quota on '+str(p)
  else:
   assert current==root,'Missing ancestor cpu.max';value=None
  rows.append({'path':str(current),'cpuMax':value})
  if current==root:break
  current=current.parent
 effective=(root.joinpath(*relative.parts[1:])/'cpuset.cpus.effective').read_text().strip()
 assert cpus(effective)==selected,'Effective cpuset differs from reviewed topology'
 return {'passed':True,'cgroupPath':raw,'affinity':sorted(selected),'physicalCores':identities,'effectiveCpuset':effective,'ancestors':rows,'coTenancyNotProven':True}
if __name__=='__main__':print(json.dumps(admit(sys.argv[1])))
