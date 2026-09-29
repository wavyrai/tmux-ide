import sys,json,pathlib
lane=pathlib.Path('/work/source/.tasks/components-linux/tail');sys.path.insert(0,str(lane))
from tail_gate import validate
summary=validate(json.loads((lane/'tail-backlog-results.json').read_text())['runs'])
pathlib.Path('/evidence/tail-backlog-summary.json').write_text(json.dumps(summary,indent=2))
