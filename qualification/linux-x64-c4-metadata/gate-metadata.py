import sys,json,pathlib
lane=pathlib.Path('/work/source/.tasks/components-linux/metadata');sys.path.insert(0,str(lane))
from metadata_gate import validate
summary=validate(json.loads((lane/'metadata-results.json').read_text())['runs'])
pathlib.Path('/evidence/metadata-summary.json').write_text(json.dumps(summary,indent=2))
