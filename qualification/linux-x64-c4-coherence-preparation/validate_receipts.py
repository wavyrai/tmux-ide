import json,hashlib
def validate_preparation_receipts(root):
    e=root;r=json.loads((e/'coherence-build-result.json').read_text())
    assert r['exit']==0 and r['postClosurePassed'] is True and r['performanceQualified'] is False
    artifact=json.loads((e/'coherence-receipt.json').read_text());assert artifact['fixturesStarted'] is False and artifact['originalClosureUnchanged'] is True and artifact['source']['commit']=='be8bcfad29610265716b8dcb657658cf8f1d0ba3'
    assert artifact['stock']['patches']==[] and len(artifact['buildInputs'])>400 and len(artifact['closure'])>4000
    proof=json.loads((e/'payload-proof.json').read_text());assert proof['roundtripVerified'] is True and proof['gitIncluded'] is True and proof['members']==len(proof['ledger'])
    archive=json.loads((e/'coherence-archive.json').read_text());assert archive['roundtripVerified'] is True and (e/'coherence-runtime.tar').stat().st_size==archive['bytes']
    with (e/'coherence-runtime.tar').open('rb') as f:assert hashlib.file_digest(f,'sha256').hexdigest()==archive['sha256']
    for stage in ['coherence-import','coherence-tests','cli-build','cli-version','source-clean-after-build','source-self-contained','stock-autogen','stock-configure','stock-build','stock-version','coherence-collect']:
        s=json.loads((e/(stage+'-status.json')).read_text());assert s['exit']==0 and not s['truncated']
