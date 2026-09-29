"""Original idle gates, adapted only to the x64 environment receipt schema."""
import json,pathlib

def validate(root):
 root=pathlib.Path(root);result=root/'results-idle';rows=json.loads((result/'results.json').read_text());assert len(rows)==1
 row=rows[0];assert row['mode']=='candidate32' and row['round']==1
 assert row['exit']==0 and row['timeout'] is False and row['terminalKnown'] is True
 assert row['cgroupThrottling']['before']==row['cgroupThrottling']['after']
 for p in sorted(root.glob('cpu-environment-*.json')):
  e=json.loads(p.read_text());assert e['topology']['affinity']==[0,2] and e['topology']['passed'] is True
 assert len(list(root.glob('cpu-environment-*.json')))==2
 case=row['case'];assert case['error'] is None and not any('error' in c for c in case['cleanup'])
 assert case['count']==2 and case['counts']=={'pairs':2,'externalEffects':4,'backgroundEvidence':2,'totalEvidence':6}
 assert len(case['evidence'])==6 and case['status']['cursor']['sequence']=='12'
 assert case['idleSeconds']>=125 and len(case['idleSamples'])==26 and case['elapsedSeconds']<=0.1
 assert all(s['status']==case['idleSamples'][0]['status'] for s in case['idleSamples'])
 assert case['trace']['producerStarts']==1
 assert not any('tmux-ide-events' in arg for row in case['trace']['idleAttempts'] for arg in row['argv'])
 assert (result/'verified-at-end.json').is_file()
 return {'idleReceiptPassed':True,'seededSeconds':case['idleSeconds'],'samples':26,'wakeSeconds':case['elapsedSeconds'],'effects':6,'cursor':'12'}
