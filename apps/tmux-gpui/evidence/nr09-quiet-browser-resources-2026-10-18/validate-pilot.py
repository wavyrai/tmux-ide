import json
from pathlib import Path
root = Path(__file__).resolve().parent
summary = {'scope':'One instrumentation-validation pair only; not a comparative resource conclusion', 'runs':{}}
for variant in ['baseline','candidate']:
    r=json.loads((root/f'pilot-{variant}.json').read_text())
    assert r['passed'] and r['cleanup'] and r['hashesUnchanged'] and r['inputVerified'] and r['sourcePreserved']
    p=r['resourceProfile'];s=p['samples'];assert p['failure'] is None and len(s)>11
    assert len({(x['pid'],x['ppid'],x['start']) for x in s})==1
    assert all(x['afterMs']>=x['beforeMs']>=x['requestedMs'] for x in s)
    assert all(b['beforeMs']>=a['afterMs'] and b['cpuSeconds']>=a['cpuSeconds'] for a,b in zip(s,s[1:]))
    boundaries={x['label']:x for x in s if x['label']!='periodic'}
    events={x['label']:x['atMs'] for x in p['events']}
    spans=[]
    for n in [1,2,3]:
        a=boundaries[f'switch-{n}-before-command'];b=boundaries[f'switch-{n}-after-ready']
        assert a['afterMs']<=events[f'switch-{n}-command-write']<events[f'switch-{n}-ready-publication']<=b['beforeMs']
        spans.append(round(b['cpuSeconds']-a['cpuSeconds'],2))
    a=boundaries['quiet-window-start'];b=boundaries['quiet-window-end']
    assert a['afterMs']<=events['quiet-window-clock-start']<events['switch-1-command-write']<events['switch-3-ready-publication']<=events['quiet-window-clock-end']<=b['beforeMs']
    assert r['quietWindow']['sourceUnchanged'] and not r['quietWindow']['producerStarted']
    assert 10000<=r['quietWindow']['actualClockDurationMs']<11000
    summary['runs'][variant]={'samples':len(s),'cpuDisplayQuantumSeconds':sorted({x['displayQuantumSeconds'] for x in s}),'switchBoundaryCpuSeconds':spans,'quietBoundaryCpuSeconds':round(b['cpuSeconds']-a['cpuSeconds'],2),'quietClockDurationMs':r['quietWindow']['actualClockDurationMs'],'sampleStartToStartMs':b['beforeMs']-a['beforeMs'],'resourceIntervalLowerMs':b['beforeMs']-a['afterMs'],'resourceIntervalUpperMs':b['afterMs']-a['beforeMs'],'quietWindowSampledRssMaxKiB':max(x['rssKiB'] for x in s if x['beforeMs']>=a['beforeMs'] and x['afterMs']<=b['afterMs']),'sampledRssMaxKiB':max(x['rssKiB'] for x in s),'maxPsCallMs':max(x['afterMs']-x['beforeMs'] for x in s),'maxQueueDelayMs':max(x['beforeMs']-x['requestedMs'] for x in s),'maxInterSampleGapMs':max(b['beforeMs']-a['afterMs'] for a,b in zip(s,s[1:])),'valid':True}
(root/'pilot-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary,indent=2))
