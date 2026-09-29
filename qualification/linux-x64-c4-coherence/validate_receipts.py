import json
from coherence_contract import validate_report
def validate_campaign_receipts(e):
 r=json.loads((e/'coherence-lane-result.json').read_text());assert r['exit']==0 and r['postClosurePassed'] is True and r['performanceQualified'] is False
 assert json.loads((e/'pre-closure.json').read_text())['passed'] is True
 assert json.loads((e/'post-closure.json').read_text())['passed'] is True
 for lane in ['native','stock']:
  status=json.loads((e/(lane+'-status.json')).read_text());assert status['exit']==0 and not status['truncated']
  report=json.loads((e/lane/'report.json').read_text());assert (e/lane/'complete.json').is_file()
  assert validate_report(report,lane)==json.loads((e/(lane+'-gate.json')).read_text())
 assert (e/'fresh-process-host.json').is_file() and (e/'runtime-binding.json').is_file()
