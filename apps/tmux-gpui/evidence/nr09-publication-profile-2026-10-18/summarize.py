"""Recompute the bounded summary from the retained receiver receipt; no runtime work."""
import collections
import json
from pathlib import Path

root = Path(__file__).resolve().parent
receipt = json.loads((root / 'quiet-profile.json').read_text())
summary = {
    'scope': 'one quiet receiver-profile A/B/A; not a benchmark, native render or CPU measurement',
    'passed': receipt['passed'],
    'cleanup': receipt['cleanup'],
    'hashesUnchanged': receipt['hashesUnchanged'],
    'observedProcessCount': receipt['observedProcessCount'],
    'switches': [],
}
for switch in receipt['switches']:
    rows = switch['profile']
    summary['switches'].append({
        'request': switch['request'],
        'envelopes': switch['publications'],
        'bytes': switch['bytes'],
        'retainedEnvelopes': switch['retainedFrames'],
        'uniqueSnapshotDigests': switch['uniqueSnapshotDigests'],
        'uniqueRetainedSnapshotDigests': len({row['snapshotDigest'] for row in rows if row['snapshotKind'] == 'retained'}),
        'classifications': switch['classifications'],
        'snapshotJsonBytes': sum(row['snapshotBytes'] for row in rows),
        'changedKeyCounts': dict(collections.Counter(key for row in rows[1:] for key in row['changedKeys'])),
    })
assert summary == json.loads((root / 'summary.json').read_text())
print(json.dumps(summary, indent=2))
