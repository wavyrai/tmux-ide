"""Verify frozen bytes and the current host; never start a workload."""
import json,pathlib,subprocess,sys,os
from binding import bind_runtime,sha

def verify(path):
 spec=json.loads(pathlib.Path(path).read_text());r=spec['admission']
 bind_runtime(r['root'],r['zip'],r['tar'],r['proof'],r['pins'],r['referenceRoot'],r.get('derivation'))
 for p,digest in spec['closure'].items():assert sha(p)==digest,('Changed frozen file',p)
 for p,target in spec['links'].items():assert os.readlink(p)==target and pathlib.Path(p).resolve(strict=True)==(pathlib.Path(p).parent/target).resolve(strict=True),('Changed link',p)
 host=json.loads(pathlib.Path(spec['hostReceipt']).read_text())
 def run(exe,args):return subprocess.check_output([exe,*args],text=True,timeout=10,env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','LC_ALL':'C','TZ':'UTC'}).strip()
 assert run('/usr/bin/uname',['-m'])=='x86_64'
 assert run('/usr/sbin/sysctl',['-n','kern.boottime'])==host['boot'],'Host boot changed'
 assert run('/usr/bin/sw_vers',[])==host['os'],'Host OS changed'
 assert run('/usr/sbin/sysctl',['-in','sysctl.proc_translated']) in ['', '0']
 for p,row in host['tools'].items():assert str(pathlib.Path(p).resolve())==row['resolved'] and sha(p)==row['sha256']
 for p,digest in host['mach']['files'].items():assert sha(p)==digest
 for p,row in host['mach']['systemFiles'].items():assert str(pathlib.Path(p).resolve())==row['resolved'] and sha(p)==row['sha256']
 for row in host['resolutions'].values():assert sha(row['path'])==row['sha256']
 return {'ok':True,'hostBoot':host['boot'],'runtimeMemberAdmission':True,'frozenFiles':len(spec['closure'])}
if __name__=='__main__':print(json.dumps(verify(sys.argv[1])))
