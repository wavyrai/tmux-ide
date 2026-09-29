import sys,json,pathlib
from parser_gate import validate
root=pathlib.Path('/evidence/parser-results')
summary=validate(json.loads((root/'report.json').read_text())['runs'])
pathlib.Path('/evidence/parser-summary.json').write_text(json.dumps(summary,indent=2))
