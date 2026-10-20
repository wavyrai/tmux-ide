import json,pathlib,statistics,collections
b=pathlib.Path(__file__).resolve().parent
r=json.loads((b/'quiet.json').read_text());s=json.loads((b/'quiet.json.stages.json').read_text())
assert r['passed'] and s['overflow']==0
pub=[x for x in s['records'] if x['kind']==0];drain=[x for x in s['records'] if x['kind']==1]
keys=['preludeUs','envelopeUs','stringifyUs','sizeUs','writeUs']
def summary(rows):
 return {'publications':len(rows),'bytes':sum(x['bytes'] for x in rows),'queued':sum(x['enqueued'] for x in rows),'stages':{k:{'sumUs':sum(x[k] for x in rows),'medianUs':statistics.median([x[k] for x in rows]) if rows else None,'maxUs':max([x[k] for x in rows],default=None)} for k in keys}}
result={'scope':'instrumented owned browser publication stages; synchronous elapsed times not CPU/utilization/flush/paint','wholeLifecycle':summary(pub),'byMeasuredRequest':{str(x['request']):summary([y for y in pub if y['request']==x['request']]) for x in r['switches']},'frameKinds':{str(k):summary([x for x in pub if x['frameKind']==k]) for k in [0,1,2]},'drainWrites':len(drain),'drainWriteSumUs':sum(x['writeUs'] for x in drain),'overflow':s['overflow']}
(b/'analysis.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result['wholeLifecycle'],indent=2))
