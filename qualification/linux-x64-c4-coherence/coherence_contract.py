"""Fixed source and modes for the accepted coherence fixture; no test bypasses."""
import pathlib
SOURCE='/work/current/source'
COMMIT='be8bcfad29610265716b8dcb657658cf8f1d0ba3'
TREE='4dec271c1d435c2ceaa147441538cc188294039c'
CLI=SOURCE+'/.tasks/coherence-cli/cli.mjs'
NATIVE='/work/native/tmux'
STOCK='/work/current/stock/tmux'

def admission(receipt,lane,receipt_hash,fresh_binding):
 assert fresh_binding['archiveReceiptSha256']==receipt_hash
 assert lane in ('native','stock')
 assert receipt['source']['commit']==COMMIT and receipt['source']['tree']==TREE
 assert receipt['cli']==CLI and receipt['originalClosureUnchanged'] is True
 assert receipt['stock']['patches']==[]
 binary=NATIVE if lane=='native' else STOCK
 assert receipt['closure'][binary]==(receipt['stock']['binarySha256'] if lane=='stock' else '8933071dbaeea131b04961ab74ff8b21a622891bce6a01f43ef5122e2fad14d2')
 overlay={p:h for p,h in receipt['closure'].items() if p.startswith('/work/current/coherence/')}
 assert len(overlay)>10
 return {'version':1,'mode':'native-enabled' if lane=='native' else 'stock-observation-off','nativeObservation':'enabled' if lane=='native' else 'disabled','source':SOURCE,'commit':COMMIT,'tree':TREE,'node':'/opt/node26/bin/node','cli':CLI,'cliSha256':receipt['cliSha256'],'native':binary,'nativeSha256':receipt['closure'][binary],'componentClosure':'/inputs/coherence-receipt.json','componentClosureSha256':receipt_hash,'overlay':overlay,'processHost':fresh_binding['processHost']}

def validate_report(report,lane):
 assert report['completed'] is True and report['failure'] is None
 manifest=report['manifest'];assert manifest['records']==500 and manifest['clients']==[2,4,8]
 assert manifest['shapes']==[[80+i*2,25+i%7] for i in range(20)]
 assert manifest['source']==COMMIT and manifest['provenance']['commit']==COMMIT and manifest['provenance']['tree']==TREE and manifest['provenance']['dirty']==''
 results=report['results'];assert [r['count'] for r in results]==[2,4,8]
 for r in results:
  assert r['failures']==[] and r['facts']['records']==500 and r['facts']['count']==r['count']
  assert r['cleanup']=={'observation':'confirmed','pty':'confirmed','daemon':'confirmed','server':'confirmed'}
  assert len(r['facts']['hashes'])==r['count'] and len(set(r['facts']['hashes']))==1
  if lane=='stock':assert r['facts']['mode']=='stock-observation-off' and r['facts']['oracleScope']=='finite-producer-stock-visible-semantics'
 return {'lane':lane,'clients':[2,4,8],'recordsPerCase':500,'resizesPerCase':20,'cleanupConfirmed':True,'performanceQualified':False}
