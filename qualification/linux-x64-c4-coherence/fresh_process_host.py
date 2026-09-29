"""Bind fresh CI process authority outside the immutable build receipt."""
import copy,re,hashlib,json

def bind(receipt,observed,receipt_sha256):
 assert observed['platform']=='linux' and observed['arch']=='x64'
 assert re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',observed['bootId'])
 assert type(observed['clockTicksPerSecond']) is int and observed['clockTicksPerSecond']>0
 tool=observed['getconf'];assert tool['path']=='/usr/bin/getconf'
 assert tool['sha256']==receipt['tools']['/usr/bin/getconf']['sha256']
 assert re.fullmatch(r'[a-f0-9]{64}',receipt_sha256)
 fresh={k:copy.deepcopy(observed[k]) for k in ['bootId','clockTicksPerSecond','getconf']}
 return {'processHost':fresh,'archiveReceiptSha256':receipt_sha256,'archivedProcessHost':copy.deepcopy(receipt['processHost']),'scope':'Fresh observed process identity; archived build host is provenance only'}

def require_reviewed_pins(pins):
 assert pins.get('reviewed') is True,'Artifact review required; draft cannot execute'
 for name in ['runtimeArchiveSha256','artifactReceiptSha256','cliSha256','stockSha256']:
  assert isinstance(pins.get(name),str) and re.fullmatch(r'[a-f0-9]{64}',pins[name]),name
 assert pins['scope']=='be8/default0 coherence six original cases'

def require_closed_campaign(pins):
 require_reviewed_pins(pins)
 a=pins['coherenceArtifact']
 assert isinstance(a,dict) and type(a.get('id')) is int and a['id']>0
 assert type(a.get('bytes')) is int and a['bytes']>0
 assert re.fullmatch(r'[a-f0-9]{64}',a['sha256'])
 assert pins['lane']=='coherence-native-stock' and pins['budgets']=={'clients':[2,4,8],'records':500,'resizes':20,'retries':0}
