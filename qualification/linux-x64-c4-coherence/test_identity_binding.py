"""Exercise actual x64 identity adapter against the Python-produced fresh binding."""
import json,subprocess,unittest
from fresh_process_host import bind
class ActualAdmission(unittest.TestCase):
 def test_fresh_binding_and_valid_looking_stale_boot_clock(self):
  receipt={'processHost':{'bootId':'old-build-host'},'tools':{'/usr/bin/getconf':{'sha256':'a'*64}}}
  observed={'platform':'linux','arch':'x64','bootId':'12345678-1234-1234-1234-123456789abc','clockTicksPerSecond':100,'getconf':{'path':'/usr/bin/getconf','sha256':'a'*64}}
  descriptor=bind(receipt,observed,'b'*64)['processHost']
  script='''import assert from 'node:assert/strict';
import {createLinuxProcessIdentity} from 'file:///private/tmp/tmux-ide-linux-x64-c4-coherence-preparation/qualification/linux-x64-c4-coherence-preparation/port/linux-identity.mjs';
const descriptor=DESCRIPTOR;
const io={platform:'linux',arch:'x64',read:async path=>{assert.equal(path,'/proc/sys/kernel/random/boot_id');return descriptor.bootId;},execute:async(path,args)=>{assert.equal(path,'/usr/bin/getconf');assert.deepEqual(args,['CLK_TCK']);return {stdout:'100\\n'};}};
await createLinuxProcessIdentity({descriptor},io);
await assert.rejects(createLinuxProcessIdentity({descriptor},{...io,read:async()=> '22345678-1234-1234-1234-123456789abc'}));
await assert.rejects(createLinuxProcessIdentity({descriptor},{...io,execute:async()=>({stdout:'250\\n'})}));
'''.replace('DESCRIPTOR',json.dumps(descriptor))
  subprocess.run(['/opt/homebrew/Cellar/node/26.8.2/bin/node','--input-type=module','-'],input=script,text=True,check=True,capture_output=True,timeout=10)
if __name__=='__main__':unittest.main()
