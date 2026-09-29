"""Actual bounded wait4-grandchild regression; no tmux or acceptance measurement."""
import subprocess,sys,json,time,os,signal
node=sys.argv[1];burn='import time,json\ns=time.process_time()\nwhile time.process_time()-s<0.12: pass\nprint(json.dumps({"burnCpu":time.process_time()-s}))'
code='const {execFileSync}=require("node:child_process");const grandchild=JSON.parse(execFileSync("/usr/bin/python3",["-c",'+json.dumps(burn)+'],{timeout:2000,encoding:"utf8"}));const self=process.cpuUsage();console.log(JSON.stringify({grandchild,selfCpu:(self.user+self.system)/1e6}));'
p=subprocess.Popen([node,'-e',code],stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True);deadline=time.monotonic()+5;usage=None
try:
 while time.monotonic()<deadline:
  pid,status,r=os.wait4(p.pid,os.WNOHANG)
  if pid:p.returncode=os.waitstatus_to_exitcode(status);usage=r;break
  time.sleep(.005)
 assert usage is not None
 out,err=p.communicate(timeout=1);assert p.returncode==0,err
 result=json.loads(out);inclusive=usage.ru_utime+usage.ru_stime;assert result['grandchild']['burnCpu']>=.12 and inclusive-result['selfCpu']>=.1
 print(json.dumps({'passed':True,'node':node,'wait4InclusiveCpu':inclusive,'nodeSelfCpu':result['selfCpu'],'grandchildBurnCpu':result['grandchild']['burnCpu'],'difference':inclusive-result['selfCpu']}))
finally:
 if p.returncode is None:os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=2)
