"""Bounded platform regression: Node reaps CPU-consuming grandchild; Python waits Node."""
import unittest,subprocess,os,time,json,signal
NODE='/opt/homebrew/Cellar/node/26.8.2/bin/node'
class Wait4Aggregation(unittest.TestCase):
 def test_reaped_grandchild_cpu_is_in_node_wait4(self):
  burn='import time,json\ns=time.process_time()\nwhile time.process_time()-s<0.12: pass\nprint(json.dumps({"burnCpu":time.process_time()-s}))'
  code='const {execFileSync}=require("node:child_process"); const grandchild=JSON.parse(execFileSync("/usr/bin/python3",["-c",'+json.dumps(burn)+'],{timeout:2000,encoding:"utf8"})); const self=process.cpuUsage();console.log(JSON.stringify({grandchild,selfCpu:(self.user+self.system)/1e6}));'
  child=subprocess.Popen([NODE,'-e',code],stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
  deadline=time.monotonic()+5;result=None
  try:
   while time.monotonic()<deadline:
    pid,status,usage=os.wait4(child.pid,os.WNOHANG)
    if pid:result=(status,usage);child.returncode=os.waitstatus_to_exitcode(status);break
    time.sleep(.005)
   self.assertIsNotNone(result,'bounded grandchild probe did not terminate')
   output,error=child.communicate(timeout=1)
   self.assertEqual(child.returncode,0,error)
   reported=json.loads(output);inclusive=result[1].ru_utime+result[1].ru_stime
   self.assertGreaterEqual(reported['grandchild']['burnCpu'],.12)
   # Without recursive reaped-child accounting this difference would be approximately zero.
   self.assertGreaterEqual(inclusive-reported['selfCpu'],.10)
   print(json.dumps({'wait4InclusiveCpu':inclusive,'nodeSelfCpu':reported['selfCpu'],'grandchildBurnCpu':reported['grandchild']['burnCpu'],'difference':inclusive-reported['selfCpu']}))
  finally:
   if child.returncode is None:
    os.killpg(child.pid,signal.SIGKILL)
    child.wait(timeout=2)
if __name__=='__main__':unittest.main()
