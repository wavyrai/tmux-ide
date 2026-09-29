"""Pure supervisor accounting, same witnesses as the reviewed JS process adapter."""
import math
def total_cpu(inclusive, data):
    own=data['fixtureSelfCpuSeconds'];assert all(isinstance(x,(int,float)) and math.isfinite(x) and x>=0 for x in [inclusive,own]);assert inclusive>=own
    server,app=data['serverSample'],data['orphanAppSample']
    proof=data['accountingOwnership'];assert proof['containerInit'] is True and proof['serverParent']==1 and proof['appParent']==server['pid'] and proof['daemonParent']==proof['fixturePid']
    assert proof['daemonPid'] not in [server['pid'],app['pid']]
    for sample in [server,app]:
        assert sample['platform']=='linux' and sample['status']=='present' and sample['alive'] is True
        assert sample['startIdentity'] and sample['pid']>0 and math.isfinite(sample['cpuSeconds']) and sample['cpuSeconds']>=0
        assert sample['startIdentity'] not in data['reapedIdentities']
    assert server['pid']!=app['pid'] and server['startIdentity']!=app['startIdentity']
    assert data['serverCpuSeconds']==server['cpuSeconds'] and data['orphanAppCpuSeconds']==app['cpuSeconds']
    return inclusive-own+server['cpuSeconds']+app['cpuSeconds']
